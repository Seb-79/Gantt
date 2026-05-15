-- =============================================================================
-- SCHÉMA SQLite — Gantt v1
-- =============================================================================
-- 3 tables :
--   • meta            → métadonnées (notamment "version" incrémentée à chaque
--                       mutation, utilisée par le client pour détecter les
--                       changements en polling).
--   • collaborators   → ressources affectables aux tâches. Chaque collab a une
--                       couleur de bandeau (utilisée par défaut pour les tâches
--                       qui lui sont affectées).
--   • tasks           → tâches OU jalons (cf. colonne "kind").
--                       Une tâche a une date de début et de fin (YYYY-MM-DD).
--                       Un jalon a juste une date (start_date == end_date).
--                       progress ∈ [0, 100] (en %)
--                       collaborator_id nullable (tâche non affectée)
--                       color nullable (sinon couleur du collab, sinon défaut)
--                       parent_id nullable (regroupement en phases / lots)
--                       predecessor_id nullable (v1.2) — tâche prédécesseur :
--                         la start_date de la tâche est alors imposée à la
--                         end_date du prédécesseur (logique gérée côté client
--                         et au moment de la sauvegarde).
--
-- Mode WAL activé par initDb() pour autoriser plusieurs lecteurs et un
-- écrivain simultanés (largement suffisant pour ~10 utilisateurs en LAN).
-- =============================================================================

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collaborators (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  color    TEXT NOT NULL DEFAULT '#3b82f6', -- bleu Tailwind par défaut
  position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'task',  -- 'task' | 'milestone'
  start_date      TEXT NOT NULL,                  -- 'YYYY-MM-DD'
  end_date        TEXT NOT NULL,                  -- 'YYYY-MM-DD' (== start si jalon)
  progress        INTEGER NOT NULL DEFAULT 0,     -- 0 à 100
  collaborator_id TEXT REFERENCES collaborators(id) ON DELETE SET NULL,
  color           TEXT,                           -- nullable, sinon couleur du collab
  parent_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  predecessor_id  TEXT REFERENCES tasks(id) ON DELETE SET NULL, -- v1.2
  position        INTEGER NOT NULL,
  CHECK (kind IN ('task', 'milestone')),
  CHECK (progress BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_tasks_collab ON tasks(collaborator_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
-- L'index `idx_tasks_predecessor` est créé par `ensureTaskColumns()` dans
-- db/index.js : il dépend d'une colonne ajoutée par migration ALTER TABLE,
-- qui n'existe pas forcément quand `schema.sql` est rejoué sur une base
-- créée avant la v1.2 (CREATE TABLE IF NOT EXISTS ne migre pas).
