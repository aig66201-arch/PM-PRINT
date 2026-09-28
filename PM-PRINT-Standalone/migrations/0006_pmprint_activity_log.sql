CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_activity_log_timestamp ON activity_log(timestamp DESC);
