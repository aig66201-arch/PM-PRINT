CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  device_id TEXT DEFAULT ''
);

ALTER TABLE notifications ADD COLUMN customer_id TEXT;
ALTER TABLE notifications ADD COLUMN category TEXT NOT NULL DEFAULT 'printing';

CREATE INDEX IF NOT EXISTS idx_pm_notifications_customer ON notifications(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pm_notifications_order ON notifications(order_id,created_at DESC);
