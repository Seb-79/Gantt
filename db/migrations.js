// =============================================================================
// MIGRATIONS BDD — appliquées à chaque ouverture de la base
// =============================================================================
// Chaque fonction `ensureXxx` est IDEMPOTENTE : sûre à rejouer même sur une
// base déjà migrée (CREATE TABLE IF NOT EXISTS, ALTER TABLE conditionnel,
// INSERT OR IGNORE pour les auto-populations).
//
// L'ordre d'appel dans `initDb` est important (cf. db/index.js) : certaines
// migrations dépendent du fait que d'autres aient déjà tourné (ex.
// `ensureMemberAllocationsTable` suppose que `project_members` existe).
// =============================================================================

import { workingDaysBetweenServer } from './working-days.js'

/** Id du projet par défaut créé lors de la migration v1.8. */
export const DEFAULT_PROJECT_ID = 'p_default'
/** Nom du projet par défaut (renommable ensuite via l'UI). */
export const DEFAULT_PROJECT_NAME = 'Projet 1'

/**
 * v1.8 — Migration idempotente vers la notion de projet :
 *   1. ajoute la colonne `project_id` sur `tasks` si elle manque ;
 *   2. crée le projet "Projet 1" s'il n'existe aucun projet ET qu'il
 *      reste des tâches sans rattachement ;
 *   3. rattache toutes les tâches sans `project_id` à ce projet par défaut.
 *
 * L'opération est sûre à rejouer : si tout est déjà en ordre, elle est
 * silencieuse.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function ensureProjectsMigration(db) {
  // 1. Ajoute project_id sur tasks si absente.
  const taskCols = db
    .prepare(`PRAGMA table_info(tasks)`)
    .all()
    .map((c) => c.name)
  if (!taskCols.includes('project_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN project_id TEXT`)
  }
  // L'index dépend de la colonne — toujours rejoué après pour idempotence.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`)
  // v2.0 / Audit (e) — Index composite (project_id, position) pour
  // `getFullState` qui scanne `WHERE project_id=? ORDER BY position`. Évite
  // un tri en mémoire dès que le projet contient plusieurs centaines de lignes.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tasks_project_position ON tasks(project_id, position)`,
  )

  // 2. Combien de tâches orphelines ? (peut être 0 dès le 2e boot)
  const orphans = db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id IS NULL`)
    .get().n
  if (orphans === 0) return

  // 3. Trouve (ou crée) un projet par défaut à qui les rattacher.
  let target = db
    .prepare(`SELECT id FROM projects ORDER BY position ASC, id ASC LIMIT 1`)
    .get()
  if (!target) {
    db.prepare(`INSERT INTO projects(id, name, position) VALUES (?, ?, 0)`).run(
      DEFAULT_PROJECT_ID,
      DEFAULT_PROJECT_NAME,
    )
    target = { id: DEFAULT_PROJECT_ID }
    console.log(
      `[INIT] Migration v1.8 : création du projet par défaut « ${DEFAULT_PROJECT_NAME} »`,
    )
  }
  const upd = db.prepare(
    `UPDATE tasks SET project_id = ? WHERE project_id IS NULL`,
  )
  const r = upd.run(target.id)
  console.log(
    `[INIT] Migration v1.8 : ${r.changes} tâche(s) rattachée(s) au projet « ${target.id} »`,
  )
}

/**
 * Migration ALTER TABLE idempotente. Ajoute les colonnes manquantes sur la
 * table `tasks` (utile pour les bases créées avec un schéma plus ancien).
 *
 * @param {import('better-sqlite3').Database} db
 */
