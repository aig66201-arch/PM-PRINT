-- PM PRINT customer-specific voucher assignments.
-- A voucher must be explicitly linked to a customer before an authenticated
-- account-managed customer can use it.
CREATE TABLE IF NOT EXISTS pm_customer_vouchers (
  customer_id TEXT NOT NULL,
  voucher_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, voucher_code)
);
CREATE INDEX IF NOT EXISTS idx_pm_customer_vouchers_customer
  ON pm_customer_vouchers(customer_id);
