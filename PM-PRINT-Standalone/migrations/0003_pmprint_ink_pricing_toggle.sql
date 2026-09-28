INSERT INTO settings(key,value,updated_at) VALUES ('pmprint_ink_pricing_enabled','1',CURRENT_TIMESTAMP) ON CONFLICT(key) DO NOTHING;
