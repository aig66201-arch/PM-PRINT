-- PM PRINT ink pricing, page analysis, and temporary uploads.
-- PMPRINT-only migration. The regular printing database is not touched.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pricing (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vouchers (
  code TEXT PRIMARY KEY, type TEXT NOT NULL, value REAL NOT NULL DEFAULT 0,
  min_spend REAL NOT NULL DEFAULT 0, max_discount REAL, max_shipping_discount REAL,
  min_pages INTEGER NOT NULL DEFAULT 0, min_copies INTEGER NOT NULL DEFAULT 0,
  total_usage_limit INTEGER, per_device_limit INTEGER NOT NULL DEFAULT 1,
  start_at TEXT, end_at TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS voucher_redemptions (
  id TEXT PRIMARY KEY, voucher_code TEXT NOT NULL, device_id TEXT NOT NULL,
  order_id TEXT NOT NULL, discount REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  UNIQUE(voucher_code, device_id, order_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
  message TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT, device_id TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, customer_name TEXT NOT NULL, contact TEXT NOT NULL,
  location TEXT DEFAULT '', content_type TEXT NOT NULL, print_color TEXT NOT NULL,
  print_side TEXT NOT NULL, format TEXT NOT NULL, paper_size TEXT NOT NULL,
  copies INTEGER NOT NULL, binding TEXT DEFAULT '', file_name TEXT DEFAULT '', r2_key TEXT DEFAULT '',
  fulfillment TEXT NOT NULL, delivery_fee REAL NOT NULL DEFAULT 0, delivery_notes TEXT DEFAULT '',
  pages INTEGER NOT NULL, page_selection TEXT DEFAULT '', printed_sides INTEGER NOT NULL,
  sheets INTEGER NOT NULL, printing_cost REAL NOT NULL, paper_cost REAL NOT NULL, amount REAL NOT NULL,
  payment_status TEXT DEFAULT 'Payment Due', status TEXT NOT NULL DEFAULT 'Pending', status_reason TEXT DEFAULT '',
  ready_pickup_location TEXT DEFAULT '', voucher_code TEXT DEFAULT '', discount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, device_id TEXT DEFAULT '',
  device_brand TEXT DEFAULT '', device_model TEXT DEFAULT '', device_os TEXT DEFAULT '', device_browser TEXT DEFAULT '',
  ink_analysis_json TEXT DEFAULT '', pricing_snapshot_json TEXT DEFAULT '', automatic_ink_cost REAL NOT NULL DEFAULT 0,
  admin_ink_override REAL, final_ink_cost REAL NOT NULL DEFAULT 0, ink_price_source TEXT NOT NULL DEFAULT 'AUTOMATIC', file_hash TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
  permissions TEXT DEFAULT '', created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Admin', status TEXT NOT NULL DEFAULT 'Active', permissions TEXT DEFAULT '',
  created_at TEXT NOT NULL, last_login TEXT, notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS temp_uploads (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, r2_key TEXT UNIQUE NOT NULL, file_name TEXT NOT NULL,
  file_hash TEXT DEFAULT '', analysis_json TEXT DEFAULT '', page_count INTEGER DEFAULT 0,
  uploaded_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_temp_expiry ON temp_uploads(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_pm_temp_session ON temp_uploads(session_id, status);

-- New PMPRINT order fields. The CREATE TABLE above makes fresh PMPRINT databases safe;
-- these ALTER statements are intentionally isolated for existing PMPRINT databases.

INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('pmprint_black_ink_rate','0.50',datetime('now'));
INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('pmprint_color_ink_rate','1.00',datetime('now'));
INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('pmprint_min_ink_charge','0.01',datetime('now'));
INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('pmprint_ink_rounding','UP_TO_0.01',datetime('now'));
INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('pmprint_temp_expiration_hours','1',datetime('now'));
INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('printing_available','true',datetime('now'));
INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('pickup_location','Yao St., Purok 5, Naganacan, Cauayan City, Isabela',datetime('now'));
INSERT OR IGNORE INTO pricing(key,value,updated_at) VALUES('text_bw',1,datetime('now'));
INSERT OR IGNORE INTO pricing(key,value,updated_at) VALUES('text_color',2,datetime('now'));
INSERT OR IGNORE INTO pricing(key,value,updated_at) VALUES('text_image_bw',2,datetime('now'));
INSERT OR IGNORE INTO pricing(key,value,updated_at) VALUES('text_image_color',3,datetime('now'));
INSERT OR IGNORE INTO pricing(key,value,updated_at) VALUES('image_bw',3,datetime('now'));
INSERT OR IGNORE INTO pricing(key,value,updated_at) VALUES('image_color',4,datetime('now'));
INSERT OR IGNORE INTO pricing(key,value,updated_at) VALUES('paper_per_sheet',1,datetime('now'));
INSERT OR IGNORE INTO locations(id,name,fee,active,created_at,updated_at) VALUES('LOC-PICKUP','Pickup',0,1,datetime('now'),datetime('now'));
