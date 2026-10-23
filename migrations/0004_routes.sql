-- Progreso de las demás rutas de lectura (/dc y las que vengan), una fila por usuario y ruta.
-- Aditiva. La ruta Marvel sigue en comic_progress.
CREATE TABLE IF NOT EXISTS route_progress (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route TEXT NOT NULL,
  read TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, route)
);