export function ensureTaskColumns(db) {
  const cols = db
    .prepare(`PRAGMA table_info(tasks)`)
    .all()
    .map((c) => c.name)
  if (!cols.includes('predecessor_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN predecessor_id TEXT`)
  }
  // v1.10 — Délai en jours ouvrés entre le prédécesseur et la tâche.
  if (!cols.includes('predecessor_lag')) {
    db.exec(
      `ALTER TABLE tasks ADD COLUMN predecessor_lag INTEGER NOT NULL DEFAULT 0`,
    )
    const rows = db
      .prepare(
        `SELECT t.id AS id, t.start_date AS start_date, p.end_date AS pred_end
           FROM tasks t
           JOIN tasks p ON t.predecessor_id = p.id`,
      )
      .all()
    const upd = db.prepare(`UPDATE tasks SET predecessor_lag = ? WHERE id = ?`)
    let migrated = 0
    for (const r of rows) {
      // lag = jours ouvrés STRICTEMENT entre fin du prédécesseur et début.
      const lag = Math.max(
        0,
        workingDaysBetweenServer(r.pred_end, r.start_date) - 1,
      )
      if (lag > 0) {
        upd.run(lag, r.id)
        migrated++
      }
    }
    if (migrated > 0) {
      console.log(
        `[INIT] Migration v1.10 : ${migrated} tâche(s) ont vu leur prédécesseur_lag initialisé depuis l'écart existant.`,
      )
    }
  }
  // v1.18 — Priorité facultative.
  if (!cols.includes('priority')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN priority INTEGER`)
  }
  // v1.24 — Contrainte SNET.
  if (!cols.includes('not_before_date')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN not_before_date TEXT`)
  }
  // v2.0 / F4 — Contrainte FNLT (deadline non-bloquante).
  if (!cols.includes('not_later_than_date')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN not_later_than_date TEXT`)
  }
  // v1.24/v2.0 — Nettoyages métier idempotents.
  cleanupTaskMetadata(db)

  // Index pour la jointure des prédécesseurs (legacy).
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tasks_predecessor ON tasks(predecessor_id)`,
  )
  // v2.0 / Audit (e) — Index partiel (kind, collaborator_id) pour la vue
  // Plan de charge globale, qui filtre kind='task' AND collaborator_id IS
  // NOT NULL en cross-projet. Partiel = on n'indexe pas les lignes sans
  // collab (jalons / tâches non encore affectées), ce qui garde l'index
  // compact même si le nombre de tâches grandit.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tasks_kind_collab
       ON tasks(kind, collaborator_id)
       WHERE collaborator_id IS NOT NULL`,
  )
}

/**
 * v1.24/v2.0 — Nettoyages métier appliqués à chaque boot pour garantir les
 * invariants de la base :
 *   • Pr2 (v1.24) : activités sans priorité → 3 ; jalons/phases avec
 *     priorité résiduelle → null.
 *   • SNET (v1.24) : phase avec not_before_date → null.
 *   • FNLT (v2.0/F4) : phase avec not_later_than_date → null.
 *   • J3 (v1.24) : jalon avec collaborator_id → null.
 *
 * Idempotent et sans effet sur les bases déjà conformes.
 *
 * @param {import('better-sqlite3').Database} db
 */
function cleanupTaskMetadata(db) {
  const rPrioTask = db
    .prepare(
      `UPDATE tasks SET priority = 3 WHERE kind = 'task' AND priority IS NULL`,
    )
    .run()
  if (rPrioTask.changes > 0) {
    console.log(
      `[INIT] Migration v1.24 (Pr2) : ${rPrioTask.changes} activité(s) sans priorité → initialisée(s) à 3.`,
    )
  }
  const rPrioNonTask = db
    .prepare(
      `UPDATE tasks
         SET priority = NULL
         WHERE kind IN ('milestone', 'phase') AND priority IS NOT NULL`,
    )
    .run()
  if (rPrioNonTask.changes > 0) {
    console.log(
      `[INIT] Migration v1.24 (Pr2) : ${rPrioNonTask.changes} jalon(s)/phase(s) avaient une priorité résiduelle — effacée(s).`,
    )
  }
  const rSnetPhase = db
    .prepare(
      `UPDATE tasks
         SET not_before_date = NULL
         WHERE kind = 'phase' AND not_before_date IS NOT NULL`,
    )
    .run()
  if (rSnetPhase.changes > 0) {
    console.log(
      `[INIT] Migration v1.24 (SNET) : ${rSnetPhase.changes} phase(s) avaient une date "ne doit pas démarrer avant le" — effacée(s).`,
    )
  }
  const rFnltPhase = db
    .prepare(
      `UPDATE tasks
         SET not_later_than_date = NULL
         WHERE kind = 'phase' AND not_later_than_date IS NOT NULL`,
    )
    .run()
  if (rFnltPhase.changes > 0) {
    console.log(
      `[INIT] Migration v2.0/F4 (FNLT) : ${rFnltPhase.changes} phase(s) avaient une date "fin au plus tard" — effacée(s).`,
    )
  }
  const r = db
    .prepare(
      `UPDATE tasks
         SET collaborator_id = NULL
         WHERE kind = 'milestone' AND collaborator_id IS NOT NULL`,
    )
    .run()
  if (r.changes > 0) {
    console.log(
      `[INIT] Migration v1.24 (J3) : ${r.changes} jalon(s) avaient un collaborateur affecté — nettoyé(s).`,
    )
  }
}

/**
 * v1.6 — Migration : si la définition SQL de `tasks` contient encore
 * l'ancien CHECK qui n'autorisait que ('task', 'milestone'), reconstruit
 * la table SANS ce CHECK pour que kind='phase' devienne valide.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function ensureKindAcceptsPhase(db) {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`,
    )
    .get()
  const sql = row?.sql || ''
  const hasOldCheck =
    /CHECK\s*\(\s*kind\s+IN\s*\(\s*'task'\s*,\s*'milestone'\s*\)\s*\)/i.test(
      sql,
    )
  if (!hasOldCheck) return
  console.log(
    "[INIT] Migration : recréation de la table 'tasks' pour accepter kind='phase'",
  )
  db.exec(`
    CREATE TABLE tasks_new (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      kind            TEXT NOT NULL DEFAULT 'task',
      start_date      TEXT NOT NULL,
      end_date        TEXT NOT NULL,
      progress        INTEGER NOT NULL DEFAULT 0,
      collaborator_id TEXT REFERENCES collaborators(id) ON DELETE SET NULL,
      color           TEXT,
      parent_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      predecessor_id  TEXT,
      predecessor_lag INTEGER NOT NULL DEFAULT 0,
      priority        INTEGER,
      not_before_date TEXT,
      not_later_than_date TEXT,
      position        INTEGER NOT NULL,
      CHECK (progress BETWEEN 0 AND 100)
    );
    INSERT INTO tasks_new
      (id, name, kind, start_date, end_date, progress,
       collaborator_id, color, parent_id, predecessor_id, predecessor_lag,
       priority, not_before_date, not_later_than_date, position)
    SELECT
       id, name, kind, start_date, end_date, progress,
       collaborator_id, color, parent_id, predecessor_id, predecessor_lag,
       priority, not_before_date, not_later_than_date, position
    FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE tasks_new RENAME TO tasks;
    CREATE INDEX IF NOT EXISTS idx_tasks_collab      ON tasks(collaborator_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent      ON tasks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_predecessor ON tasks(predecessor_id);
  `)
}

