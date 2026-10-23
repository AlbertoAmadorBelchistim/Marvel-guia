-- Progreso de la ruta de cómics (/comics), aparte del progreso de películas y series.
-- Aditiva: no toca las tablas de 0002.
CREATE TABLE IF NOT EXISTS comic_progress (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  read TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
