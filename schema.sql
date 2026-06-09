-- ═══════════════════════════════════════════════════════════
--  CS Automation Adsy — Tambahan Tabel Supabase
--  Jalankan di: Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════════

-- CASES — tiap percakapan customer ditrack sebagai case
CREATE TABLE IF NOT EXISTS cases (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contact_id   UUID REFERENCES contacts(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT DEFAULT 'Case Baru',
  status       TEXT DEFAULT 'baru',     -- baru | diproses | eskalasi | selesai
  priority     TEXT DEFAULT 'low',      -- low | medium | high | urgent
  notes        TEXT,
  is_escalated BOOLEAN DEFAULT false,
  resolved_at  TIMESTAMP WITH TIME ZONE,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at   TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- ORDERS — manajemen order dari percakapan
CREATE TABLE IF NOT EXISTS orders (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contact_id       UUID REFERENCES contacts(id) ON DELETE SET NULL,
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  order_number     TEXT UNIQUE,
  items            TEXT,          -- deskripsi produk / JSON
  total            BIGINT DEFAULT 0,
  status           TEXT DEFAULT 'pending',   -- pending | confirmed | processing | shipped | delivered | cancelled
  payment_method   TEXT DEFAULT 'transfer',  -- transfer | cod | ewallet
  payment_status   TEXT DEFAULT 'unpaid',    -- unpaid | paid
  shipping_address TEXT,
  courier          TEXT,
  resi             TEXT,
  notes            TEXT,
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at       TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- BROADCASTS — riwayat pesan broadcast
CREATE TABLE IF NOT EXISTS broadcasts (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT,
  message      TEXT,
  target_label TEXT,          -- null = semua kontak
  total_target INTEGER DEFAULT 0,
  sent_count   INTEGER DEFAULT 0,
  status       TEXT DEFAULT 'done',  -- draft | sending | done | failed
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Index untuk performa
CREATE INDEX IF NOT EXISTS cases_user_id_idx    ON cases(user_id);
CREATE INDEX IF NOT EXISTS cases_contact_id_idx ON cases(contact_id);
CREATE INDEX IF NOT EXISTS cases_status_idx     ON cases(status);
CREATE INDEX IF NOT EXISTS orders_user_id_idx   ON orders(user_id);
CREATE INDEX IF NOT EXISTS orders_status_idx    ON orders(status);
CREATE INDEX IF NOT EXISTS broadcasts_user_idx  ON broadcasts(user_id);