/**
 * v1.21 — Crée la table `task_predecessors` + migre les anciennes liaisons
 * mono-prédécesseur (`tasks.predecessor_id`) vers la nouvelle table N:M.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function ensureTaskPredecessorsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_predecessors (
      task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      predecessor_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      lag            INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (task_id, predecessor_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_predecessors_pred
      ON task_predecessors(predecessor_id);
  `)
  const cols = db
    .prepare(`PRAGMA table_info(tasks)`)
    .all()
    .map((c) => c.name)
  if (!cols.includes('predecessor_id')) return
  const rows = db
    .prepare(
      `SELECT t.id AS task_id, t.predecessor_id, t.predecessor_lag
         FROM tasks t
         WHERE t.predecessor_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM tasks p WHERE p.id = t.predecessor_id)
           AND NOT EXISTS (
             SELECT 1 FROM task_predecessors tp
              WHERE tp.task_id = t.id AND tp.predecessor_id = t.predecessor_id
           )`,
    )
    .all()
  if (rows.length === 0) return
  const ins = db.prepare(
    `INSERT INTO task_predecessors(task_id, predecessor_id, lag) VALUES (?, ?, ?)`,
  )
  for (const r of rows) {
    ins.run(
      r.task_id,
      r.predecessor_id,
      Math.max(0, Number(r.predecessor_lag) || 0),
    )
  }
  console.log(
    `[INIT] Migration v1.21 : ${rows.length} liaison(s) prédécesseur migrée(s) vers task_predecessors.`,
  )
}

/**
 * v2.0 — Ajoute `charge_jours` sur `tasks` et initialise depuis l'écart
 * courant pour chaque activité existante. Bascule vers "charge = source de
 * vérité, end_date = dérivée".
 *
 * @param {import('better-sqlite3').Database} db
 */
