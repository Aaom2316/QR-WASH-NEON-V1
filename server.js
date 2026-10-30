require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const SMS_BRIDGE_KEY = process.env.SMS_BRIDGE_KEY || "";
const ONLINE_WINDOW_SECONDS = Number(process.env.ONLINE_WINDOW_SECONDS || 30);

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is missing in .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5
});

/* สร้างตารางประวัติ PLC เมื่อมีการเรียกใช้งานครั้งแรก */
let plcCashHistoryTablePromise = null;
async function ensurePlcCashHistoryTable() {
  if (!plcCashHistoryTablePromise) {
    plcCashHistoryTablePromise = pool.query(`
      CREATE TABLE IF NOT EXISTS plc_cash_history (
        id BIGSERIAL PRIMARY KEY,
        device_id TEXT NOT NULL,
        machine_id TEXT,
        d100 BIGINT NOT NULL DEFAULT 0,
        d101 BIGINT NOT NULL DEFAULT 0,
        d102 BIGINT NOT NULL DEFAULT 0,
        d103 BIGINT NOT NULL DEFAULT 0,
        added_d100 BIGINT NOT NULL DEFAULT 0,
        added_d101 BIGINT NOT NULL DEFAULT 0,
        added_d102 BIGINT NOT NULL DEFAULT 0,
        added_d103 BIGINT NOT NULL DEFAULT 0,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE plc_cash_history ADD COLUMN IF NOT EXISTS added_d100 BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE plc_cash_history ADD COLUMN IF NOT EXISTS added_d101 BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE plc_cash_history ADD COLUMN IF NOT EXISTS added_d102 BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE plc_cash_history ADD COLUMN IF NOT EXISTS added_d103 BIGINT NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_plc_cash_history_recorded_at
        ON plc_cash_history (recorded_at);
      CREATE INDEX IF NOT EXISTS idx_plc_cash_history_machine_time
        ON plc_cash_history (machine_id, recorded_at);

      CREATE TABLE IF NOT EXISTS plc_cash_counter_state (
        device_id TEXT PRIMARY KEY,
        machine_id TEXT,
        d100 BIGINT NOT NULL DEFAULT 0,
        d101 BIGINT NOT NULL DEFAULT 0,
        d102 BIGINT NOT NULL DEFAULT 0,
        d103 BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `).catch(error => {
      plcCashHistoryTablePromise = null;
      throw error;
    });
  }
  return plcCashHistoryTablePromise;
}

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

// ============================================================
// MULTI DEVICE — รองรับ ESP32 ได้สูงสุด 4 เครื่อง
// Token ของแต่ละเครื่องเก็บอยู่ใน devices.token
// เครื่อง 1 ยังใช้ DEVICE_TOKEN ใน .env ได้เหมือนเดิม
// ============================================================

function getBearerToken(req) {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) return "";
  return auth.slice(7).trim();
}

