-- =============================================================================
-- SCHÉMA SQLite — Gantt v1
-- =============================================================================
-- 4 tables :
--   • meta            → métadonnées (notamment "version" incrémentée à chaque
--                       mutation, utilisée par le client pour détecter les
--                       changements en polling).
--   • projects        → (v1.8) regroupement de phases / jalons / activités.
--                       Chaque tâche appartient à un projet ; la suppression
--                       d'un projet cascade sur ses tâches.
--                       Les collaborateurs restent partagés entre projets.
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

-- v1.8 — Projets : un Gantt = N projets distincts, on en charge un à la fois.
CREATE TABLE IF NOT EXISTS projects (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  -- kind ∈ {'task', 'milestone', 'phase'} (v1.6) — la validation est faite
  -- côté Zod (server/schemas.js). Pas de CHECK SQL pour rester migration-friendly.
  kind            TEXT NOT NULL DEFAULT 'task',
  start_date      TEXT NOT NULL,                  -- 'YYYY-MM-DD'
  end_date        TEXT NOT NULL,                  -- 'YYYY-MM-DD' (== start si jalon)
  progress        INTEGER NOT NULL DEFAULT 0,     -- 0 à 100
  collaborator_id TEXT REFERENCES collaborators(id) ON DELETE SET NULL,
  color           TEXT,                           -- nullable, sinon couleur du collab
  parent_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  predecessor_id  TEXT REFERENCES tasks(id) ON DELETE SET NULL, -- v1.2
  -- v1.10 — Délai (jours OUVRÉS) entre la fin du prédécesseur et le début
  -- de cette tâche. 0 = enchaînement immédiat (Y.start == X.end).
  -- N = Y.start = (N+1)-ème jour ouvré depuis X.end (cf. computeSuccessorStart).
  -- Pour les tâches sans prédécesseur, vaut 0 (non significatif).
  predecessor_lag INTEGER NOT NULL DEFAULT 0,
  -- v1.18 / v1.24 — Priorité (1 à 5). Désormais OBLIGATOIRE sur les activités
  -- avec 3 comme défaut (porté par le DAL, pas par une contrainte SQL pour
  -- rester compatible avec les bases anciennes). NULL pour les jalons et les
  -- phases. Utilisée par « Replan » pour arbitrer entre deux activités d'un
  -- même collaborateur en surcharge.
  priority        INTEGER,
  -- v1.24 — Contrainte SNET (« Start No Earlier Than ») : date de démarrage au plus tôt en
  -- dessous de laquelle la tâche ne peut pas commencer. NULL = pas de
  -- contrainte. Applicable aux activités et aux jalons uniquement (jamais
  -- aux phases dont les dates sont la synthèse des enfants).
  not_before_date TEXT,
  position        INTEGER NOT NULL,
  -- v1.8 — project_id est ajouté à la table tasks pour les bases neuves ;
  -- pour les bases anciennes, c'est `ensureTaskColumns()` (db/index.js) qui
  -- s'en charge via ALTER TABLE puis affectation au projet par défaut.
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  CHECK (progress BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_tasks_collab ON tasks(collaborator_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
-- idx_tasks_project est créé par `ensureProjectsMigration()` dans db/index.js
-- (même raison que idx_tasks_predecessor : la colonne peut être ajoutée par
-- migration ALTER TABLE sur une base antérieure à la v1.8).
-- L'index `idx_tasks_predecessor` est créé par `ensureTaskColumns()` dans
-- db/index.js : il dépend d'une colonne ajoutée par migration ALTER TABLE,
-- qui n'existe pas forcément quand `schema.sql` est rejoué sur une base
-- créée avant la v1.2 (CREATE TABLE IF NOT EXISTS ne migre pas).

-- =============================================================================
-- v1.21 — Table de liaison N:M tasks ↔ prédécesseurs.
-- Une tâche peut avoir 0..N prédécesseurs, chacun avec son propre délai
-- (jours ouvrés). La date de début de la tâche est calculée comme
-- MAX(pred_i.end_date + lag_i) — règle PERT standard.
--
-- L'ancien couple `tasks.predecessor_id` / `tasks.predecessor_lag` est
-- conservé en colonne pour ne pas casser les bases antérieures (les valeurs
-- y restent figées et ne sont plus utilisées par le code v1.21+) — il sera
-- retiré dans une migration ultérieure de nettoyage.
-- =============================================================================
CREATE TABLE IF NOT EXISTS task_predecessors (
  -- Tâche successeur : la liaison est supprimée si la tâche est supprimée.
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- Tâche prédécesseur : la liaison est supprimée si le prédécesseur est
  -- supprimé (comportement attendu : on perd la dépendance, pas la tâche
  -- successeur — équivalent SQL au précédent ON DELETE SET NULL).
  predecessor_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- Délai en jours ouvrés strictement entre pred.end_date et task.start_date.
  -- 0 = enchaînement immédiat (le successeur démarre le jour ouvré suivant).
  lag            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, predecessor_id)
);
CREATE INDEX IF NOT EXISTS idx_task_predecessors_pred
  ON task_predecessors(predecessor_id);