export function ensureChargeColumn(db) {
  const cols = db
    .prepare(`PRAGMA table_info(tasks)`)
    .all()
    .map((c) => c.name)
  if (!cols.includes('charge_jours')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN charge_jours INTEGER`)
  }
  const rows = db
    .prepare(
      `SELECT id, start_date, end_date FROM tasks
         WHERE kind = 'task' AND charge_jours IS NULL`,
    )
    .all()
  if (rows.length > 0) {
    const upd = db.prepare(`UPDATE tasks SET charge_jours = ? WHERE id = ?`)
    for (const r of rows) {
      const c = Math.max(1, workingDaysBetweenServer(r.start_date, r.end_date))
      upd.run(c, r.id)
    }
    console.log(
      `[INIT] Migration v2.0 (charge) : ${rows.length} activité(s) → charge_jours initialisée depuis l'écart courant.`,
    )
  }
  const rNonTask = db
    .prepare(
      `UPDATE tasks SET charge_jours = NULL
         WHERE kind IN ('milestone', 'phase') AND charge_jours IS NOT NULL`,
    )
    .run()
  if (rNonTask.changes > 0) {
    console.log(
      `[INIT] Migration v2.0 (charge) : ${rNonTask.changes} jalon(s)/phase(s) avaient une charge résiduelle — effacée(s).`,
    )
  }
}

/**
 * v2.0 / F1 — Crée la table `project_members` + auto-peuple les memberships
 * depuis les affectations de tâches existantes (option α validée).
 *
 * @param {import('better-sqlite3').Database} db
 */
export function ensureProjectMembersTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_members (
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      collaborator_id TEXT NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
      PRIMARY KEY (project_id, collaborator_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_members_collab
      ON project_members(collaborator_id);
  `)
  const rows = db
    .prepare(
      `SELECT DISTINCT t.project_id, t.collaborator_id
         FROM tasks t
         WHERE t.collaborator_id IS NOT NULL
           AND t.project_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM project_members m
              WHERE m.project_id = t.project_id
                AND m.collaborator_id = t.collaborator_id
           )`,
    )
    .all()
  if (rows.length === 0) return
  const ins = db.prepare(
    `INSERT OR IGNORE INTO project_members(project_id, collaborator_id) VALUES (?, ?)`,
  )
  for (const r of rows) ins.run(r.project_id, r.collaborator_id)
  console.log(
    `[INIT] Migration v2.0 / F1 : ${rows.length} membership(s) auto-créée(s) depuis les affectations de tâches existantes.`,
  )
}

/**
 * v2.0 / F2 — Crée la table `member_allocations` puis auto-crée pour chaque
 * membership encore sans allocation une période 100 % couvrant l'intervalle
 * utile des tâches existantes du collab sur ce projet.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function ensureMemberAllocationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS member_allocations (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL,
      collaborator_id TEXT NOT NULL,
      start_date      TEXT NOT NULL,
      end_date        TEXT NOT NULL,
      allocation_pct  INTEGER NOT NULL,
      FOREIGN KEY (project_id, collaborator_id)
        REFERENCES project_members(project_id, collaborator_id)
        ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_member_allocations_lookup
      ON member_allocations(project_id, collaborator_id);
  `)
  const orphans = db
    .prepare(
      `SELECT m.project_id, m.collaborator_id
         FROM project_members m
         WHERE NOT EXISTS (
           SELECT 1 FROM member_allocations a
             WHERE a.project_id = m.project_id
               AND a.collaborator_id = m.collaborator_id
         )`,
    )
    .all()
  if (orphans.length === 0) return
  const tasksRange = db.prepare(
    `SELECT MIN(start_date) AS minS, MAX(end_date) AS maxE
       FROM tasks
       WHERE project_id = ? AND collaborator_id = ?`,
  )
  const projectRange = db.prepare(
    `SELECT MIN(start_date) AS minS, MAX(end_date) AS maxE
       FROM tasks
       WHERE project_id = ?`,
  )
  const ins = db.prepare(
    `INSERT INTO member_allocations
       (id, project_id, collaborator_id, start_date, end_date, allocation_pct)
       VALUES (?, ?, ?, ?, ?, 100)`,
  )
  let inserted = 0
  for (const m of orphans) {
    let r = tasksRange.get(m.project_id, m.collaborator_id)
    if (!r.minS || !r.maxE) {
      r = projectRange.get(m.project_id)
    }
    const start = r.minS || '2020-01-01'
    const end = r.maxE || '2099-12-31'
    const id = `auto_${m.project_id}_${m.collaborator_id}`
    ins.run(id, m.project_id, m.collaborator_id, start, end)
    inserted++
  }
  console.log(
    `[INIT] Migration v2.0 / F2 : ${inserted} allocation(s) 100 % auto-créée(s) pour les memberships existantes.`,
  )
}

