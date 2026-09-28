CREATE TABLE IF NOT EXISTS pm_customer_vouchers (
  customer_id TEXT NOT NULL,
  voucher_code TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  assigned_by TEXT DEFAULT '',
  PRIMARY KEY (customer_id, voucher_code)
);
CREATE INDEX IF NOT EXISTS idx_pm_customer_vouchers_customer ON pm_customer_vouchers(customer_id);
CREATE INDEX IF NOT EXISTS idx_pm_customer_vouchers_code ON pm_customer_vouchers(voucher_code);
