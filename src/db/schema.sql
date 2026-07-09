CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  registration_enabled INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO server_settings (id, registration_enabled) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  controller TEXT NOT NULL,
  callsign TEXT NOT NULL,
  time TEXT NOT NULL,
  rst_sent TEXT,
  rst_rcvd TEXT,
  qth TEXT,
  device TEXT,
  power TEXT,
  antenna TEXT,
  height TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_session ON logs(session_id);
CREATE INDEX IF NOT EXISTS idx_logs_sync_id ON logs(sync_id);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_user_id);