/**
 * v2.0 / F3 — Crée la table `collaborator_absences` (cross-projet). Pas
 * d'auto-population : donnée entièrement nouvelle saisie par l'utilisateur.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function ensureCollaboratorAbsencesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collaborator_absences (
      collaborator_id TEXT NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
      date            TEXT NOT NULL,
      fraction        REAL NOT NULL,
      PRIMARY KEY (collaborator_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_collaborator_absences_date
      ON collaborator_absences(date);
  `)
}

/**
 * v2.0 / F6 — Crée la table `task_assignments` (multi-collab) + auto-peuple
 * depuis tasks.collaborator_id. Le champ legacy reste alimenté en miroir
 * (= 1er affecté par ordre alpha) pour ne pas casser les lecteurs externes.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function ensureTaskAssignmentsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_assignments (
      task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      collaborator_id TEXT NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, collaborator_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_assignments_collab
      ON task_assignments(collaborator_id);
  `)
  const rows = db
    .prepare(
      `SELECT t.id, t.collaborator_id
         FROM tasks t
         WHERE t.kind = 'task'
           AND t.collaborator_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM task_assignments a
              WHERE a.task_id = t.id AND a.collaborator_id = t.collaborator_id
           )`,
    )
    .all()
  if (rows.length === 0) return
  const ins = db.prepare(
    `INSERT OR IGNORE INTO task_assignments(task_id, collaborator_id) VALUES (?, ?)`,
  )
  for (const r of rows) ins.run(r.id, r.collaborator_id)
  console.log(
    `[INIT] Migration v2.0 / F6 : ${rows.length} affectation(s) tâche↔collab migrée(s) vers task_assignments.`,
  )
}

/**
 * v2.3 / RG-GANTT-2000 — Ajoute la colonne `project_start_date` sur `projects`
 * si elle manque (base d'avant la v2.3), puis initialise sa valeur pour les
 * projets existants à `MIN(start_date)` de leurs tâches (ou `today` si le
 * projet est vide). Cette stratégie garantit qu'aucune `project_start_date`
 * n'est postérieure à une tâche existante — RG-GANTT-2010 ne peut pas être
 * violée par la migration elle-même.
 *
 * Idempotente : si la colonne existe déjà, aucune écriture n'est faite (le
 * DEFAULT et l'UPDATE sont gardés derrière le check de présence).
 *
 * @param {import('better-sqlite3').Database} db
 */
export function ensureProjectStartDateColumn(db) {
  const cols = db
    .prepare(`PRAGMA table_info(projects)`)
    .all()
    .map((c) => c.name)
  if (cols.includes('project_start_date')) return
  // ALTER TABLE avec DEFAULT pour ne pas violer NOT NULL sur les lignes
  // existantes. La vraie valeur est ensuite calculée par projet.
  db.exec(
    `ALTER TABLE projects ADD COLUMN project_start_date TEXT NOT NULL DEFAULT '2026-01-01'`,
  )
  // Initialisation par projet : MIN(tasks.start_date) si le projet a des
  // tâches, sinon today (format ISO YYYY-MM-DD).
  const todayIso = new Date().toISOString().slice(0, 10)
  const projects = db.prepare(`SELECT id FROM projects`).all()
  const upd = db.prepare(
    `UPDATE projects SET project_start_date = ? WHERE id = ?`,
  )
  const minStart = db.prepare(
    `SELECT MIN(start_date) AS d FROM tasks WHERE project_id = ?`,
  )
  let migrated = 0
  for (const p of projects) {
    const row = minStart.get(p.id)
    const start = row?.d || todayIso
    upd.run(start, p.id)
    migrated++
  }
  if (migrated > 0) {
    console.log(
      `[INIT] Migration v2.3 (RG-GANTT-2000) : ${migrated} projet(s) → project_start_date initialisée depuis MIN(tasks.start_date) (ou today si vide).`,
    )
  }
}
