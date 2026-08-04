CREATE TABLE IF NOT EXISTS fetch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('outlook', 'proton')),
  account_count INTEGER NOT NULL DEFAULT 0 CHECK (account_count >= 0),
  day_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fetch_events_day_key ON fetch_events(day_key);
CREATE INDEX IF NOT EXISTS idx_fetch_events_kind ON fetch_events(kind);
CREATE INDEX IF NOT EXISTS idx_fetch_events_created_at ON fetch_events(created_at);
