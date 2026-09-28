-- PM PRINT Account Management + customer cart.
-- PM PRINT ONLY. Never apply to the normal ISU/BSAIS database.
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, customer_id TEXT, checkout_id TEXT);
CREATE TABLE IF NOT EXISTS pm_customers (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  profile_picture_key TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  gender TEXT DEFAULT '',
  birthday TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pm_customer_sessions (
  token_hash TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pm_customer_sessions_customer ON pm_customer_sessions(customer_id);
CREATE TABLE IF NOT EXISTS pm_cart_items (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  file_hash TEXT DEFAULT '',
  file_type TEXT DEFAULT '',
  file_size INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_cart_customer ON pm_cart_items(customer_id,created_at);

-- customer_id and checkout_id are added idempotently by ensurePmAccountsSchema()
-- for existing PM PRINT databases before account/order APIs are used.

INSERT OR IGNORE INTO settings(key,value,updated_at)
VALUES('pmprint_account_management','0',datetime('now'));
