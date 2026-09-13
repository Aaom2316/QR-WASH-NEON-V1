require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || "ESP32-TEST-1234";
const ADMIN_KEY = process.env.ADMIN_KEY || "DEV-ADMIN-1234";
const SMS_BRIDGE_KEY = process.env.SMS_BRIDGE_KEY || "DEV-SMS-1234";
const ONLINE_WINDOW_SECONDS = Number(process.env.ONLINE_WINDOW_SECONDS || 10);

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is missing in .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5
});

app.use(express.json());
app.use(express.static("public"));

function pulsesFromBaht(amount) {
  // POC rule: 10 baht = 1 pulse.
  return Math.floor(Number(amount) / 10);
}

function requireAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Admin unauthorized" });
  }
  next();
}

function onlineFromLastSeen(lastSeen) {
  if (!lastSeen) return false;
  return (Date.now() - new Date(lastSeen).getTime()) <= ONLINE_WINDOW_SECONDS * 1000;
}

app.get("/api/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() AS time");
    res.json({
      ok: true,
      service: "QR-WASH-NEON-V1",
      database: "CONNECTED",
      time: r.rows[0].time
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      service: "QR-WASH-NEON-V1",
      database: "ERROR",
      error: e.message
    });
  }
});

app.post("/api/test-payment", async (req, res) => {
  const client = await pool.connect();
  try {
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, error: "amount must be > 0" });
    }

    const pulses = pulsesFromBaht(amount);
    if (pulses < 1) {
      return res.status(400).json({
        ok: false,
        error: "ขั้นต่ำ 10 บาทใน POC นี้"
      });
    }

    const transactionKey = `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await client.query("BEGIN");

    const paymentResult = await client.query(
      `INSERT INTO payments
       (transaction_key, amount, source, raw_message, status)
       VALUES ($1, $2, 'test', $3, 'RECEIVED')
       RETURNING *`,
      [transactionKey, amount, `TEST PAYMENT ${amount}`]
    );

    const deviceResult = await client.query(
      `SELECT id, name FROM devices WHERE token = $1 LIMIT 1`,
      [DEVICE_TOKEN]
    );

    if (!deviceResult.rows.length) {
      throw new Error("ESP32 device not found in database");
    }

    const commandResult = await client.query(
      `INSERT INTO commands
       (payment_id, device_id, command_type, pulse_count, status)
       VALUES ($1, $2, 'PULSE', $3, 'QUEUED')
       RETURNING *`,
      [paymentResult.rows[0].id, deviceResult.rows[0].id, pulses]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      payment: paymentResult.rows[0],
      command: commandResult.rows[0]
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

// ============================================================
// SMS BRIDGE — TEST MODE
// Android SMS Bridge -> Server
//
// TEST MODE ONLY:
// - รับ raw SMS จาก Android
// - ยังไม่สร้าง payment
// - ยังไม่สร้าง command
// - ยังไม่สั่ง Pulse
// ============================================================
app.post("/api/sms/test", async (req, res) => {
  if (req.headers["x-sms-key"] !== SMS_BRIDGE_KEY) {
    return res.status(401).json({
      ok: false,
      error: "SMS bridge unauthorized"
    });
  }

  try {
    const {
      transactionKey,
      sender,
      rawMessage,
      receivedAt
    } = req.body || {};

    if (!transactionKey || !rawMessage) {
      return res.status(400).json({
        ok: false,
        error: "transactionKey and rawMessage are required"
      });
    }

    console.log();
    console.log("========================================");
    console.log("SMS RECEIVED — TEST MODE");
    console.log("Transaction Key:", transactionKey);
    console.log("Sender:", sender || "");
    console.log("Received At:", receivedAt || "");
    console.log("Message:", rawMessage);
    console.log("========================================");
    console.log();

    // สำคัญ: TEST MODE ยังไม่แตะ payments / commands
    res.json({
      ok: true,
      mode: "TEST",
      received: true,
      transactionKey,
      message: "SMS received by server"
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

// ============================================================
// SMS BRIDGE — LIVE MODE
// Android KBank SMS -> Server -> Neon -> ESP32 Command
//
// รูปแบบ SMS ที่รองรับใน POC นี้ เช่น:
// 13/09/69 09:39 บช X-1621 เงินเข้า 20.00 คงเหลือ 240.32 บ.
//
// สำคัญ:
// - endpoint นี้จะสร้าง payment จริง
// - สร้าง command PULSE จริง
// - ESP32 จะดึง command ไปทำ Pulse
// - transactionKey ใช้กัน SMS ซ้ำ
// ============================================================
function parseKBankAmount(rawMessage) {
  const text = String(rawMessage || "").replace(/,/g, "");

  const match = text.match(/เงินเข้า\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return amount;
}

app.post("/api/sms/receive", async (req, res) => {
  if (req.headers["x-sms-key"] !== SMS_BRIDGE_KEY) {
    return res.status(401).json({
      ok: false,
      error: "SMS bridge unauthorized"
    });
  }

  const client = await pool.connect();

  try {
    const {
      transactionKey,
      sender,
      rawMessage,
      receivedAt
    } = req.body || {};

    if (!transactionKey || !rawMessage) {
      return res.status(400).json({
        ok: false,
        error: "transactionKey and rawMessage are required"
      });
    }

    const amount = parseKBankAmount(rawMessage);

    if (amount === null) {
      return res.status(400).json({
        ok: false,
        error: "ไม่พบยอดเงินเข้าใน SMS KBank",
        transactionKey
      });
    }

    const pulses = pulsesFromBaht(amount);

    if (pulses < 1) {
      return res.status(400).json({
        ok: false,
        error: "ยอดเงินต่ำกว่า 10 บาท",
        amount,
        transactionKey
      });
    }

    console.log();
    console.log("========================================");
    console.log("SMS RECEIVED — LIVE MODE");
    console.log("Transaction Key:", transactionKey);
    console.log("Sender:", sender || "");
    console.log("Received At:", receivedAt || "");
    console.log("Amount:", amount);
    console.log("Pulse Count:", pulses);
    console.log("Message:", rawMessage);
    console.log("========================================");
    console.log();

    await client.query("BEGIN");

    // ป้องกัน SMS เดิมเข้าซ้ำแล้วสั่ง Pulse ซ้ำ
    const existing = await client.query(
      `SELECT
         p.*,
         c.id AS command_id,
         c.pulse_count,
         c.status AS command_status
       FROM payments p
       LEFT JOIN commands c ON c.payment_id = p.id
       WHERE p.transaction_key = $1
       LIMIT 1`,
      [transactionKey]
    );

    if (existing.rows.length) {
      await client.query("COMMIT");

      return res.json({
        ok: true,
        mode: "LIVE",
        duplicate: true,
        transactionKey,
        payment: existing.rows[0]
      });
    }

    const deviceResult = await client.query(
      `SELECT id, name
       FROM devices
       WHERE token = $1
       LIMIT 1`,
      [DEVICE_TOKEN]
    );

    if (!deviceResult.rows.length) {
      throw new Error("ESP32 device not found in database");
    }

    const paymentResult = await client.query(
      `INSERT INTO payments
       (transaction_key, amount, source, raw_message, status)
       VALUES ($1, $2, 'kbank_sms', $3, 'RECEIVED')
       RETURNING *`,
      [transactionKey, amount, rawMessage]
    );

    const commandResult = await client.query(
      `INSERT INTO commands
       (payment_id, device_id, command_type, pulse_count, status)
       VALUES ($1, $2, 'PULSE', $3, 'QUEUED')
       RETURNING *`,
      [paymentResult.rows[0].id, deviceResult.rows[0].id, pulses]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      mode: "LIVE",
      duplicate: false,
      transactionKey,
      amount,
      pulses,
      payment: paymentResult.rows[0],
      command: commandResult.rows[0],
      device: deviceResult.rows[0]
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(e);
    res.status(500).json({
      ok: false,
      error: e.message
    });
  } finally {
    client.release();
  }
});

app.get("/api/device/commands", async (req, res) => {
  if (req.headers.authorization !== `Bearer ${DEVICE_TOKEN}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const device = await client.query(
      `SELECT id FROM devices WHERE token = $1 LIMIT 1 FOR UPDATE`,
      [DEVICE_TOKEN]
    );

    if (!device.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Device not found" });
    }

    const deviceId = device.rows[0].id;

    await client.query(
      `UPDATE devices
       SET online = TRUE, last_seen = NOW()
       WHERE id = $1`,
      [deviceId]
    );

    const command = await client.query(
      `SELECT *
       FROM commands
       WHERE device_id = $1 AND status = 'QUEUED'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [deviceId]
    );

    if (!command.rows.length) {
      await client.query("COMMIT");
      return res.json({ ok: true, command: null });
    }

    const updated = await client.query(
      `UPDATE commands
       SET status = 'SENT', sent_at = NOW()
       WHERE id = $1 AND status = 'QUEUED'
       RETURNING *`,
      [command.rows[0].id]
    );

    await client.query("COMMIT");
    res.json({ ok: true, command: updated.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

app.post("/api/device/ack", async (req, res) => {
  if (req.headers.authorization !== `Bearer ${DEVICE_TOKEN}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const { commandId, success, message } = req.body;

    if (!commandId) {
      return res.status(400).json({ ok: false, error: "commandId required" });
    }

    const result = await pool.query(
      `UPDATE commands
       SET status = $1,
           completed_at = NOW(),
           device_message = $2
       WHERE id = $3
       RETURNING *`,
      [success ? "DONE" : "FAILED", message || "", commandId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "Command not found" });
    }

    // ถ้า command มาจาก payment ให้ปรับสถานะ payment ตามผล Pulse
    if (result.rows[0].payment_id) {
      await pool.query(
        `UPDATE payments
         SET status = $1
         WHERE id = $2`,
        [success ? "COMPLETED" : "FAILED", result.rows[0].payment_id]
      );
    }

    res.json({ ok: true, command: result.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/admin/dashboard", requireAdmin, async (req, res) => {
  try {
    const [health, stats, devices, machines, recent] = await Promise.all([
      pool.query("SELECT NOW() AS time"),
      pool.query(`
        SELECT
          COALESCE((SELECT SUM(amount) FROM payments WHERE created_at >= CURRENT_DATE), 0) AS today_revenue,
          (SELECT COUNT(*) FROM payments WHERE created_at >= CURRENT_DATE) AS today_transactions,
          COALESCE((
            SELECT SUM(c.pulse_count)
            FROM commands c
            JOIN payments p ON p.id = c.payment_id
            WHERE p.created_at >= CURRENT_DATE
          ), 0) AS today_pulses
      `),
      pool.query(`
        SELECT d.id, d.name, d.token, d.online, d.last_seen, d.machine_id, m.name AS machine_name
        FROM devices d
        LEFT JOIN machines m ON m.id = d.machine_id
        ORDER BY d.id
      `),
      pool.query(`SELECT id, name, enabled, pulse_per_10_baht FROM machines ORDER BY id`),
      pool.query(`
        SELECT
          c.id AS command_id,
          c.created_at,
          c.command_type,
          c.pulse_count,
          c.status AS command_status,
          c.sent_at,
          c.completed_at,
          c.device_message,
          c.device_id,
          d.name AS device_name,
          p.id AS payment_id,
          p.source,
          p.amount,
          p.transaction_key,
          p.status AS payment_status
        FROM commands c
        LEFT JOIN payments p ON p.id = c.payment_id
        LEFT JOIN devices d ON d.id = c.device_id
        ORDER BY c.created_at DESC
        LIMIT 50
      `)
    ]);

    const deviceRows = devices.rows.map(d => ({
      ...d,
      online: onlineFromLastSeen(d.last_seen)
    }));

    res.json({
      ok: true,
      server: { online: true, time: health.rows[0].time },
      stats: stats.rows[0],
      devices: deviceRows,
      machines: machines.rows,
      recent: recent.rows
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/admin/devices", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.id, d.name, d.online, d.last_seen, d.machine_id, m.name AS machine_name
      FROM devices d
      LEFT JOIN machines m ON m.id = d.machine_id
      ORDER BY d.id
    `);
    res.json({
      ok: true,
      devices: result.rows.map(d => ({ ...d, online: onlineFromLastSeen(d.last_seen) }))
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/command", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const deviceId = Number(req.body.deviceId);
    const pulseCount = Number(req.body.pulseCount);

    if (!Number.isInteger(deviceId) || deviceId <= 0) {
      return res.status(400).json({ ok: false, error: "deviceId ไม่ถูกต้อง" });
    }
    if (!Number.isInteger(pulseCount) || pulseCount < 1 || pulseCount > 1000) {
      return res.status(400).json({ ok: false, error: "pulseCount ต้องเป็น 1-1000" });
    }

    const device = await client.query(
      `SELECT id, name FROM devices WHERE id = $1 LIMIT 1`,
      [deviceId]
    );
    if (!device.rows.length) {
      return res.status(404).json({ ok: false, error: "ไม่พบ ESP32 device" });
    }

    await client.query("BEGIN");
    const command = await client.query(
      `INSERT INTO commands
       (payment_id, device_id, command_type, pulse_count, status, device_message)
       VALUES (NULL, $1, 'MANUAL', $2, 'QUEUED', $3)
       RETURNING *`,
      [deviceId, pulseCount, req.body.note || "Admin manual command"]
    );
    await client.query("COMMIT");

    res.json({ ok: true, command: command.rows[0], device: device.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

app.get("/api/transactions", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         c.id AS command_id,
         c.created_at,
         c.command_type,
         c.pulse_count,
         c.status AS command_status,
         c.sent_at,
         c.completed_at,
         c.device_message,
         c.device_id,
         d.name AS device_name,
         p.id AS payment_id,
         p.source,
         p.amount,
         p.transaction_key,
         p.status AS payment_status
       FROM commands c
       LEFT JOIN payments p ON p.id = c.payment_id
       LEFT JOIN devices d ON d.id = c.device_id
       ORDER BY c.created_at DESC
       LIMIT 50`
    );

    res.json({ ok: true, transactions: result.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ============================================================
// PROMPTPAY QR CONFIG
// Customer QR page reads this configuration.
// Fill PROMPTPAY_ID in .env before using the real QR.
// ============================================================
const PROMPTPAY_ID = String(process.env.PROMPTPAY_ID || "").trim();
const PROMPTPAY_NAME = String(process.env.PROMPTPAY_NAME || "QR-WASH").trim().slice(0, 25);
const PROMPTPAY_CITY = String(process.env.PROMPTPAY_CITY || "THAILAND").trim().slice(0, 15);

app.get("/api/qr/config", (req, res) => {
  res.json({
    ok: true,
    enabled: !!PROMPTPAY_ID,
    promptpayId: PROMPTPAY_ID,
    name: PROMPTPAY_NAME,
    city: PROMPTPAY_CITY
  });
});

app.listen(PORT, () => {
  console.log(`QR-WASH NEON V1 running at http://localhost:${PORT}`);
});
