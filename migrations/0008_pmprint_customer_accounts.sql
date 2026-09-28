-- PM PRINT customer account management.
-- Account creation is administrator-only. Customers may only log in to accounts created here.
CREATE TABLE IF NOT EXISTS pm_customers (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  name TEXT NOT NULL,
  profile_picture_key TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  gender TEXT DEFAULT '',
  birthday TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS pm_customer_sessions (
  token_hash TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pm_customer_sessions_customer ON pm_customer_sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_pm_orders_customer ON orders(customer_id,created_at);
