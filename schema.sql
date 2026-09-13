-- =========================================================
-- QR-WASH NEON V1
-- Run this only if you have NOT already created the tables.
-- Your existing QR-WASH tables can be reused.
-- =========================================================

CREATE TABLE IF NOT EXISTS machines (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    pulse_per_10_baht INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devices (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    machine_id BIGINT REFERENCES machines(id) ON DELETE SET NULL,
    online BOOLEAN NOT NULL DEFAULT FALSE,
    last_seen TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
    id BIGSERIAL PRIMARY KEY,
    transaction_key TEXT NOT NULL UNIQUE,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    source TEXT NOT NULL DEFAULT 'test',
    raw_message TEXT,
    status TEXT NOT NULL DEFAULT 'RECEIVED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commands (
    id BIGSERIAL PRIMARY KEY,
    payment_id BIGINT REFERENCES payments(id) ON DELETE SET NULL,
    device_id BIGINT REFERENCES devices(id) ON DELETE SET NULL,
    command_type TEXT NOT NULL DEFAULT 'PULSE',
    pulse_count INTEGER NOT NULL CHECK (pulse_count > 0),
    status TEXT NOT NULL DEFAULT 'QUEUED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    device_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_commands_queue
ON commands(device_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_payments_created
ON payments(created_at DESC);

INSERT INTO machines (name)
SELECT 'เครื่องทดลอง 01'
WHERE NOT EXISTS (
    SELECT 1 FROM machines WHERE name = 'เครื่องทดลอง 01'
);

INSERT INTO devices (name, token, machine_id)
SELECT 'ESP32 ทดลอง 01', 'ESP32-TEST-1234', id
FROM machines
WHERE name = 'เครื่องทดลอง 01'
AND NOT EXISTS (
    SELECT 1 FROM devices WHERE token = 'ESP32-TEST-1234'
);