async function getDeviceByToken(token) {
  if (!token) return null;

  const result = await pool.query(
    `SELECT id, name, token, machine_id
     FROM devices
     WHERE token = $1
     LIMIT 1`,
    [token]
  );

  return result.rows[0] || null;
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

    const transactionKey =
      `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await client.query("BEGIN");

    const paymentResult = await client.query(
      `INSERT INTO payments
       (transaction_key, amount, source, raw_message, status)
       VALUES ($1, $2, 'test', $3, 'RECEIVED')
       RETURNING *`,
      [
        transactionKey,
        amount,
        `TEST PAYMENT ${amount}`
      ]
    );

    // TEST PAYMENT:
    // ส่ง deviceId มาได้เพื่อเลือกเครื่อง 1-4
    // ถ้าไม่ส่ง จะใช้เครื่อง 1 ตามระบบเดิม
    const requestedDeviceId = Number(req.body.deviceId);

    const deviceResult =
      Number.isInteger(requestedDeviceId) && requestedDeviceId > 0
        ? await client.query(
            `SELECT id, name
             FROM devices
             WHERE id = $1
             LIMIT 1`,
            [requestedDeviceId]
          )
        : await client.query(
            `SELECT id, name
             FROM devices
             WHERE token = $1
             LIMIT 1`,
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
      [
        paymentResult.rows[0].id,
        deviceResult.rows[0].id,
        pulses
      ]
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

    res.status(500).json({
      ok: false,
      error: e.message
    });

  } finally {
    client.release();
  }
});


// ============================================================
// QR PAYMENT SESSION
// เครื่องต้องสร้างรายการรอรับเงินก่อนทุกครั้ง
// SMS เงินเข้าอย่างเดียวจะไม่สามารถสร้าง Pulse ได้
// ============================================================

const QR_ALLOWED_AMOUNTS = [10, 20, 50, 100];

const QR_SESSION_TIMEOUT_SECONDS =
  Number(process.env.QR_SESSION_TIMEOUT_SECONDS || 120);

app.post("/api/qr/session", async (req, res) => {

  const deviceToken = getBearerToken(req);
  const device = await getDeviceByToken(deviceToken);

  if (!device) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  const client = await pool.connect();

  try {

    const amount = Number(req.body.amount);

    if (!QR_ALLOWED_AMOUNTS.includes(amount)) {
      return res.status(400).json({
        ok: false,
        error: "QR amount ต้องเป็น 10, 20, 50 หรือ 100 บาท"
      });
    }

    // เพิ่มเศษสตางค์ตาม device.id เพื่อให้แต่ละเครื่องมี QR amount ไม่ซ้ำกัน
    // ตัวอย่าง device.id 1-4: 10.01, 10.02, 10.03, 10.04
    // amount ที่รับจาก ESP32 ยังคงเป็นราคาพื้นฐาน 10/20/50/100 บาท
    const qrAmount = Number((amount + (Number(device.id) / 100)).toFixed(2));

    await client.query("BEGIN");

    // ปิด QR session เก่าของเครื่องนี้ที่ยังค้างอยู่
    await client.query(
      `UPDATE payments p
       SET status = 'EXPIRED'
       FROM commands c
       WHERE p.id = c.payment_id
         AND c.device_id = $1
         AND p.source = 'qr_session'
         AND p.status = 'WAITING'
         AND p.created_at < NOW() - INTERVAL '${QR_SESSION_TIMEOUT_SECONDS} seconds'`,
      [device.id]
    );

    // ให้มี QR session รอได้ครั้งเดียวต่อเครื่อง
    await client.query(
      `UPDATE payments p
       SET status = 'CANCELLED'
       FROM commands c
       WHERE p.id = c.payment_id
         AND c.device_id = $1
         AND p.source = 'qr_session'
         AND p.status = 'WAITING'`,
      [device.id]
    );

    const transactionKey =
      `QR-${device.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const paymentResult = await client.query(
      `INSERT INTO payments
       (transaction_key, amount, source, raw_message, status)
       VALUES ($1, $2, 'qr_session', $3, 'WAITING')
       RETURNING *`,
      [
        transactionKey,
        qrAmount,
        `QR SESSION WAITING ${qrAmount.toFixed(2)} BAHT DEVICE ${device.id}`
      ]
    );

    // ใช้ commands เป็นตัวผูก session กับเครื่อง โดยยังไม่สร้าง Pulse
    // pulse_count ต้องมากกว่า 0 ตาม constraint ของฐานข้อมูล
    // แต่ status = WAITING จึงยังไม่ถูก ESP32 นำไป Pulse
    const commandResult = await client.query(
      `INSERT INTO commands
       (payment_id, device_id, command_type, pulse_count, status, device_message)
       VALUES ($1, $2, 'QR_WAIT', $3, 'WAITING', $4)
       RETURNING *`,
      [
        paymentResult.rows[0].id,
        device.id,
        pulsesFromBaht(amount),
        `Waiting QR payment ${qrAmount.toFixed(2)} baht; base ${amount} baht; device ${device.id}`
      ]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,

      session: {
        transactionKey,
        amount: qrAmount,
        baseAmount: amount,
        pulses: pulsesFromBaht(amount),
        deviceId: device.id,
        deviceName: device.name,
        machineId: device.machine_id,
        expiresInSeconds: QR_SESSION_TIMEOUT_SECONDS
      },

      payment: paymentResult.rows[0],

      sessionRecord: commandResult.rows[0]
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


app.post("/api/qr/session/cancel", async (req, res) => {

  const deviceToken = getBearerToken(req);
  const device = await getDeviceByToken(deviceToken);

  if (!device) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  try {

    const result = await pool.query(
      `UPDATE payments p
       SET status = 'CANCELLED'
       FROM commands c
       WHERE p.id = c.payment_id
         AND c.device_id = $1
         AND p.source = 'qr_session'
         AND p.status = 'WAITING'
       RETURNING p.id, p.transaction_key, p.amount, p.status`,
      [device.id]
    );

    res.json({
      ok: true,
      cancelled: result.rows
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
// วิธีใหม่:
// - ถ้า Android ส่ง amount มา จะใช้ amount โดยตรง
// - rawMessage ยังเก็บไว้เป็นหลักฐาน
// - ถ้าไม่มี amount จะ fallback ไปอ่าน rawMessage
// - ต้องมี QR SESSION ของเครื่องนี้ + ยอดตรงกัน
//   จึงจะสร้าง PULSE
// ============================================================

function parseKBankAmount(rawMessage) {
  const text = String(rawMessage || "")
    .replace(/,/g, "")
    .replace(/\u00A0/g, " ")
    .trim();

  // รองรับ:
  // เงินเข้า 20.00
  // เงินเข้า20.00
  // เงิน เข้า 20.00
  // รับโอนจาก X-9704 20.00
  // รับโอนจาก X-6418 10.00

  const patterns = [
    /เงิน\s*เข้า\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
    /รับโอนจาก\s+.*?\s+([0-9]+\.[0-9]{2})(?=\s|$)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;

    const amount = Number(match[1]);

    if (Number.isFinite(amount) && amount > 0) {
      return amount;
    }
  }

  return null;
}

app.post("/api/sms/receive", async (req, res) => {

  // ----------------------------------------------------------
  // ตรวจสอบ SMS Bridge Key
  // ----------------------------------------------------------

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
      receivedAt,
      amount: bodyAmount,
      deviceId: bodyDeviceId
    } = req.body || {};

    // --------------------------------------------------------
    // ตรวจข้อมูลขั้นต่ำ
    // --------------------------------------------------------

    if (!transactionKey || !rawMessage) {
      return res.status(400).json({
        ok: false,
        error: "transactionKey and rawMessage are required"
      });
    }

    // --------------------------------------------------------
    // วิธีใหม่
    //
    // ถ้า Android ส่ง amount มา:
    //     amount = 20
    //
    // Server จะใช้ amount นี้โดยตรง
    //
    // ถ้าไม่มี amount:
    //     ค่อย fallback ไปอ่านจาก rawMessage
    // --------------------------------------------------------

    let amount = Number(bodyAmount);

    const hasBodyAmount =
      Number.isFinite(amount) && amount > 0;

    if (!hasBodyAmount) {
      amount = parseKBankAmount(rawMessage);
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        ok: false,
        error: "ไม่พบยอดเงินเข้าใน SMS KBank",
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
    console.log(
      "Amount Source:",
      hasBodyAmount ? "BODY" : "SMS"
    );
    console.log("Message:", rawMessage);
    console.log("========================================");
    console.log();

    // SMS Bridge รุ่นปัจจุบันไม่ได้ส่ง deviceId มา
    // ถ้ามี deviceId ที่ถูกต้อง ให้จำกัดค้นหาเฉพาะเครื่องนั้น
    // ถ้าไม่มี ให้ค้นหา QR session ทุกเครื่อง แล้วรับเฉพาะกรณีพบเพียงรายการเดียว
    const hasDeviceId = bodyDeviceId !== undefined && bodyDeviceId !== null && bodyDeviceId !== "";
    const smsDeviceId = Number(bodyDeviceId);

    if (hasDeviceId && (!Number.isInteger(smsDeviceId) || smsDeviceId < 1)) {
      return res.status(400).json({
        ok: false,
        error: "deviceId ไม่ถูกต้อง"
      });
    }

    const resolvedSmsDeviceId = hasDeviceId ? smsDeviceId : null;
    console.log("[SMS DEBUG] bodyDeviceId:", hasDeviceId ? smsDeviceId : "NOT_SENT");
    console.log("[SMS DEBUG] matchingMode:", hasDeviceId ? "DEVICE_SPECIFIC" : "UNIQUE_SESSION_ACROSS_DEVICES");

    await client.query("BEGIN");

    // --------------------------------------------------------
    // ป้องกัน SMS เดิมเข้าซ้ำ
    // --------------------------------------------------------

    const existingSms = await client.query(
      `SELECT p.*
       FROM payments p
       WHERE p.transaction_key = $1
       LIMIT 1`,
      [transactionKey]
    );

    if (existingSms.rows.length) {

      await client.query("COMMIT");

      return res.json({
        ok: true,
        mode: "LIVE",
        duplicate: true,
        transactionKey,
        payment: existingSms.rows[0],
        message: "SMS นี้ถูกประมวลผลแล้ว"
      });
    }

    // --------------------------------------------------------
    // สำคัญที่สุด
    //
    // เงินเข้า KBank จะถูกยอมรับก็ต่อเมื่อ:
    //
    // 1. มี QR SESSION
    // 2. เป็นของ DEVICE นี้
    // 3. session ยัง WAITING
    // 4. QR_WAIT ยัง WAITING
    // 5. ยอดเงินตรงกัน
    // 6. session ยังไม่หมดอายุ
    //
    // ไม่ผ่าน = ไม่สร้าง PULSE
    // --------------------------------------------------------

    const waiting = await client.query(
      `SELECT
         p.id AS payment_id,
         p.transaction_key AS qr_transaction_key,
         p.amount,
         p.created_at,
         c.id AS session_command_id,
         c.device_id,
         d.name AS device_name
       FROM payments p
       JOIN commands c
         ON c.payment_id = p.id
       JOIN devices d
         ON d.id = c.device_id
       WHERE p.source = 'qr_session'
         AND p.status = 'WAITING'
         AND c.command_type = 'QR_WAIT'
         AND c.status = 'WAITING'
         AND ($1::int IS NULL OR c.device_id = $1)
         AND p.amount = $2
         AND p.created_at >= NOW() -
             INTERVAL '${QR_SESSION_TIMEOUT_SECONDS} seconds'
       ORDER BY p.created_at DESC
       FOR UPDATE OF p`,
      [
        resolvedSmsDeviceId,
        amount
      ]
    );

    // --------------------------------------------------------
    // ไม่มี QR SESSION ที่ตรงกัน
    // --------------------------------------------------------

    if (!waiting.rows.length) {

      await client.query("COMMIT");

      console.log("IGNORED SMS — NO MATCHING QR SESSION");
      console.log("Amount:", amount);
      console.log("Device filter:", resolvedSmsDeviceId ?? "ALL DEVICES");
      console.log("Transaction Key:", transactionKey);

      return res.json({
        ok: true,
        mode: "LIVE",
        accepted: false,
        pulsed: false,
        ignored: true,
        transactionKey,
        amount,
        deviceId: resolvedSmsDeviceId,
        message: "ไม่พบ QR session ที่ตรงยอดและยังไม่หมดอายุ จึงไม่ Pulse"
      });
    }

    // หาก SMS ไม่มี deviceId และมียอดเดียวกันรออยู่หลายเครื่อง ห้ามเดาเครื่อง
    if (!resolvedSmsDeviceId && waiting.rows.length > 1) {
      await client.query("COMMIT");
      console.log("IGNORED SMS — AMBIGUOUS QR SESSIONS");
      console.log("Amount:", amount, "Matching sessions:", waiting.rows.length);
      console.log("Device IDs:", waiting.rows.map(row => row.device_id));
      return res.json({
        ok: true,
        mode: "LIVE",
        accepted: false,
        pulsed: false,
        ignored: true,
        ambiguous: true,
        transactionKey,
        amount,
        matchingDeviceIds: waiting.rows.map(row => row.device_id),
        message: "มี QR หลายเครื่องรอยอดเท่ากัน แต่ SMS ไม่มี deviceId จึงไม่ Pulse เพื่อป้องกันสั่งผิดเครื่อง"
      });
    }

    const session = waiting.rows[0];

    // --------------------------------------------------------
    // คำนวณ Pulse
    // 10 บาท = 1 Pulse
    // --------------------------------------------------------

    const pulses = pulsesFromBaht(
      session.amount
    );

    if (pulses < 1) {

      await client.query("COMMIT");

      return res.json({
        ok: true,
        mode: "LIVE",
        accepted: false,
        pulsed: false,
        ignored: true,
        transactionKey,
        amount,
        message: "QR session ต่ำกว่า 10 บาท"
      });
    }

    // --------------------------------------------------------
    // เปลี่ยน QR SESSION เดิมให้เป็น payment จริง
    // --------------------------------------------------------

    const paymentResult = await client.query(
      `UPDATE payments
       SET source = 'kbank_sms',
           raw_message = $1,
           status = 'RECEIVED',
           transaction_key = $2
       WHERE id = $3
       RETURNING *`,
      [
        rawMessage,
        transactionKey,
        session.payment_id
      ]
    );

    // --------------------------------------------------------
    // QR_WAIT เดิมเป็น session marker
    // --------------------------------------------------------

    await client.query(
      `UPDATE commands
       SET status = 'MATCHED',
           device_message = $1
       WHERE id = $2`,
      [
        `QR matched KBank SMS ${amount} baht`,
        session.session_command_id
      ]
    );

    // --------------------------------------------------------
    // จากจุดนี้เท่านั้นจึงสร้าง PULSE
    // --------------------------------------------------------

    const commandResult = await client.query(
      `INSERT INTO commands
       (
         payment_id,
         device_id,
         command_type,
         pulse_count,
         status,
         device_message
       )
       VALUES
       (
         $1,
         $2,
         'PULSE',
         $3,
         'QUEUED',
         $4
       )
       RETURNING *`,
      [
        session.payment_id,
        session.device_id,
        pulses,
        `KBank QR matched ${amount} baht`
      ]
    );

    await client.query("COMMIT");

    // --------------------------------------------------------
    // สำเร็จ
    // --------------------------------------------------------

    res.json({
      ok: true,
      mode: "LIVE",
      duplicate: false,
      accepted: true,
      pulsed: false,
      transactionKey,
      amount,
      pulses,
      payment: paymentResult.rows[0],
      command: commandResult.rows[0],
      device: {
        id: session.device_id,
        name: session.device_name
      }
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


// ============================================================
// ESP32 PLC CASH TOTALS — D100-D103 -> Neon plc_cash_totals
// รับยอดจาก ESP32 โดยใช้ Bearer Token ของอุปกรณ์เดิม
// ไม่แตะระบบ QR / PULSE
// ============================================================
app.post("/api/device/plc-cash-totals", async (req, res) => {
  const deviceToken = getBearerToken(req);
  const device = await getDeviceByToken(deviceToken);

  if (!device) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  const values = [req.body?.d100, req.body?.d101, req.body?.d102, req.body?.d103]
    .map(value => Number(value));

  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) {
    return res.status(400).json({
      ok: false,
      error: "d100, d101, d102, d103 ต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป"
    });
  }

  const [d100, d101, d102, d103] = values;
  const deviceId = String(device.id);
  const machineId = String(device.machine_id ?? device.id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensurePlcCashHistoryTable();

    // Update current totals for the dashboard, independently from history baselines.
    const totalsResult = await client.query(
      `UPDATE plc_cash_totals
       SET machine_id = $2, d100 = $3, d101 = $4, d102 = $5, d103 = $6, updated_at = NOW()
       WHERE device_id = $1
       RETURNING device_id, machine_id, d100, d101, d102, d103, updated_at`,
      [deviceId, machineId, d100, d101, d102, d103]
    );
    let row = totalsResult.rows[0];
    if (!row) {
      const inserted = await client.query(
        `INSERT INTO plc_cash_totals
           (device_id, machine_id, d100, d101, d102, d103, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING device_id, machine_id, d100, d101, d102, d103, updated_at`,
        [deviceId, machineId, d100, d101, d102, d103]
      );
      row = inserted.rows[0];
    }

    // Persistent history baseline. First reading only establishes baseline.
    const stateResult = await client.query(
      `SELECT device_id, d100, d101, d102, d103
       FROM plc_cash_counter_state
       WHERE device_id = $1
       FOR UPDATE`,
      [deviceId]
    );
    const state = stateResult.rows[0] || null;
    const current = [d100, d101, d102, d103];
    let baseline = state
      ? [state.d100, state.d101, state.d102, state.d103].map(Number)
      : [...current];
    const added = [0, 0, 0, 0];
    let shouldRecord = false;

    if (!state) {
      await client.query(
        `INSERT INTO plc_cash_counter_state
           (device_id, machine_id, d100, d101, d102, d103, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [deviceId, machineId, ...current]
      );
    } else {
      // Only recognize a full reset when all four PLC registers are zero together.
      // A temporary zero/drop in one register must not reset the history baseline.
      if (current.every(value => value === 0) && baseline.some(value => value > 0)) {
        baseline = [...current];
      } else {
        // If an individual channel falls while D100 does not, treat it as a
        // temporary bad reading. Keep that channel's previous baseline.
        for (let i = 1; i <= 3; i++) {
          if (current[i] >= baseline[i]) {
            added[i] = current[i] - baseline[i];
            baseline[i] = current[i];
          }
        }
        baseline[0] = d100;
        shouldRecord = added[1] > 0 || added[2] > 0 || added[3] > 0;
      }

      await client.query(
        `UPDATE plc_cash_counter_state
         SET machine_id = $2, d100 = $3, d101 = $4, d102 = $5, d103 = $6, updated_at = NOW()
         WHERE device_id = $1`,
        [deviceId, machineId, ...baseline]
      );
    }

    // History contains only actual increases in D101-D103; D100 is not income.
    if (shouldRecord) {
      await client.query(
        `INSERT INTO plc_cash_history
           (device_id, machine_id, d100, d101, d102, d103,
            added_d100, added_d101, added_d102, added_d103, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, NOW())`,
        [deviceId, machineId, d100, d101, d102, d103,
         added[1], added[2], added[3]]
      );
    }

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "PLC cash totals saved",
      data: row
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("PLC cash totals error:", e);
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  } finally {
    client.release();
  }
});


// ============================================================
// ESP32 COMMAND
// ============================================================

app.get("/api/device/commands", async (req, res) => {

  const deviceToken = getBearerToken(req);

  if (!deviceToken) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    const device = await client.query(
      `SELECT id
       FROM devices
       WHERE token = $1
       LIMIT 1
       FOR UPDATE`,
      [deviceToken]
    );

    if (!device.rows.length) {

      await client.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        error: "Device not found"
      });
    }

    const deviceId = device.rows[0].id;

    await client.query(
      `UPDATE devices
       SET online = TRUE,
           last_seen = NOW()
       WHERE id = $1`,
      [deviceId]
    );

    const command = await client.query(
      `SELECT *
       FROM commands
       WHERE device_id = $1
         AND status = 'QUEUED'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [deviceId]
    );

    if (!command.rows.length) {

      await client.query("COMMIT");

      return res.json({
        ok: true,
        command: null
      });
    }

    const updated = await client.query(
      `UPDATE commands
       SET status = 'SENT',
           sent_at = NOW()
       WHERE id = $1
         AND status = 'QUEUED'
       RETURNING *`,
      [command.rows[0].id]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      command: updated.rows[0]
    });

  } catch (e) {

    await client.query("ROLLBACK").catch(() => {});

    res.status(500).json({
      ok: false,
      error: e.message
    });

  } finally {

    client.release();

  }
});


app.post("/api/device/ack", async (req, res) => {

  const deviceToken = getBearerToken(req);
  const device = await getDeviceByToken(deviceToken);

  if (!device) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  try {

    const {
      commandId,
      success,
      message
    } = req.body;

    if (!commandId) {
      return res.status(400).json({
        ok: false,
        error: "commandId required"
      });
    }

    const result = await pool.query(
      `UPDATE commands
       SET status = $1,
           completed_at = NOW(),
           device_message = $2
       WHERE id = $3
         AND device_id = $4
       RETURNING *`,
      [
        success ? "DONE" : "FAILED",
        message || "",
        commandId,
        device.id
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Command not found"
      });
    }

    // ถ้า command มาจาก payment
    // ให้ปรับสถานะ payment ตามผล Pulse

    if (result.rows[0].payment_id) {

      await pool.query(
        `UPDATE payments
         SET status = $1
         WHERE id = $2`,
        [
          success ? "COMPLETED" : "FAILED",
          result.rows[0].payment_id
        ]
      );
    }

    res.json({
      ok: true,
      command: result.rows[0]
    });

  } catch (e) {

    res.status(500).json({
      ok: false,
      error: e.message
    });

  }
});


app.get("/api/admin/dashboard", requireAdmin, async (req, res) => {

  try {

    // Ensure PLC income history exists before calculating today's revenue.
    await ensurePlcCashHistoryTable();

    const [
      health,
      stats,
      devices,
      machines,
      recent
    ] = await Promise.all([

      pool.query(
        "SELECT NOW() AS time"
      ),

      pool.query(`
        SELECT
          COALESCE(
            (
              SELECT SUM(
                h.added_d101 + h.added_d102 + h.added_d103
              )
              FROM plc_cash_history h
              WHERE h.recorded_at >= (
                (NOW() AT TIME ZONE 'Asia/Bangkok')::date::timestamp
                AT TIME ZONE 'Asia/Bangkok'
              )
                AND h.recorded_at < (
                  ((NOW() AT TIME ZONE 'Asia/Bangkok')::date + 1)::timestamp
                  AT TIME ZONE 'Asia/Bangkok'
                )
            ),
            0
          ) AS today_revenue,

          (
            SELECT COUNT(*)
            FROM payments p
            JOIN commands c
              ON c.payment_id = p.id
            WHERE p.created_at >= (
                (NOW() AT TIME ZONE 'Asia/Bangkok')::date::timestamp
                AT TIME ZONE 'Asia/Bangkok'
              )
              AND p.created_at < (
                ((NOW() AT TIME ZONE 'Asia/Bangkok')::date + 1)::timestamp
                AT TIME ZONE 'Asia/Bangkok'
              )
              AND p.source = 'kbank_sms'
              AND c.command_type = 'PULSE'
          ) AS today_transactions,

          COALESCE(
            (
              SELECT SUM(c.pulse_count)
              FROM commands c
              JOIN payments p
                ON p.id = c.payment_id
              WHERE p.created_at >= (
                (NOW() AT TIME ZONE 'Asia/Bangkok')::date::timestamp
                AT TIME ZONE 'Asia/Bangkok'
              )
                AND p.created_at < (
                  ((NOW() AT TIME ZONE 'Asia/Bangkok')::date + 1)::timestamp
                  AT TIME ZONE 'Asia/Bangkok'
                )
                AND p.source = 'kbank_sms'
                AND c.command_type = 'PULSE'
            ),
            0
          ) AS today_pulses
      `),

      pool.query(`
        SELECT
          d.id,
          d.name,
          d.token,
          d.online,
          d.last_seen,
          d.machine_id,
          m.name AS machine_name
        FROM devices d
        LEFT JOIN machines m
          ON m.id = d.machine_id
        ORDER BY d.id
      `),

      pool.query(`
        SELECT
          id,
          name,
          enabled,
          pulse_per_10_baht
        FROM machines
        ORDER BY id
      `),

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
        LEFT JOIN payments p
          ON p.id = c.payment_id
        JOIN devices d
          ON d.id = c.device_id
        WHERE
          c.command_type = 'MANUAL'
          OR (
            c.command_type = 'PULSE'
            AND p.source IN ('kbank_sms', 'test')
          )
        ORDER BY c.created_at DESC
        LIMIT 50
      `)

    ]);

    const deviceRows =
      devices.rows.map(d => ({
        ...d,
        online: onlineFromLastSeen(d.last_seen)
      }));

    res.json({
      ok: true,

      server: {
        online: true,
        time: health.rows[0].time
      },

      stats: stats.rows[0],

      devices: deviceRows,

      machines: machines.rows,

      recent: recent.rows
    });

  } catch (e) {

    console.error(e);

    res.status(500).json({
      ok: false,
      error: e.message
    });

  }
});


app.get("/api/admin/devices", requireAdmin, async (req, res) => {

  try {

    const result = await pool.query(`
      SELECT
        d.id,
        d.name,
        d.online,
        d.last_seen,
        d.machine_id,
        m.name AS machine_name
      FROM devices d
      LEFT JOIN machines m
        ON m.id = d.machine_id
      ORDER BY d.id
    `);

    res.json({
      ok: true,

      devices: result.rows.map(d => ({
        ...d,
        online: onlineFromLastSeen(d.last_seen)
      }))
    });

  } catch (e) {

    res.status(500).json({
      ok: false,
      error: e.message
    });

  }
});


// ============================================================
// ADMIN PLC CASH TOTALS — อ่านยอดเงินจากตาราง Neon
// ใช้ x-admin-key เดียวกับหน้า Admin เดิม
// ============================================================
app.get("/api/admin/plc-cash-totals", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT device_id, machine_id, d100, d101, d102, d103, updated_at
      FROM plc_cash_totals
      ORDER BY machine_id::integer NULLS LAST, device_id
    `);

    return res.json({
      ok: true,
      rows: result.rows
    });
  } catch (e) {
    console.error("Admin PLC cash totals error:", e);
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});


// ============================================================
// ADMIN PLC CASH HISTORY — ค้นหาประวัติ PLC รายวัน/เดือน/ปี
// ใช้ snapshot ล่าสุดในแต่ละช่วง ไม่รวมค่าที่ส่งซ้ำทุก 5 วินาที
// ============================================================
app.get("/api/admin/plc-cash-history", requireAdmin, async (req, res) => {
  try {
    await ensurePlcCashHistoryTable();

    const period = String(req.query.period || "day");
    let startDate = "";
    let endDate = "";

    if (period === "day") {
      const value = String(req.query.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return res.status(400).json({ ok: false, error: "กรุณาเลือกวันที่ให้ถูกต้อง (YYYY-MM-DD)" });
      }
      const d = new Date(value + "T00:00:00Z");
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
        return res.status(400).json({ ok: false, error: "วันที่ไม่ถูกต้อง" });
      }
      startDate = value;
      d.setUTCDate(d.getUTCDate() + 1);
      endDate = d.toISOString().slice(0, 10);
    } else if (period === "month") {
      const value = String(req.query.month || "");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
        return res.status(400).json({ ok: false, error: "กรุณาเลือกเดือนให้ถูกต้อง (YYYY-MM)" });
      }
      const [year, month] = value.split("-").map(Number);
      startDate = `${value}-01`;
      endDate = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
    } else if (period === "year") {
      const value = String(req.query.year || "");
      if (!/^\d{4}$/.test(value) || Number(value) < 2000 || Number(value) > 2100) {
        return res.status(400).json({ ok: false, error: "กรุณาเลือกปี ค.ศ. ให้ถูกต้อง" });
      }
      startDate = `${value}-01-01`;
      endDate = `${Number(value) + 1}-01-01`;
    } else {
      return res.status(400).json({ ok: false, error: "period ต้องเป็น day, month หรือ year" });
    }

    const result = await pool.query(
      `SELECT device_id, machine_id, d100, d101, d102, d103,
              added_d100, added_d101, added_d102, added_d103,
              recorded_at AS updated_at,
              to_char(recorded_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS') AS period_label
       FROM plc_cash_history
       WHERE recorded_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Bangkok')
         AND recorded_at < ($2::date::timestamp AT TIME ZONE 'Asia/Bangkok')
         AND (added_d101 > 0 OR added_d102 > 0 OR added_d103 > 0)
       ORDER BY recorded_at DESC, id DESC
       LIMIT 1000`,
      [startDate, endDate]
    );

    return res.json({ ok: true, period, startDate, endDate, rows: result.rows });
  } catch (e) {
    console.error("Admin PLC cash history error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});


app.post("/api/admin/command", requireAdmin, async (req, res) => {

  const client = await pool.connect();

  try {

    const deviceId = Number(req.body.deviceId);
    const pulseCount = Number(req.body.pulseCount);

    if (!Number.isInteger(deviceId) || deviceId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "deviceId ไม่ถูกต้อง"
      });
    }

    if (
      !Number.isInteger(pulseCount) ||
      pulseCount < 1 ||
      pulseCount > 1000
    ) {
      return res.status(400).json({
        ok: false,
        error: "pulseCount ต้องเป็น 1-1000"
      });
    }

    const device = await client.query(
      `SELECT id, name
       FROM devices
       WHERE id = $1
       LIMIT 1`,
      [deviceId]
    );

    if (!device.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "ไม่พบ ESP32 device"
      });
    }

    await client.query("BEGIN");

    const command = await client.query(
      `INSERT INTO commands
       (
         payment_id,
         device_id,
         command_type,
         pulse_count,
         status,
         device_message
       )
       VALUES
       (
         NULL,
         $1,
         'MANUAL',
         $2,
         'QUEUED',
         $3
       )
       RETURNING *`,
      [
        deviceId,
        pulseCount,
        req.body.note || "Admin manual command"
      ]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      command: command.rows[0],
      device: device.rows[0]
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
       LEFT JOIN payments p
         ON p.id = c.payment_id
       LEFT JOIN devices d
         ON d.id = c.device_id
       ORDER BY c.created_at DESC
       LIMIT 50`
    );

    res.json({
      ok: true,
      transactions: result.rows
    });

  } catch (e) {

    res.status(500).json({
      ok: false,
      error: e.message
    });

  }
});


// ============================================================
// PROMPTPAY QR CONFIG
// Customer QR page reads this configuration.
// Fill PROMPTPAY_ID in .env before using the real QR.
// ============================================================

const PROMPTPAY_ID =
  String(process.env.PROMPTPAY_ID || "").trim();

const PROMPTPAY_NAME =
  String(
    process.env.PROMPTPAY_NAME || "QR-WASH"
  )
    .trim()
    .slice(0, 25);

const PROMPTPAY_CITY =
  String(
    process.env.PROMPTPAY_CITY || "THAILAND"
  )
    .trim()
    .slice(0, 15);


app.get("/api/qr/config", (req, res) => {

  res.json({
    ok: true,
    enabled: !!PROMPTPAY_ID,
    promptpayId: PROMPTPAY_ID,
    name: PROMPTPAY_NAME,
    city: PROMPTPAY_CITY
  });

});



// ============================================================
// ADMIN SALES REPORT — รายวัน / รายเดือน / รายปี
// ใช้ข้อมูลการชำระเงินจริงจาก payments + คำสั่ง PULSE
// เขตเวลารายงาน: Asia/Bangkok
// ============================================================
app.get("/api/admin/reports", requireAdmin, async (req, res) => {
  try {
    const period = String(req.query.period || "day");
    let startDate = "";
    let endDate = "";

    if (period === "day") {
      const value = String(req.query.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return res.status(400).json({ ok: false, error: "กรุณาเลือกวันที่ให้ถูกต้อง (YYYY-MM-DD)" });
      }
      const d = new Date(value + "T00:00:00Z");
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
        return res.status(400).json({ ok: false, error: "วันที่ไม่ถูกต้อง" });
      }
      startDate = value;
      d.setUTCDate(d.getUTCDate() + 1);
      endDate = d.toISOString().slice(0, 10);
    } else if (period === "month") {
      const value = String(req.query.month || "");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
        return res.status(400).json({ ok: false, error: "กรุณาเลือกเดือนให้ถูกต้อง (YYYY-MM)" });
      }
      const [year, month] = value.split("-").map(Number);
      startDate = `${value}-01`;
      endDate = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
    } else if (period === "year") {
      const value = String(req.query.year || "");
      if (!/^\d{4}$/.test(value) || Number(value) < 2000 || Number(value) > 2100) {
        return res.status(400).json({ ok: false, error: "กรุณาเลือกปี ค.ศ. ให้ถูกต้อง" });
      }
      startDate = `${value}-01-01`;
      endDate = `${Number(value) + 1}-01-01`;
    } else {
      return res.status(400).json({ ok: false, error: "period ต้องเป็น day, month หรือ year" });
    }

    const range = `p.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Bangkok')
                   AND p.created_at < ($2::date::timestamp AT TIME ZONE 'Asia/Bangkok')`;

    const summaryResult = await pool.query(
      `SELECT
         COUNT(DISTINCT p.id)::int AS transactions,
         COALESCE(SUM(p.amount), 0)::numeric AS revenue,
         COALESCE(SUM(c.pulse_count), 0)::int AS pulses
       FROM payments p
       JOIN commands c ON c.payment_id = p.id AND c.command_type = 'PULSE'
       WHERE ${range}
         AND p.source = 'kbank_sms'`,
      [startDate, endDate]
    );

    let rowsResult;
    if (period === "day") {
      rowsResult = await pool.query(
        `SELECT p.id AS payment_id, p.transaction_key, p.amount,
                p.created_at, p.status AS payment_status,
                c.pulse_count, c.status AS command_status,
                d.name AS device_name
         FROM payments p
         JOIN commands c ON c.payment_id = p.id AND c.command_type = 'PULSE'
         LEFT JOIN devices d ON d.id = c.device_id
         WHERE ${range} AND p.source = 'kbank_sms'
         ORDER BY p.created_at DESC`,
        [startDate, endDate]
      );
    } else {
      const bucket = period === "month" ? "day" : "month";
      const dateExpression = period === "month"
        ? `(p.created_at AT TIME ZONE 'Asia/Bangkok')::date::text`
        : `to_char(p.created_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM')`;
      rowsResult = await pool.query(
        `SELECT ${dateExpression} AS period_label,
                COUNT(DISTINCT p.id)::int AS transactions,
                COALESCE(SUM(p.amount), 0)::numeric AS revenue,
                COALESCE(SUM(c.pulse_count), 0)::int AS pulses
         FROM payments p
         JOIN commands c ON c.payment_id = p.id AND c.command_type = 'PULSE'
         WHERE ${range} AND p.source = 'kbank_sms'
         GROUP BY ${period === "month" ? "(p.created_at AT TIME ZONE 'Asia/Bangkok')::date" : "to_char(p.created_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM')"}
         ORDER BY period_label ${bucket === "day" ? "ASC" : "ASC"}`,
        [startDate, endDate]
      );
    }

    res.json({
      ok: true,
      period,
      startDate,
      endDate,
      summary: summaryResult.rows[0],
      rows: rowsResult.rows
    });
  } catch (e) {
    console.error("Admin sales report error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(
    `QR-WASH NEON V1 running at http://localhost:${PORT}`
  );
});
