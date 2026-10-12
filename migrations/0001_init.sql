-- Esquema de la base de datos D1 "marvel-guia" (ya aplicado en producción).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS progress (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  watched TEXT NOT NULL DEFAULT '[]',
  country TEXT,
  updated_at INTEGER NOT NULL
);

-- Limita intentos fallidos de inicio de sesión por usuario y por IP.
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
