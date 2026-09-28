-- PM PRINT customer saved addresses and delivery-order snapshots.
-- PM PRINT ONLY. Never apply to the normal ISU/BSAIS database.
CREATE TABLE IF NOT EXISTS pm_customer_addresses (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL,
  landmark TEXT DEFAULT '',
  grade_section TEXT DEFAULT '',
  room TEXT DEFAULT '',
  floor TEXT DEFAULT '',
  building TEXT DEFAULT '',
  instructions TEXT DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_customer_addresses_customer
  ON pm_customer_addresses(customer_id,is_default,created_at);
-- delivery_address_json is added idempotently by the PM PRINT runtime schema check.
-- Do not ALTER TABLE here because the runtime check may already have created it.
