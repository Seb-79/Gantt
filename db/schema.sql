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
  -- v2.0 / F4 — Contrainte FNLT (« Finish No Later Than ») : date de fin
  -- AU PLUS TARD souhaitée. NULL = pas de contrainte. Sœur jumelle du SNET
  -- mais sur la borne haute : applicable aux activités et aux jalons
  -- (jamais aux phases). **NON BLOQUANTE** : le dépassement est seulement
  -- signalé visuellement (bandeau de cohérence + icône rouge sur la barre).
  -- La date de fin EFFECTIVE peut donc être > FNLT, c'est à l'utilisateur
  -- de réagir (ajuster la charge, replanifier, négocier la deadline).
  not_later_than_date TEXT,
  -- v2.0 — Charge en jours ouvrés (≥ 1). Source de vérité pour les activités :
  -- `end_date` est désormais une valeur DÉRIVÉE (= addWorkingDays(start, charge)).
  -- Stockée pour optimiser les requêtes/index et garder la rétro-compatibilité
  -- des SELECT existants (les colonnes start_date / end_date restent inchangées,
  -- elles ne sont plus que des caches recomputés à chaque mutation).
  -- NULL pour jalons et phases (qui n'ont pas de charge propre).
  charge_jours    INTEGER,
  position        INTEGER NOT NULL,
  -- v1.8 — project_id est ajouté à la table tasks pour les bases neuves ;
  -- pour les bases anciennes, c'est `ensureTaskColumns()` (db/index.js) qui
  -- s'en charge via ALTER TABLE puis affectation au projet par défaut.
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  CHECK (progress BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_tasks_collab ON tasks(collaborator_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
-- idx_tasks_project est créé par `ensureProjectsMigration()` dans db/migrations.js
-- (même raison que idx_tasks_predecessor : la colonne peut être ajoutée par
-- migration ALTER TABLE sur une base antérieure à la v1.8).
-- L'index `idx_tasks_predecessor` est créé par `ensureTaskColumns()` dans
-- db/migrations.js : il dépend d'une colonne ajoutée par migration ALTER TABLE,
-- qui n'existe pas forcément quand `schema.sql` est rejoué sur une base
-- créée avant la v1.2 (CREATE TABLE IF NOT EXISTS ne migre pas).
-- v2.0 / Audit (e) — Idem pour `idx_tasks_kind_collab` (créé dans
-- `ensureTaskColumns()`) et `idx_tasks_project_position` (créé dans
-- `ensureProjectsMigration()`) : leurs colonnes peuvent être ajoutées par
-- ALTER TABLE après que schema.sql se soit rejoué.

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

-- =============================================================================
-- v2.0 — F1 : Memberships projet ↔ collaborateur.
-- Un collaborateur doit être MEMBRE d'un projet pour pouvoir être affecté à
-- une de ses activités. Cette table porte la liste des memberships, indé-
-- pendamment de toute notion de pourcentage d'allocation (qui viendra en F2
-- via la table `member_allocations`).
--
-- Cascades :
--   • Suppression d'un projet → ses memberships sont retirées (un projet
--     supprimé n'a plus d'équipe).
--   • Suppression d'un collaborateur → ses memberships sont retirées (un
--     collab supprimé n'est plus membre de rien).
-- =============================================================================
CREATE TABLE IF NOT EXISTS project_members (
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  collaborator_id TEXT NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, collaborator_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_collab
  ON project_members(collaborator_id);

-- =============================================================================
-- v2.0 / F2 — Périodes d'allocation % d'un membre sur un projet.
-- Chaque ligne = « le collab C est affecté à `allocation_pct` % de son temps
-- au projet P entre `start_date` et `end_date` (inclus) ».
--
-- Règles métier (validées en DAL + Zod) :
--   • `allocation_pct ∈ {25, 50, 75, 100}` (4 paliers fixés avec l'utilisateur).
--   • Pas de chevauchement temporel sur la même paire (project_id, collab_id) :
--     deux périodes ne peuvent pas se croiser même partiellement. Le DAL
--     rejette toute insertion qui violerait cet invariant.
--   • Hors période → 0 % de capacité (= collab non dispo ce jour-là sur le
--     projet). Le moteur `computeEndFromCharge` étire alors la fin de tâche.
--
-- L'id est un surrogate TEXT pour permettre DELETE/UPDATE ciblé depuis l'UI.
-- =============================================================================
CREATE TABLE IF NOT EXISTS member_allocations (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  collaborator_id TEXT NOT NULL,
  start_date      TEXT NOT NULL,            -- 'YYYY-MM-DD' inclus
  end_date        TEXT NOT NULL,            -- 'YYYY-MM-DD' inclus
  allocation_pct  INTEGER NOT NULL,         -- 25 | 50 | 75 | 100
  -- FK composite vers project_members : une allocation n'existe que si la
  -- membership existe ; supprimer la membership cascade les allocations.
  FOREIGN KEY (project_id, collaborator_id)
    REFERENCES project_members(project_id, collaborator_id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_member_allocations_lookup
  ON member_allocations(project_id, collaborator_id);
-- v2.0 / Audit (e) — Recherche d'allocations actives sur une date donnée
-- (capacité cross-projet, plan de charge global).
CREATE INDEX IF NOT EXISTS idx_member_allocations_dates
  ON member_allocations(start_date, end_date);

-- =============================================================================
-- v2.0 / F3 — Absences (congés) d'un collaborateur.
-- Cross-projet : une absence saisie sur Léa s'applique à TOUS ses projets
-- (la valeur retournée par `getDailyAllocation` est pondérée par
-- `1 − absence_fraction`, lecture MULTIPLICATIVE validée avec l'utilisateur).
--
-- Règles métier :
--   • `fraction ∈ {0.25, 0.5, 0.75, 1.0}` — paliers fixés (quart, demi,
--     trois-quarts, journée complète). Stockée en réel pour rester simple
--     avec SQLite (les paliers sont validés Zod côté API et DAL).
--   • Une seule entrée par (collab, date) : PRIMARY KEY composite.
--     Pour modifier la fraction, on supprime puis on rajoute (ou on upsert
--     via `INSERT OR REPLACE`).
--   • Suppression d'un collaborateur → cascade sur ses absences.
-- =============================================================================
CREATE TABLE IF NOT EXISTS collaborator_absences (
  collaborator_id TEXT NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  date            TEXT NOT NULL,            -- 'YYYY-MM-DD'
  fraction        REAL NOT NULL,            -- 0.25 | 0.5 | 0.75 | 1.0
  PRIMARY KEY (collaborator_id, date)
);
CREATE INDEX IF NOT EXISTS idx_collaborator_absences_date
  ON collaborator_absences(date);

-- =============================================================================
-- v2.0 / F6 — Multi-affectations : N collaborateurs par activité.
-- Remplace progressivement la colonne legacy `tasks.collaborator_id` (qui est
-- conservée pour rétro-compat et reste alimentée avec le 1er collab par ordre
-- d'id, mais le DAL/UI lit désormais cette table comme source de vérité).
--
-- Sémantique multi-collab (validé Q12a) : **additive uniforme**. Chaque jour,
-- chaque collab affecté contribue `pct/100 × (1−absence)`. La capacité du
-- jour = Σ contributions. La fin = dernier jour où la charge cumulée atteint
-- la cible.
--
-- Cascades :
--   • Suppression d'une tâche → ses affectations sont retirées.
--   • Suppression d'un collaborateur → il est retiré de toutes les tâches.
-- =============================================================================
CREATE TABLE IF NOT EXISTS task_assignments (
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  collaborator_id TEXT NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, collaborator_id)
);
CREATE INDEX IF NOT EXISTS idx_task_assignments_collab
  ON task_assignments(collaborator_id);
