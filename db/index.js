// =============================================================================
// COUCHE D'ACCÈS BASE DE DONNÉES (DAL) — Gantt v1
// =============================================================================
// Toutes les fonctions exportées prennent en premier paramètre la base SQLite
// (`better-sqlite3`). Elles sont synchrones (better-sqlite3 l'est par design)
// et 100 % testables avec une base en mémoire (`new Database(':memory:')`).
//
// Conventions :
//   • Toute mutation incrémente `meta.version` et renvoie `{ version, ... }`.
//   • Les écritures multiples sont enveloppées dans des transactions pour
//     garantir l'atomicité ET améliorer les performances.
//   • Le mode WAL est activé au boot pour autoriser des lectures concurrentes
//     pendant qu'une écriture est en cours (cf. `initDb`).
// =============================================================================

import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = path.join(__dirname, 'schema.sql')

/**
 * Ouvre (ou crée) la base SQLite passée en paramètre, applique le schéma et
 * configure le mode WAL pour la concurrence.
 *
 * @param {string} dbPath  Chemin de la base sur disque, ou ':memory:' pour les tests.
 * @returns {import('better-sqlite3').Database}  Instance prête à l'emploi.
 */
export function initDb(dbPath) {
  const db = new Database(dbPath)
  // WAL = Write-Ahead Logging : permet d'avoir plusieurs lecteurs et UN
  // écrivain en parallèle, là où le mode "rollback journal" sérialise tout.
  db.pragma('journal_mode = WAL')
  // Active la vérification des contraintes FOREIGN KEY (désactivée par défaut
  // dans SQLite pour des raisons historiques).
  db.pragma('foreign_keys = ON')

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8')
  db.exec(schema)

  // v1.2 — Migration idempotente : ajoute predecessor_id si la table tasks
  // a été créée avant cette version (base existante d'avant la v1.2).
  ensureTaskColumns(db)

  // v1.6 — Si la table tasks a encore l'ancien CHECK qui interdit
  // kind='phase', on la reconstruit (sinon les insert phase plantent).
  ensureKindAcceptsPhase(db)

  // v1.8 — Crée la colonne project_id si elle manque (base d'avant la v1.8)
  // et rattache toutes les tâches orphelines au projet "Projet 1" (créé à la
  // volée s'il n'existe pas encore).
  ensureProjectsMigration(db)

  // v1.21 — Crée la table task_predecessors (N:M tasks ↔ prédécesseurs) si
  // elle n'existe pas, puis migre une fois pour toutes les anciennes liaisons
  // mono-prédécesseur (`tasks.predecessor_id`) vers la nouvelle table.
  ensureTaskPredecessorsTable(db)

  // v2.0 — Ajoute la colonne `charge_jours` sur `tasks` si elle manque, puis
  // initialise sa valeur depuis l'écart actuel (workingDaysBetween) pour
  // chaque activité existante. Bascule le modèle vers "charge = source de
  // vérité, end_date = dérivée".
  ensureChargeColumn(db)

  // v2.0 / F1 — Crée la table `project_members` si elle n'existe pas, puis
  // auto-peuple les memberships à partir des affectations de tâches existantes
  // (chaque couple (project_id, collaborator_id) trouvé dans `tasks` devient
  // une ligne). Stratégie validée avec l'utilisateur : on ne casse aucune
  // affectation existante au premier boot v2.0.
  ensureProjectMembersTable(db)

  // v2.0 / F2 — Crée la table `member_allocations` puis auto-crée une période
  // 100 % couvrant [MIN(task.start_date), MAX(task.end_date)] pour chaque
  // membership encore sans allocation (cohérent avec la décision utilisateur :
  // « couvrant tout l'intervalle utile des tâches existantes »).
  ensureMemberAllocationsTable(db)

  // Initialise la version à 0 si la ligne meta n'existe pas encore.
  db.prepare(
    `INSERT OR IGNORE INTO meta(key, value) VALUES ('version', '0')`,
  ).run()

  return db
}

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
function ensureProjectsMigration(db) {
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
function ensureTaskColumns(db) {
  const cols = db
    .prepare(`PRAGMA table_info(tasks)`)
    .all()
    .map((c) => c.name)
  if (!cols.includes('predecessor_id')) {
    // SQLite ne permet pas d'ajouter une colonne FK avec REFERENCES dans
    // ALTER TABLE, mais on peut référencer logiquement (pas de contrainte
    // FK forte ; on accepte ce compromis pour rester sans recréer la table).
    db.exec(`ALTER TABLE tasks ADD COLUMN predecessor_id TEXT`)
  }
  // v1.10 — Délai en jours ouvrés entre le prédécesseur et la tâche.
  // Sur une base ancienne (sans la colonne), on l'ajoute ET on initialise
  // chaque tâche ayant un prédécesseur avec son écart courant pour ne pas
  // « ramener » brusquement Y contre la fin de X au prochain update.
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
      // lag = nombre de jours ouvrés entre la fin du prédécesseur et le
      // début de cette tâche, exclus de part et d'autre.
      //   workingDaysBetween est INCLUSIF aux deux bornes → on retire 1
      //   pour transformer en "nombre de jours ouvrés strictement entre".
      //   Borné ≥ 0 (cas où Y.start <= X.end : on considère lag=0).
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
  // v1.18 — Priorité facultative (1..5, NULL par défaut). Colonne ajoutée
  // par migration ALTER TABLE sur les bases d'avant la v1.18 ; les tâches
  // existantes héritent de NULL (= "pas de priorité"), comportement identique
  // au défaut nouvellement seedé.
  if (!cols.includes('priority')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN priority INTEGER`)
  }
  // v1.24 — Contrainte SNET « Ne doit pas démarrer avant le ». Ajoutée en
  // ALTER TABLE sur les bases d'avant la v1.24 ; valeur NULL par défaut
  // (= pas de contrainte) — comportement identique au défaut nouvellement
  // seedé. Aucune valeur résiduelle à nettoyer puisque la colonne est neuve.
  if (!cols.includes('not_before_date')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN not_before_date TEXT`)
  }
  // v1.24 — Règle métier Pr2 : la priorité est désormais OBLIGATOIRE sur
  // toute activité (valeur par défaut = 3). Inversement, un jalon ou une
  // phase n'a plus de priorité du tout. Migration idempotente au boot :
  //   • activités sans priorité saisie → priorité 3,
  //   • jalons et phases avec priorité résiduelle → effacés.
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

  // v1.24 — Règle SNET : une phase n'a jamais de date de démarrage au plus tôt « ne doit pas
  // démarrer avant le » (ses dates sont une synthèse de ses enfants). On
  // efface toute valeur résiduelle si la colonne existait déjà avec des
  // données invalides.
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

  // v1.24 — Règle métier J3 : un jalon n'a pas de collaborateur affecté
  // (comme une phase). Nettoyage idempotent au boot : on efface toute
  // affectation résiduelle posée par une version antérieure ou par un
  // appel API externe (ex. anciens scripts de seed).
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
  // Création de l'index APRÈS s'être assuré que la colonne existe.
  // `IF NOT EXISTS` rend l'opération idempotente (base neuve OU migrée).
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tasks_predecessor ON tasks(predecessor_id)`,
  )
}

/**
 * v1.6 — Migration : si la définition SQL de `tasks` contient encore
 * l'ancien CHECK qui n'autorisait que ('task', 'milestone'), reconstruit
 * la table SANS ce CHECK pour que kind='phase' devienne valide.
 *
 * SQLite ne permet pas de modifier un CHECK in-place ; on doit recréer
 * la table puis y recopier les données. L'opération est faite dans une
 * transaction implicite par `db.exec()`.
 *
 * @param {import('better-sqlite3').Database} db
 */
function ensureKindAcceptsPhase(db) {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`,
    )
    .get()
  const sql = row?.sql || ''
  // Détecte précisément l'ancien check restrictif (avec ou sans espaces).
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
      -- v1.10 — colonne préservée lors de la migration depuis l'ancien CHECK.
      predecessor_lag INTEGER NOT NULL DEFAULT 0,
      -- v1.18 — priorité facultative, préservée lors de la migration.
      priority        INTEGER,
      -- v1.24 — date de démarrage au plus tôt SNET, préservée lors de la migration.
      not_before_date TEXT,
      position        INTEGER NOT NULL,
      CHECK (progress BETWEEN 0 AND 100)
    );
    INSERT INTO tasks_new
      (id, name, kind, start_date, end_date, progress,
       collaborator_id, color, parent_id, predecessor_id, predecessor_lag,
       priority, not_before_date, position)
    SELECT
       id, name, kind, start_date, end_date, progress,
       collaborator_id, color, parent_id, predecessor_id, predecessor_lag,
       priority, not_before_date, position
    FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE tasks_new RENAME TO tasks;
    CREATE INDEX IF NOT EXISTS idx_tasks_collab      ON tasks(collaborator_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent      ON tasks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_predecessor ON tasks(predecessor_id);
  `)
}

/**
 * v1.21 — Migration idempotente : crée la table `task_predecessors` si elle
 * n'existe pas, puis migre les anciennes liaisons mono-prédécesseur de la
 * colonne `tasks.predecessor_id` vers la nouvelle table N:M.
 *
 * Comportement :
 *   1. CREATE TABLE IF NOT EXISTS + index (sûr à rejouer).
 *   2. Pour chaque tâche `t` avec `t.predecessor_id` non-null pointant vers
 *      une tâche existante ET sans ligne correspondante dans
 *      `task_predecessors`, insère `(t.id, t.predecessor_id, t.predecessor_lag)`.
 *   3. Les colonnes `predecessor_id` / `predecessor_lag` sur `tasks` sont
 *      conservées pour ne pas casser les bases anciennes mais ne sont plus
 *      lues ni écrites par le code v1.21+ — la source de vérité est désormais
 *      la table `task_predecessors`.
 *
 * @param {import('better-sqlite3').Database} db
 */
function ensureTaskPredecessorsTable(db) {
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
  // Pas de colonne `predecessor_id` (base ultra-ancienne) → rien à migrer.
  const cols = db
    .prepare(`PRAGMA table_info(tasks)`)
    .all()
    .map((c) => c.name)
  if (!cols.includes('predecessor_id')) return
  // Lignes à migrer : tâche avec un prédécesseur valide (la cible existe) et
  // qui n'a PAS déjà été migrée (pas de ligne dans task_predecessors).
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
 * v2.0 — Migration idempotente : ajoute la colonne `charge_jours` sur `tasks`
 * si elle manque, puis l'initialise pour chaque activité existante depuis
 * l'écart courant (workingDaysBetween) entre start_date et end_date.
 *
 * Stratégie « charge = source de vérité » :
 *   • activités (`kind='task'`) → charge = workingDaysBetween(start, end) (≥ 1)
 *   • jalons et phases → NULL (pas de notion de charge)
 *
 * Sûr à rejouer : si la colonne existe et que toutes les activités ont déjà
 * une valeur cohérente, l'opération est silencieuse.
 *
 * @param {import('better-sqlite3').Database} db
 */
function ensureChargeColumn(db) {
  const cols = db
    .prepare(`PRAGMA table_info(tasks)`)
    .all()
    .map((c) => c.name)
  if (!cols.includes('charge_jours')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN charge_jours INTEGER`)
  }
  // Initialise charge_jours pour toutes les ACTIVITÉS qui n'en ont pas encore
  // (NULL = colonne fraîchement ajoutée OU activité créée par une route ne
  // gérant pas encore le champ). On reconstitue la charge depuis l'écart
  // existant pour ne pas modifier les dates affichées à l'utilisateur.
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
  // Nettoyage : jalons / phases ne portent jamais de charge.
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
 * v2.0 / F1 — Migration idempotente : crée la table `project_members` si
 * elle n'existe pas, puis auto-peuple les memberships manquantes depuis les
 * affectations de tâches existantes.
 *
 * Stratégie d'auto-population (option α validée avec l'utilisateur) :
 *   • Pour chaque couple (project_id, collaborator_id) trouvé dans `tasks`
 *     ET non encore présent dans `project_members`, on insère une ligne.
 *   • Aucune membership n'est jamais retirée automatiquement (un collab qui
 *     était membre mais n'a plus de tâche reste membre).
 *
 * Sûre à rejouer : `INSERT OR IGNORE` garantit qu'on n'écrase pas les
 * memberships saisies manuellement après la migration.
 *
 * @param {import('better-sqlite3').Database} db
 */
function ensureProjectMembersTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_members (
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      collaborator_id TEXT NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
      PRIMARY KEY (project_id, collaborator_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_members_collab
      ON project_members(collaborator_id);
  `)
  // Auto-pop : on lit toutes les paires distinctes (project_id, collaborator_id)
  // des tâches avec un collab non-null, et on insère celles qui manquent dans
  // project_members. INSERT OR IGNORE = no-op si la ligne existe déjà.
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
 * v2.0 / F2 — Migration idempotente : crée la table `member_allocations` si
 * elle n'existe pas, puis auto-crée pour chaque membership encore sans
 * allocation une période 100 % couvrant l'intervalle utile des tâches
 * existantes du collab sur ce projet.
 *
 * Stratégie d'auto-pop :
 *   • Pour chaque (project_id, collab_id) ∈ project_members :
 *     - si une allocation existe déjà → no-op (l'utilisateur ou un précédent
 *       boot l'a déjà créée),
 *     - sinon on calcule [MIN(task.start_date), MAX(task.end_date)] des
 *       tâches existantes (project_id, collab_id) et on insère une période
 *       100 % sur cette plage,
 *     - s'il n'y a aucune tâche (cas très rare), on retombe sur le projet
 *       [MIN(task.start_date), MAX(task.end_date)] tout collabs confondus,
 *     - s'il n'y a vraiment aucune tâche du tout, on insère une période à
 *       100 % sur une plage par défaut très large (2020-01-01 → 2099-12-31).
 *       L'utilisateur pourra ajuster ensuite.
 *
 * @param {import('better-sqlite3').Database} db
 */
function ensureMemberAllocationsTable(db) {
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
  // Liste les memberships sans aucune allocation existante.
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
    // Range 1 : tâches du couple (project, collab).
    let r = tasksRange.get(m.project_id, m.collaborator_id)
    if (!r.minS || !r.maxE) {
      // Range 2 : toutes tâches du projet (au cas où le collab n'a aucune
      // tâche affectée — par ex. membership ajoutée manuellement).
      r = projectRange.get(m.project_id)
    }
    const start = r.minS || '2020-01-01'
    const end = r.maxE || '2099-12-31'
    // Surrogate id stable et déterministe par couple (project, collab) pour
    // garantir l'idempotence si la migration est rejouée (rare mais possible
    // si le user vide member_allocations à la main).
    const id = `auto_${m.project_id}_${m.collaborator_id}`
    ins.run(id, m.project_id, m.collaborator_id, start, end)
    inserted++
  }
  console.log(
    `[INIT] Migration v2.0 / F2 : ${inserted} allocation(s) 100 % auto-créée(s) pour les memberships existantes.`,
  )
}

/**
 * v1.21 — Lit tous les prédécesseurs d'une tâche, triés par id pour un ordre
 * déterministe (utile pour les tests et l'affichage des flèches).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} taskId
 * @returns {Array<{id:string, lag:number}>}
 */
function listPredecessorsForTask(db, taskId) {
  return db
    .prepare(
      `SELECT predecessor_id AS id, lag
         FROM task_predecessors
         WHERE task_id = ?
         ORDER BY predecessor_id ASC`,
    )
    .all(taskId)
}

/**
 * v1.21 — Remplace ATOMIQUEMENT la liste des prédécesseurs d'une tâche.
 * Les entrées invalides (auto-référence, lag négatif) sont nettoyées.
 * Les doublons sur `predecessor_id` sont silencieusement fusionnés (1ʳᵉ entrée
 * conservée) grâce à la PRIMARY KEY composite.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} taskId
 * @param {Array<{id:string, lag?:number}>} list
 */
function setPredecessorsForTask(db, taskId, list) {
  db.prepare(`DELETE FROM task_predecessors WHERE task_id = ?`).run(taskId)
  if (!Array.isArray(list) || list.length === 0) return
  const ins = db.prepare(
    `INSERT OR IGNORE INTO task_predecessors(task_id, predecessor_id, lag) VALUES (?, ?, ?)`,
  )
  for (const p of list) {
    if (!p || typeof p.id !== 'string') continue
    if (p.id === taskId) continue // anti-auto-référence
    // Anti-cycle indirect : on rejette silencieusement le lien si l'ajout
    // refermerait une boucle (A→B→C, refus de C→A). La validation amont
    // (UI / Zod) devrait empêcher d'en arriver là — c'est une garde de
    // dernière ligne pour préserver l'invariant DAG.
    if (wouldCreateCycle(db, taskId, p.id)) continue
    // Le prédécesseur doit exister. On lance une erreur explicite (la route
    // API la convertit en 400) au lieu de laisser SQLite échouer sur la FK :
    // cohérent avec le comportement legacy (v1.20-).
    const exists = db.prepare(`SELECT 1 FROM tasks WHERE id = ?`).get(p.id)
    if (!exists) {
      const err = new Error(`Predecessor not found: ${p.id}`)
      err.code = 'PREDECESSOR_NOT_FOUND'
      throw err
    }
    const lag = Math.max(0, Math.floor(Number(p.lag) || 0))
    ins.run(taskId, p.id, lag)
  }
}

/**
 * v1.21 — Synchronise la table `task_predecessors` pour une tâche selon le
 * patch reçu. Extrait de `updateTask` pour limiter sa complexité cognitive
 * (cf. eslint sonarjs/cognitive-complexity).
 *
 * Cas gérés (par ordre de priorité) :
 *   1. Phase : la liste est toujours vidée.
 *   2. `patch.predecessors` (nouveau format) OU `patch.predecessor_id`
 *      non-null (legacy) → la liste est remplacée.
 *   3. `patch.predecessor_id === null` explicitement (legacy : retrait) →
 *      la liste est vidée.
 *   4. `patch.predecessor_lag` seul (legacy mono-pred : ajustement du lag) →
 *      le lag de toutes les entrées existantes est mis à jour.
 *   5. Aucun des cas ci-dessus → no-op (la liste courante est préservée).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} taskId
 * @param {string} kind   Type final de la tâche (après application du patch).
 * @param {object} patch
 */
function syncPredecessorsFromPatch(db, taskId, kind, patch) {
  if (kind === 'phase') {
    setPredecessorsForTask(db, taskId, [])
    return
  }
  const predecessorsInPatch = resolvePredecessorsInput(patch)
  if (predecessorsInPatch !== null) {
    setPredecessorsForTask(db, taskId, predecessorsInPatch)
    return
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, 'predecessor_id') &&
    patch.predecessor_id === null
  ) {
    setPredecessorsForTask(db, taskId, [])
    return
  }
  if (patch.predecessor_lag !== undefined) {
    const newLag = Math.max(0, Math.floor(Number(patch.predecessor_lag) || 0))
    const existing = listPredecessorsForTask(db, taskId)
    if (existing.length > 0) {
      setPredecessorsForTask(
        db,
        taskId,
        existing.map((p) => ({ id: p.id, lag: newLag })),
      )
    }
  }
}

/**
 * v1.21 — Compat-shim : convertit le format historique `predecessor_id` /
 * `predecessor_lag` en `predecessors: [{id, lag}]`. Si l'input fournit déjà
 * un tableau `predecessors`, il est renvoyé tel quel (priorité au nouveau
 * format). Sinon, on construit un tableau à un seul élément à partir de
 * l'ancien champ (s'il est non-null). Renvoie `null` si aucun prédécesseur
 * n'est exprimé (le DAL traite null comme « ne touche pas à la liste »).
 *
 * @param {{predecessors?:Array, predecessor_id?:string|null, predecessor_lag?:number}} input
 * @returns {Array<{id:string, lag:number}>|null}
 */
function resolvePredecessorsInput(input) {
  if (Array.isArray(input.predecessors)) {
    return input.predecessors
      .filter((p) => p && typeof p.id === 'string')
      .map((p) => ({
        id: p.id,
        lag: Math.max(0, Math.floor(Number(p.lag) || 0)),
      }))
  }
  if (input.predecessor_id) {
    return [
      {
        id: input.predecessor_id,
        lag: Math.max(0, Math.floor(Number(input.predecessor_lag) || 0)),
      },
    ]
  }
  return null
}

/**
 * v1.21 — Détecte si l'ajout d'un lien `taskId ← candidateId` créerait un
 * cycle dans le graphe des prédécesseurs. Utilisé en garde dans `setPredecessorsForTask`
 * et au moment de la validation côté serveur. Algorithme : DFS depuis taskId
 * en SUIVANT les arêtes "successeurs" (= arêtes inverses du graphe pred→succ).
 * Si on retombe sur candidateId, c'est un cycle.
 *
 * Anti-cycle indirect : A→B→C, on refuse C→A car DFS depuis C atteint A.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} taskId       Tâche qui va recevoir un prédécesseur.
 * @param {string} candidateId  Tâche candidate comme prédécesseur.
 * @returns {boolean}           true si l'ajout créerait un cycle.
 */
function wouldCreateCycle(db, taskId, candidateId) {
  if (taskId === candidateId) return true
  // On regarde si `taskId` est (transitivement) un prédécesseur de candidateId :
  // si oui, alors ajouter candidateId → taskId fermerait la boucle.
  const stmt = db.prepare(
    `SELECT predecessor_id FROM task_predecessors WHERE task_id = ?`,
  )
  const seen = new Set()
  const queue = [candidateId]
  while (queue.length > 0) {
    const cur = queue.shift()
    if (seen.has(cur)) continue
    seen.add(cur)
    if (cur === taskId) return true
    for (const row of stmt.all(cur)) {
      queue.push(row.predecessor_id)
    }
  }
  return false
}

/**
 * Lit la version courante de l'état (entier monotone, incrémenté à chaque
 * mutation). Utilisée côté client pour détecter les changements en polling.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getVersion(db) {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'version'`).get()
  return row ? Number(row.value) : 0
}

/**
 * Incrémente la version et renvoie la nouvelle valeur. À appeler à la fin
 * de chaque mutation (de préférence dans la même transaction que l'écriture).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
function bumpVersion(db) {
  const next = getVersion(db) + 1
  db.prepare(`UPDATE meta SET value = ? WHERE key = 'version'`).run(
    String(next),
  )
  return next
}

// -----------------------------------------------------------------------------
// LECTURE — état complet
// -----------------------------------------------------------------------------

/**
 * Renvoie l'état complet du Gantt pour UN projet donné. Les tâches sont
 * filtrées par project_id. La liste de tous les projets et l'id du projet
 * courant sont aussi retournés pour piloter le sélecteur de projet en haut.
 *
 * Si `projectId` n'est pas fourni (ou ne correspond à aucun projet existant),
 * on retombe sur le premier projet par ordre de position (déterministe).
 * Si aucun projet n'existe (base totalement vide), `current_project_id`
 * vaut `null` et `tasks` est un tableau vide.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [projectId]  Id du projet à charger (optionnel).
 * @returns {{
 *   version: number,
 *   current_project_id: string|null,
 *   projects: Array<{id:string, name:string, position:number}>,
 *   collaborators: Array<{id:string,name:string,color:string,position:number}>,
 *   tasks: Array<{
 *     id:string, name:string, kind:'task'|'milestone'|'phase',
 *     start_date:string, end_date:string, progress:number,
 *     collaborator_id:string|null, color:string|null,
 *     parent_id:string|null, predecessor_id:string|null, position:number,
 *     project_id:string
 *   }>
 * }}
 */
export function getFullState(db, projectId) {
  const projects = db
    .prepare(
      `SELECT id, name, position FROM projects ORDER BY position ASC, id ASC`,
    )
    .all()
  const collaborators = db
    .prepare(
      `SELECT id, name, color, position
         FROM collaborators
         ORDER BY position ASC, id ASC`,
    )
    .all()
  // Résout le projet courant : id demandé > premier projet > null si vide.
  let currentId = null
  if (projectId && projects.some((p) => p.id === projectId)) {
    currentId = projectId
  } else if (projects.length > 0) {
    currentId = projects[0].id
  }
  const tasks = currentId
    ? db
        .prepare(
          `SELECT id, name, kind, start_date, end_date, progress,
                  collaborator_id, color, parent_id,
                  priority, not_before_date, charge_jours,
                  position, project_id
             FROM tasks
             WHERE project_id = ?
             ORDER BY position ASC, id ASC`,
        )
        .all(currentId)
    : []
  // v1.21 — Joint les prédécesseurs depuis la table N:M. On fait une seule
  // requête sur le projet courant et on regroupe en mémoire pour éviter N+1.
  const predecessorsByTask = new Map()
  if (currentId) {
    const rows = db
      .prepare(
        `SELECT tp.task_id, tp.predecessor_id, tp.lag
           FROM task_predecessors tp
           JOIN tasks t ON t.id = tp.task_id
           WHERE t.project_id = ?
           ORDER BY tp.predecessor_id ASC`,
      )
      .all(currentId)
    for (const r of rows) {
      if (!predecessorsByTask.has(r.task_id)) {
        predecessorsByTask.set(r.task_id, [])
      }
      predecessorsByTask
        .get(r.task_id)
        .push({ id: r.predecessor_id, lag: r.lag })
    }
  }
  // Attache `predecessors` à chaque tâche (tableau, jamais null/undefined).
  // v1.21 — Pour la rétro-compatibilité des clients/tests v1.20-, on dérive
  // également `predecessor_id` et `predecessor_lag` du 1er prédécesseur
  // (ordre par id ASC, déterministe). Ces alias seront retirés à la v1.22.
  for (const t of tasks) {
    const list = predecessorsByTask.get(t.id) || []
    t.predecessors = list
    t.predecessor_id = list[0]?.id ?? null
    t.predecessor_lag = list[0]?.lag ?? 0
  }
  // v2.0 / F1 — Liste des collaborateurs membres du projet courant (utilisée
  // côté client pour filtrer la dropdown du TaskEditor et alimenter l'onglet
  // « Affectation projet »). Vide si aucun projet courant.
  const currentProjectMembers = currentId
    ? listProjectMembers(db, currentId)
    : []
  // v2.0 / F2 — Périodes d'allocation du projet courant (toutes paires
  // collab/période confondues). Le client en a besoin pour le moteur de
  // calcul de fin (computeEndFromCharge), le plan de charge pondéré et
  // l'UI d'édition dans l'onglet « Affectation projet ».
  const memberAllocations = currentId
    ? listMemberAllocations(db, currentId)
    : []
  return {
    version: getVersion(db),
    current_project_id: currentId,
    projects,
    collaborators,
    tasks,
    current_project_members: currentProjectMembers,
    member_allocations: memberAllocations,
  }
}

// -----------------------------------------------------------------------------
// PROJETS (v1.8)
// -----------------------------------------------------------------------------

/**
 * Calcule la prochaine position libre pour un nouveau projet (= MAX + 1).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
function nextProjectPosition(db) {
  const row = db
    .prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM projects`)
    .get()
  return row.m + 1
}

/**
 * Liste tous les projets, ordonnés par position.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{id:string, name:string, position:number}>}
 */
export function listProjects(db) {
  return db
    .prepare(
      `SELECT id, name, position FROM projects ORDER BY position ASC, id ASC`,
    )
    .all()
}

/**
 * Crée un nouveau projet (vide). La position est calculée auto.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{id:string, name:string}} input
 * @returns {{version:number, project:object}}
 */
export function createProject(db, input) {
  const tx = db.transaction(() => {
    const position = nextProjectPosition(db)
    db.prepare(`INSERT INTO projects(id, name, position) VALUES (?, ?, ?)`).run(
      input.id,
      input.name,
      position,
    )
    const version = bumpVersion(db)
    const project = db
      .prepare(`SELECT * FROM projects WHERE id = ?`)
      .get(input.id)
    return { version, project }
  })
  return tx()
}

/**
 * Renomme un projet (le seul champ éditable pour l'instant).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {{name?:string}} patch
 * @returns {{version:number, changed:boolean}}
 */
export function updateProject(db, id, patch) {
  const tx = db.transaction(() => {
    const current = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id)
    if (!current) return { version: getVersion(db), changed: false }
    const name = patch.name ?? current.name
    db.prepare(`UPDATE projects SET name = ? WHERE id = ?`).run(name, id)
    const version = bumpVersion(db)
    return { version, changed: true }
  })
  return tx()
}

/**
 * Supprime un projet et toutes ses tâches (cascade FK).
 *
 * v1.24 — Règle RG-GANTT-1106 : la suppression du DERNIER projet est désormais
 * AUTORISÉE. Si l'utilisateur supprime tous les projets, la base devient
 * vide ; `getFullState` retournera alors `current_project_id = null` et
 * `tasks = []`. L'utilisateur pourra créer un nouveau projet à tout moment.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {{version:number, changed:boolean}}
 */
export function deleteProject(db, id) {
  const tx = db.transaction(() => {
    const info = db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
    if (info.changes === 0) return { version: getVersion(db), changed: false }
    const version = bumpVersion(db)
    return { version, changed: true }
  })
  return tx()
}

// -----------------------------------------------------------------------------
// COLLABORATEURS
// -----------------------------------------------------------------------------

/**
 * Calcule la prochaine position libre pour un nouveau collaborateur
 * (max + 1, ou 0 si la table est vide).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
function nextCollabPosition(db) {
  const row = db
    .prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM collaborators`)
    .get()
  return row.m + 1
}

/**
 * Crée un nouveau collaborateur. La position est calculée automatiquement
 * pour aller à la fin de la liste.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{id:string, name:string, color?:string}} input
 * @returns {{version:number, collaborator:object}}
 */
export function createCollaborator(db, input) {
  const tx = db.transaction(() => {
    const position = nextCollabPosition(db)
    db.prepare(
      `INSERT INTO collaborators(id, name, color, position)
         VALUES (?, ?, ?, ?)`,
    ).run(input.id, input.name, input.color || '#3b82f6', position)
    const version = bumpVersion(db)
    const collaborator = db
      .prepare(`SELECT * FROM collaborators WHERE id = ?`)
      .get(input.id)
    return { version, collaborator }
  })
  return tx()
}

/**
 * Met à jour le nom et/ou la couleur d'un collaborateur. Champs absents = inchangés.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {{name?:string, color?:string}} patch
 * @returns {{version:number, changed:boolean}}
 */
export function updateCollaborator(db, id, patch) {
  const tx = db.transaction(() => {
    const current = db
      .prepare(`SELECT * FROM collaborators WHERE id = ?`)
      .get(id)
    if (!current) return { version: getVersion(db), changed: false }
    const name = patch.name ?? current.name
    const color = patch.color ?? current.color
    db.prepare(`UPDATE collaborators SET name = ?, color = ? WHERE id = ?`).run(
      name,
      color,
      id,
    )
    const version = bumpVersion(db)
    return { version, changed: true }
  })
  return tx()
}

/**
 * Supprime un collaborateur. Les tâches qui lui étaient affectées sont
 * conservées (collaborator_id passe à NULL grâce à ON DELETE SET NULL).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {{version:number, changed:boolean}}
 */
export function deleteCollaborator(db, id) {
  const tx = db.transaction(() => {
    const info = db.prepare(`DELETE FROM collaborators WHERE id = ?`).run(id)
    if (info.changes === 0) return { version: getVersion(db), changed: false }
    const version = bumpVersion(db)
    return { version, changed: true }
  })
  return tx()
}

// -----------------------------------------------------------------------------
// v2.0 / F1 — MEMBERSHIPS projet ↔ collaborateur
// -----------------------------------------------------------------------------
// Un collab doit être membre d'un projet pour qu'une de ses activités puisse
// lui être affectée. Pas de notion de pourcentage en F1 — c'est F2 qui
// l'apportera via la table `member_allocations`.

/**
 * v2.0 / F1 — Liste les ids des collaborateurs membres d'un projet, triés
 * par leur position d'affichage globale (cohérent avec la dropdown du
 * TaskEditor).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {string[]}  Ids des collabs membres.
 */
export function listProjectMembers(db, projectId) {
  return db
    .prepare(
      `SELECT m.collaborator_id AS id
         FROM project_members m
         JOIN collaborators c ON c.id = m.collaborator_id
         WHERE m.project_id = ?
         ORDER BY c.position ASC, c.id ASC`,
    )
    .all(projectId)
    .map((r) => r.id)
}

/**
 * v2.0 / F1 — Vérifie qu'un collaborateur est membre d'un projet donné.
 * Utilisé en garde dans createTask / updateTask pour interdire l'affectation
 * d'un non-membre (RG-GANTT-1200).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {string} collabId
 * @returns {boolean}
 */
function isProjectMember(db, projectId, collabId) {
  const row = db
    .prepare(
      `SELECT 1 AS x FROM project_members
         WHERE project_id = ? AND collaborator_id = ?`,
    )
    .get(projectId, collabId)
  return !!row
}

/**
 * v2.0 / F1 — Ajoute un collaborateur à l'équipe d'un projet.
 *
 * Validations :
 *   • Le projet doit exister.
 *   • Le collaborateur doit exister.
 *   • Si la membership existe déjà : no-op silencieux (idempotent).
 *
 * Bump de version uniquement si la ligne a effectivement été créée (pour ne
 * pas spammer les clients en polling lors d'un double-clic).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {string} collaboratorId
 * @returns {{version:number, added:boolean}}
 */
export function addProjectMember(db, projectId, collaboratorId) {
  const tx = db.transaction(() => {
    const proj = db
      .prepare(`SELECT 1 AS x FROM projects WHERE id = ?`)
      .get(projectId)
    if (!proj) {
      const err = new Error(`Project not found: ${projectId}`)
      err.code = 'PROJECT_NOT_FOUND'
      throw err
    }
    const col = db
      .prepare(`SELECT 1 AS x FROM collaborators WHERE id = ?`)
      .get(collaboratorId)
    if (!col) {
      const err = new Error(`Collaborator not found: ${collaboratorId}`)
      err.code = 'COLLABORATOR_NOT_FOUND'
      throw err
    }
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO project_members(project_id, collaborator_id) VALUES (?, ?)`,
      )
      .run(projectId, collaboratorId)
    if (info.changes === 0) return { version: getVersion(db), added: false }
    // v2.0 / F2 — Auto-pop d'une allocation 100 % par défaut couvrant une
    // plage très large (2020-01-01 → 2099-12-31). L'utilisateur peut ensuite
    // affiner via l'onglet « Affectation projet ». Cohérent avec :
    //   • la migration `ensureMemberAllocationsTable` (auto-pop des memberships
    //     pré-existantes),
    //   • l'auto-heal `ensureCollabIsMember` (création de tâche affectée à un
    //     collab non encore membre).
    // Sans cette ligne par défaut, un membre fraîchement ajouté aurait 0 % de
    // capacité et toute tâche qui lui serait affectée stagnerait.
    db.prepare(
      `INSERT OR IGNORE INTO member_allocations
         (id, project_id, collaborator_id, start_date, end_date, allocation_pct)
         VALUES (?, ?, ?, '2020-01-01', '2099-12-31', 100)`,
    ).run(`default_${projectId}_${collaboratorId}`, projectId, collaboratorId)
    const version = bumpVersion(db)
    return { version, added: true }
  })
  return tx()
}

// -----------------------------------------------------------------------------
// v2.0 / F2 — ALLOCATIONS (périodes %)
// -----------------------------------------------------------------------------

/** v2.0 / F2 — Paliers d'allocation autorisés (4 valeurs fixées avec l'utilisateur). */
const ALLOWED_ALLOCATION_PCTS = new Set([25, 50, 75, 100])

/**
 * v2.0 / F2 — Liste les allocations d'un projet (toutes paires
 * (collab, période) confondues), triées par collab puis date de début.
 * Si `collaboratorId` est fourni, filtre uniquement ses périodes.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {string} [collaboratorId]  Optionnel : filtre sur un collab précis.
 * @returns {Array<{id:string, project_id:string, collaborator_id:string,
 *                  start_date:string, end_date:string, allocation_pct:number}>}
 */
export function listMemberAllocations(db, projectId, collaboratorId) {
  if (collaboratorId) {
    return db
      .prepare(
        `SELECT id, project_id, collaborator_id, start_date, end_date, allocation_pct
           FROM member_allocations
           WHERE project_id = ? AND collaborator_id = ?
           ORDER BY start_date ASC, id ASC`,
      )
      .all(projectId, collaboratorId)
  }
  return db
    .prepare(
      `SELECT id, project_id, collaborator_id, start_date, end_date, allocation_pct
         FROM member_allocations
         WHERE project_id = ?
         ORDER BY collaborator_id ASC, start_date ASC, id ASC`,
    )
    .all(projectId)
}

/**
 * v2.0 / F2 — Vérifie qu'une période `[start, end]` ne chevauche aucune
 * période existante pour la même paire (project, collab), à l'exclusion
 * éventuelle d'un id à ignorer (utile pour les UPDATE qui ne doivent pas
 * se comparer à eux-mêmes).
 *
 * Deux périodes A et B se chevauchent ssi A.start <= B.end ET B.start <= A.end
 * (en bornes inclusives).
 *
 * @returns {boolean} true s'il y a chevauchement (= rejeter l'insertion).
 */
function hasAllocationOverlap(
  db,
  projectId,
  collaboratorId,
  start,
  end,
  excludeId,
) {
  const stmt = excludeId
    ? db.prepare(
        `SELECT 1 AS x FROM member_allocations
           WHERE project_id = ? AND collaborator_id = ?
             AND id != ?
             AND start_date <= ? AND end_date >= ?
           LIMIT 1`,
      )
    : db.prepare(
        `SELECT 1 AS x FROM member_allocations
           WHERE project_id = ? AND collaborator_id = ?
             AND start_date <= ? AND end_date >= ?
           LIMIT 1`,
      )
  const row = excludeId
    ? stmt.get(projectId, collaboratorId, excludeId, end, start)
    : stmt.get(projectId, collaboratorId, end, start)
  return !!row
}

/**
 * v2.0 / F2 — Ajoute une période d'allocation à l'équipe d'un projet.
 *
 * Validations :
 *   • La membership (project_id, collab_id) doit exister (sinon erreur typée).
 *   • `allocation_pct` doit être ∈ {25, 50, 75, 100}.
 *   • `start_date` ≤ `end_date`.
 *   • Aucun chevauchement avec une période existante (RG-GANTT-1301).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{id?:string, project_id:string, collaborator_id:string,
 *          start_date:string, end_date:string, allocation_pct:number}} input
 * @returns {{version:number, allocation:object}}
 */
export function addMemberAllocation(db, input) {
  const tx = db.transaction(() => {
    if (!isProjectMember(db, input.project_id, input.collaborator_id)) {
      const err = new Error(
        `Not a member: ${input.collaborator_id} in ${input.project_id}`,
      )
      err.code = 'NOT_PROJECT_MEMBER'
      throw err
    }
    if (!ALLOWED_ALLOCATION_PCTS.has(Number(input.allocation_pct))) {
      const err = new Error(
        `allocation_pct must be one of 25,50,75,100 (got ${input.allocation_pct})`,
      )
      err.code = 'INVALID_ALLOCATION_PCT'
      throw err
    }
    if (input.end_date < input.start_date) {
      const err = new Error('end_date must be >= start_date')
      err.code = 'INVALID_DATE_RANGE'
      throw err
    }
    if (
      hasAllocationOverlap(
        db,
        input.project_id,
        input.collaborator_id,
        input.start_date,
        input.end_date,
      )
    ) {
      const err = new Error(
        'Allocation period overlaps an existing one for this member',
      )
      err.code = 'ALLOCATION_OVERLAP'
      throw err
    }
    // v2.0 / F2 — Surrogate id : on accepte une valeur explicite (utile pour
    // les seeds / replay) ou on en génère une via crypto.randomUUID (préfixé
    // `alloc_` pour la lisibilité dans la base).
    const id = input.id || `alloc_${randomUUID()}`
    db.prepare(
      `INSERT INTO member_allocations
         (id, project_id, collaborator_id, start_date, end_date, allocation_pct)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.project_id,
      input.collaborator_id,
      input.start_date,
      input.end_date,
      Number(input.allocation_pct),
    )
    const version = bumpVersion(db)
    const allocation = db
      .prepare(`SELECT * FROM member_allocations WHERE id = ?`)
      .get(id)
    return { version, allocation }
  })
  return tx()
}

/**
 * v2.0 / F2 — Supprime une période d'allocation par son id. No-op si l'id
 * n'existe pas (cohérent avec les autres `delete*` du DAL).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {{version:number, changed:boolean}}
 */
export function deleteMemberAllocation(db, id) {
  const tx = db.transaction(() => {
    const info = db
      .prepare(`DELETE FROM member_allocations WHERE id = ?`)
      .run(id)
    if (info.changes === 0) return { version: getVersion(db), changed: false }
    const version = bumpVersion(db)
    return { version, changed: true }
  })
  return tx()
}

// -----------------------------------------------------------------------------
// v1.9 — DATES OUVRÉES (helpers JS — équivalents de src/lib/utils.ts)
// -----------------------------------------------------------------------------
// Ces helpers sont dupliqués côté serveur pour la CASCADE des successeurs
// après une mise à jour de tâche (cf. propagateToSuccessors). On ne dépend
// pas de date-fns ici : tout est en string ISO YYYY-MM-DD et arithmétique
// simple de Date pour rester self-contained dans le DAL.

/**
 * v1.9 — Indique si une date ISO tombe un week-end (samedi/dimanche),
 * en se basant sur le fuseau LOCAL du serveur (cohérent avec le client).
 *
 * @param {string} iso   YYYY-MM-DD
 * @returns {boolean}
 */
function isWeekendIso(iso) {
  // 'T00:00:00' force une interprétation en heure locale (sans 'Z'),
  // évitant les décalages de fuseau qui pourraient déplacer le jour.
  const dow = new Date(iso + 'T00:00:00').getDay()
  return dow === 0 || dow === 6
}

/**
 * v1.23 — Calcule la date du dimanche de Pâques pour une année donnée
 * (algorithme grégorien anonyme / Meeus-Jones-Butcher). Miroir de
 * `easterSunday` côté client (src/lib/utils.ts).
 *
 * @param {number} year   Année grégorienne.
 * @returns {{month:number, day:number}}  Mois 1-based, jour 1-based.
 */
function easterSundayServer(year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const n = h + l - 7 * m + 114
  return { month: Math.floor(n / 31), day: (n % 31) + 1 }
}

/** Cache des fériés FR par année (calcul à la demande). */
const FRENCH_HOLIDAYS_CACHE_SERVER = new Map()

/**
 * v1.23 — Renvoie un `Set` des dates ISO fériées en France pour une année
 * donnée (8 fixes + 3 mobiles dérivés de Pâques). Miroir de
 * `frenchHolidaysOf` côté client.
 *
 * @param {number} year
 * @returns {Set<string>}
 */
function frenchHolidaysOfServer(year) {
  const cached = FRENCH_HOLIDAYS_CACHE_SERVER.get(year)
  if (cached) return cached
  const pad = (n) => String(n).padStart(2, '0')
  const set = new Set([
    `${year}-01-01`, // Jour de l'An
    `${year}-05-01`, // Fête du Travail
    `${year}-05-08`, // Victoire 1945
    `${year}-07-14`, // Fête nationale
    `${year}-08-15`, // Assomption
    `${year}-11-01`, // Toussaint
    `${year}-11-11`, // Armistice 1918
    `${year}-12-25`, // Noël
  ])
  const e = easterSundayServer(year)
  const easterIso = `${year}-${pad(e.month)}-${pad(e.day)}`
  set.add(addDaysIsoServer(easterIso, 1)) // Lundi de Pâques
  set.add(addDaysIsoServer(easterIso, 39)) // Ascension
  set.add(addDaysIsoServer(easterIso, 50)) // Lundi de Pentecôte
  FRENCH_HOLIDAYS_CACHE_SERVER.set(year, set)
  return set
}

/**
 * v1.23 — Indique si une date ISO tombe un jour férié français.
 *
 * @param {string} iso   YYYY-MM-DD
 * @returns {boolean}
 */
function isFrenchHolidayIso(iso) {
  const year = Number(iso.slice(0, 4))
  return frenchHolidaysOfServer(year).has(iso)
}

/**
 * v1.23 — Prédicat unifié « jour non ouvré » = week-end OU jour férié français.
 *
 * @param {string} iso   YYYY-MM-DD
 * @returns {boolean}
 */
function isNonWorkingDayIso(iso) {
  return isWeekendIso(iso) || isFrenchHolidayIso(iso)
}

/**
 * v1.9 — Avance ou recule une date ISO de N jours calendaires.
 *
 * @param {string} iso    YYYY-MM-DD
 * @param {number} days   Entier (négatif autorisé).
 * @returns {string}      YYYY-MM-DD
 */
function addDaysIsoServer(iso, days) {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + days)
  // toISOString peut décaler le jour si fuseau négatif → on reformate
  // manuellement via getFullYear/getMonth/getDate (locaux).
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/**
 * v1.9 / v1.23 — Si iso est non-ouvré (week-end ou férié français), le
 * pousse au jour ouvré suivant (sinon inchangé).
 *
 * @param {string} iso  YYYY-MM-DD
 * @returns {string}
 */
function snapForwardToWorkingDayServer(iso) {
  let cur = iso
  while (isNonWorkingDayIso(cur)) cur = addDaysIsoServer(cur, 1)
  return cur
}

/**
 * v1.9 / v1.23 — Compte les jours OUVRÉS inclus dans [start, end] (hors
 * week-ends et fériés français).
 *
 * @param {string} start  YYYY-MM-DD
 * @param {string} end    YYYY-MM-DD
 * @returns {number}
 */
function workingDaysBetweenServer(start, end) {
  if (!start || !end || end < start) return 0
  let count = 0
  let cur = start
  while (cur <= end) {
    if (!isNonWorkingDayIso(cur)) count++
    cur = addDaysIsoServer(cur, 1)
  }
  return count
}

/**
 * v1.9 / v1.23 — Ajoute `charge` jours OUVRÉS à partir de start et renvoie
 * la date de fin (incluse). Saute week-ends ET jours fériés français.
 * Cohérent avec `addWorkingDays` côté client.
 *
 * @param {string} start   YYYY-MM-DD
 * @param {number} charge  Nombre de jours ouvrés (≥ 1).
 * @returns {string}       YYYY-MM-DD (fin incluse).
 */
function addWorkingDaysServer(start, charge) {
  if (charge <= 1) return start
  let cur = start
  let count = isNonWorkingDayIso(cur) ? 0 : 1
  while (count < charge) {
    cur = addDaysIsoServer(cur, 1)
    if (!isNonWorkingDayIso(cur)) count++
  }
  return cur
}

/**
 * v1.10 / v1.23 — Calcule la date de début d'un successeur Y à partir de la
 * fin de son prédécesseur X et d'un délai (jours ouvrés).
 *
 * Sémantique : `lag = N` impose N jours ouvrés STRICTEMENT entre `predEnd`
 * et `start` (= minimum d'attente).
 *   • lag = 0 → Y.start = base (= jour ouvré snappé de X.end).
 *   • lag = N ≥ 1 → Y.start = (N+1)-ième jour ouvré STRICTEMENT après X.end.
 *
 * Miroir exact de `computeSuccessorStart` côté client (src/lib/utils.ts).
 *
 * @param {string} predEnd  Date de fin du prédécesseur (YYYY-MM-DD).
 * @param {number} lag      Délai en jours ouvrés (≥ 0).
 * @returns {string}        Date de début du successeur (YYYY-MM-DD).
 */
function computeSuccessorStart(predEnd, lag) {
  const base = snapForwardToWorkingDayServer(predEnd)
  if (lag <= 0) return base
  // v1.23 — `lag + 2` (au lieu de `lag + 1`) : on veut N jours ouvrés
  // STRICTEMENT entre base et start, sans compter base ni start dans le
  // décompte.
  return addWorkingDaysServer(base, lag + 2)
}

// -----------------------------------------------------------------------------
// v1.9 — CASCADE des successeurs
// -----------------------------------------------------------------------------

/**
 * v1.9 — Après modification d'une tâche X (start_date / end_date),
 * propage la nouvelle date de fin à tous ses successeurs Y dont
 * `predecessor_id = X.id` ET dont la date de début se retrouverait
 * AVANT la nouvelle fin de X (= violation de la contrainte de
 * dépendance). On préserve la "charge" (jours ouvrés) de chaque
 * successeur en recalculant son end_date à partir du nouveau start.
 *
 * Si Y.start_date est DÉJÀ ≥ X.end_date (décalage volontaire saisi par
 * l'utilisateur), Y est laissé inchangé : le décalage est conservé.
 *
 * La propagation est itérative et borne les visites (anti-cycle), de
 * sorte qu'une chaîne X → Y → Z → … est traitée en une passe.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} rootId  Id de la tâche dont on vient de modifier les dates.
 */
/**
 * v1.9 — Calcule les nouvelles dates d'un successeur poussé à `targetStart`,
 * en préservant sa charge (jours ouvrés). Extrait pour limiter la complexité
 * cyclomatique de `propagateToSuccessors` (cf. sonarjs/cognitive-complexity).
 *
 * @param {{kind:string, start_date:string, end_date:string}} succ
 * @param {string} targetStart  Nouvelle date de début (jour ouvré).
 * @returns {{newStart:string, newEnd:string}}
 */
function computeShiftedDates(succ, targetStart, db) {
  if (succ.kind === 'milestone') {
    return { newStart: targetStart, newEnd: targetStart }
  }
  // v2.0 — Lit la charge depuis `charge_jours` (source de vérité) ; back-dérive
  // depuis l'écart courant en filet de sécurité (bases anciennes / tests).
  const charge =
    succ.charge_jours && succ.charge_jours >= 1
      ? succ.charge_jours
      : Math.max(1, workingDaysBetweenServer(succ.start_date, succ.end_date))
  // v2.0 / F2 — Si `db` est fourni, on utilise le moteur allocation-aware
  // pour préserver la charge ET le rythme du collab. Sinon (chemin legacy
  // sans contexte d'allocation), on retombe sur addWorkingDaysServer pur.
  const newEnd = db
    ? addWorkingDaysWithAllocationServer(
        db,
        targetStart,
        charge,
        succ.project_id,
        succ.collaborator_id,
      )
    : addWorkingDaysServer(targetStart, charge)
  return { newStart: targetStart, newEnd }
}

/**
 * v1.21 — Calcule la borne basse de la date de début d'une tâche en agrégeant
 * tous ses prédécesseurs : `MAX(pred.end + lag)` (règle PERT). Renvoie `null`
 * si la tâche n'a aucun prédécesseur (ou que tous ses prédécesseurs ont été
 * supprimés entre-temps).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} taskId
 * @returns {string|null}  Date 'YYYY-MM-DD' ou null.
 */
function computeMinStartFromPredecessors(db, taskId) {
  const preds = listPredecessorsForTask(db, taskId)
  if (preds.length === 0) return null
  const placeholders = preds.map(() => '?').join(',')
  const predRows = db
    .prepare(`SELECT id, end_date FROM tasks WHERE id IN (${placeholders})`)
    .all(...preds.map((p) => p.id))
  const endById = new Map(predRows.map((r) => [r.id, r.end_date]))
  let maxStart = null
  for (const p of preds) {
    const predEnd = endById.get(p.id)
    if (!predEnd) continue
    const candidate = computeSuccessorStart(predEnd, p.lag)
    if (maxStart === null || candidate > maxStart) maxStart = candidate
  }
  return maxStart
}

/**
 * v1.21 — Aligne la date de début d'une tâche sur la borne basse de ses
 * prédécesseurs (MAX sur tous). Le lag est désormais porté par chaque ligne
 * de `task_predecessors` (pas inféré depuis l'écart). Comportement :
 *   • Si la tâche n'a aucun prédécesseur → no-op.
 *   • Si `next.start_date >= MAX(pred.end + lag)` → on respecte la saisie
 *     utilisateur (typique : un Replan a poussé plus loin pour résoudre une
 *     surcharge ; le lag minimum est satisfait, on ne ramène pas en arrière).
 *   • Sinon → on remonte start à la borne basse en préservant la charge en
 *     jours ouvrés.
 *
 * Modifie `next` en place (start_date / end_date).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} current  Tâche AVANT update (lue depuis la base).
 * @param {object} next     Tâche APRÈS application du patch (en cours d'éval).
 */
function reconcilePredecessors(db, current, next) {
  const minStart = computeMinStartFromPredecessors(db, current.id)
  if (minStart === null) return
  if (next.start_date >= minStart) return
  // v2.0 — Préserve la charge stockée plutôt que de la back-dériver depuis
  // l'écart courant (plus juste sémantiquement).
  const charge =
    next.charge_jours && next.charge_jours >= 1
      ? next.charge_jours
      : Math.max(
          1,
          workingDaysBetweenServer(current.start_date, current.end_date),
        )
  next.start_date = minStart
  if (next.kind !== 'milestone') {
    // v2.0 / F2 — Recalcul allocation-aware (cf. addWorkingDaysWithAllocationServer)
    // pour que le décalage induit par un prédécesseur reflète aussi le rythme
    // d'allocation du collab.
    next.end_date = addWorkingDaysWithAllocationServer(
      db,
      minStart,
      charge,
      next.project_id,
      next.collaborator_id,
    )
  }
}

/**
 * v1.10 — Propage les modifications de dates aux successeurs (récursif).
 *
 * Source de vérité : `predecessor_lag`. Pour chaque Y avec
 * `predecessor_id = X.id` :
 *   Y.start_date = computeSuccessorStart(X.end_date, Y.predecessor_lag)
 *
 * Conséquence (v1.10) : si X est RACCOURCI, Y est tiré en arrière (le
 * délai reste constant). Si X est ALLONGÉ, Y est poussé. Plus de
 * "stuck" du successeur quand le prédécesseur réduit sa durée.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} rootId  Id de la tâche dont les dates viennent de changer.
 */
function propagateToSuccessors(db, rootId) {
  // v1.21 — Successeurs récupérés via la table N:M (un succ peut avoir N préds).
  // v2.0 — On ramène charge_jours pour que computeShiftedDates lise la charge
  // depuis la source de vérité au lieu de la back-dériver.
  // v2.0 / F2 — On ramène aussi project_id et collaborator_id pour que le
  // calcul de fin pondérée par l'allocation puisse se faire.
  const fetchSuccessors = db.prepare(
    `SELECT t.id, t.kind, t.start_date, t.end_date, t.parent_id,
            t.charge_jours, t.project_id, t.collaborator_id
       FROM task_predecessors tp
       JOIN tasks t ON t.id = tp.task_id
       WHERE tp.predecessor_id = ?`,
  )
  const updateDates = db.prepare(
    `UPDATE tasks SET start_date = ?, end_date = ? WHERE id = ?`,
  )

  const queue = [rootId]
  const seen = new Set()
  while (queue.length > 0) {
    const curId = queue.shift()
    if (seen.has(curId)) continue
    seen.add(curId)

    for (const succ of fetchSuccessors.all(curId)) {
      // v1.21 — La borne basse de chaque successeur est MAX sur TOUS ses
      // prédécesseurs (pas seulement celui qui vient de bouger). Le lag est
      // toujours traité comme un MINIMUM : si succ.start est déjà ≥ minStart
      // (ex. décalage volontaire saisi par l'utilisateur ou poussée par
      // Replan), on ne ramène pas la tâche en arrière.
      const minStart = computeMinStartFromPredecessors(db, succ.id)
      if (minStart === null) continue
      if (succ.start_date >= minStart) continue
      // v2.0 / F2 — `db` est transmis pour permettre à computeShiftedDates de
      // consommer la capacité réelle du collab (allocations %) lors du push.
      const { newStart, newEnd } = computeShiftedDates(succ, minStart, db)
      if (newStart === succ.start_date && newEnd === succ.end_date) continue
      updateDates.run(newStart, newEnd, succ.id)
      // Propage à la phase parente (les dates de la phase doivent refléter
      // MIN/MAX des enfants).
      recomputeAncestorPhases(db, succ.id)
      // Continue la cascade : les successeurs de succ seront contrôlés à leur tour.
      queue.push(succ.id)
    }
  }
}

// -----------------------------------------------------------------------------
// v1.6 — PHASES : recalcul automatique des dates depuis les enfants
// -----------------------------------------------------------------------------

/**
 * Recalcule les dates de la phase passée en paramètre :
 *   start_date = MIN des start_date de ses enfants directs
 *   end_date   = MAX des end_date  de ses enfants directs
 *
 * Si la phase n'a pas d'enfants, ses dates sont laissées inchangées
 * (pour ne pas écrire NULL dans des colonnes NOT NULL).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} phaseId   Id d'une tâche kind='phase' (les autres sont ignorées).
 */
function recomputePhaseDates(db, phaseId) {
  const phase = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(phaseId)
  if (!phase || phase.kind !== 'phase') return
  const children = db
    .prepare(`SELECT start_date, end_date FROM tasks WHERE parent_id = ?`)
    .all(phaseId)
  if (children.length === 0) return
  let minStart = children[0].start_date
  let maxEnd = children[0].end_date
  for (const c of children) {
    if (c.start_date < minStart) minStart = c.start_date
    if (c.end_date > maxEnd) maxEnd = c.end_date
  }
  if (phase.start_date !== minStart || phase.end_date !== maxEnd) {
    db.prepare(
      `UPDATE tasks SET start_date = ?, end_date = ? WHERE id = ?`,
    ).run(minStart, maxEnd, phaseId)
  }
}

/**
 * Remonte la chaîne des parents d'une tâche et recalcule les dates de
 * chaque ancêtre de type 'phase' rencontré (récursif). Indispensable
 * après tout create/update/delete/move qui peut affecter une phase
 * (directement ou via un descendant transitivement).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string|null} startId   Id de départ (null = no-op).
 */
function recomputeAncestorPhases(db, startId) {
  if (!startId) return
  const stmt = db.prepare(`SELECT id, parent_id, kind FROM tasks WHERE id = ?`)
  let cursor = stmt.get(startId)
  // Sécurité anti-cycle (les phases ne devraient jamais boucler en parent_id,
  // mais on protège quand même pour ne pas geler le serveur).
  const seen = new Set()
  while (cursor?.parent_id && !seen.has(cursor.parent_id)) {
    seen.add(cursor.parent_id)
    const parent = stmt.get(cursor.parent_id)
    if (!parent) break
    if (parent.kind === 'phase') recomputePhaseDates(db, parent.id)
    cursor = parent
  }
}

// -----------------------------------------------------------------------------
// TÂCHES & JALONS
// -----------------------------------------------------------------------------

/**
 * v1.18 / v1.24 — Normalise une valeur de priorité selon le type de tâche.
 *
 * Règle métier Pr2 (v1.24) : la priorité est **obligatoire** sur les activités
 * (kind='task'), avec **3 comme valeur par défaut**. Sur les jalons et les
 * phases, la priorité **n'a pas de sens** et vaut toujours `null`.
 *
 * Toute valeur invalide (NaN, hors-bornes, type incompatible) est remplacée :
 *   • pour une activité → 3 (défaut métier),
 *   • pour un jalon / une phase → null.
 *
 * @param {unknown} raw   Valeur reçue dans le payload.
 * @param {string}  kind  Type de la tâche ('task' | 'milestone' | 'phase').
 * @returns {number|null}
 */
function normalizePriority(raw, kind) {
  if (kind !== 'task') return null
  if (raw === undefined || raw === null) return 3
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 1 || n > 5) return 3
  return n
}

/**
 * v1.24 — Normalise la date de démarrage au plus tôt SNET (« Ne doit pas démarrer avant le »).
 *
 * Règle métier SNET :
 *   • Activités et jalons : valeur facultative au format `YYYY-MM-DD`, ou
 *     `null` quand aucune contrainte.
 *   • Phases : toujours `null` (la phase est une synthèse de ses enfants).
 *   • Toute valeur de format invalide est ignorée (ramenée à `null`) pour
 *     ne jamais corrompre la base, indépendamment de la validation Zod.
 *
 * @param {unknown} raw   Valeur reçue dans le payload.
 * @param {string}  kind  Type de la tâche.
 * @returns {string|null} Date ISO normalisée ou null.
 */
function normalizeNotBeforeDate(raw, kind) {
  if (kind === 'phase') return null
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  return raw
}

/**
 * v2.0 / F1 — S'assure que `collabId` est membre de `projectId` au moment où
 * on l'affecte à une activité. Si la membership n'existe pas encore, elle est
 * créée à la volée (idempotent via `INSERT OR IGNORE`).
 *
 * Pourquoi tolérant côté DAL plutôt que strict ? La contrainte « doit être
 * dans la dropdown » est portée par l'UI (filtrage côté `TaskEditor`).
 * Au niveau du DAL, on reste résilient : un appel direct à l'API ne casse
 * pas le modèle, il enrichit l'équipe du projet — cohérent avec la stratégie
 * d'auto-pop de la migration (option α validée avec l'utilisateur).
 *
 * No-op si `collabId` est null (activité non affectée) ou si `projectId`
 * est null (cas pathologique géré ailleurs).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string|null} collabId
 * @param {string|null} projectId
 */
function ensureCollabIsMember(db, collabId, projectId) {
  if (!collabId || !projectId) return
  if (isProjectMember(db, projectId, collabId)) return
  // Le collab existe-t-il vraiment ? Si non, on ne crée surtout pas une
  // membership orpheline (FK collaborator_id rejetterait de toute façon
  // l'INSERT, mais on évite l'erreur SQL en cassant tôt avec un message clair).
  const col = db
    .prepare(`SELECT 1 AS x FROM collaborators WHERE id = ?`)
    .get(collabId)
  if (!col) return // le DAL en amont rejettera l'affectation à un collab inexistant
  db.prepare(
    `INSERT OR IGNORE INTO project_members(project_id, collaborator_id) VALUES (?, ?)`,
  ).run(projectId, collabId)
  // v2.0 / F2 — Auto-heal complet : on crée aussi une allocation 100 % par
  // défaut couvrant une plage très large, sinon la nouvelle membership aura
  // 0 % de capacité et la tâche fraîchement créée ne pourra pas se calculer.
  // L'utilisateur pourra affiner les périodes/% via l'UI ensuite.
  const existing = db
    .prepare(
      `SELECT 1 AS x FROM member_allocations
         WHERE project_id = ? AND collaborator_id = ? LIMIT 1`,
    )
    .get(projectId, collabId)
  if (!existing) {
    db.prepare(
      `INSERT INTO member_allocations
         (id, project_id, collaborator_id, start_date, end_date, allocation_pct)
         VALUES (?, ?, ?, '2020-01-01', '2099-12-31', 100)`,
    ).run(`autoheal_${projectId}_${collabId}`, projectId, collabId)
  }
}

/**
 * v2.0 / F2 — Lit toutes les allocations d'un couple (projet, collab) triées
 * par date de début, pour usage dans le moteur de calcul de fin serveur.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {string} collabId
 * @returns {Array<{start_date:string, end_date:string, allocation_pct:number}>}
 */
function listAllocationsServer(db, projectId, collabId) {
  return db
    .prepare(
      `SELECT start_date, end_date, allocation_pct
         FROM member_allocations
         WHERE project_id = ? AND collaborator_id = ?
         ORDER BY start_date ASC, id ASC`,
    )
    .all(projectId, collabId)
}

/**
 * v2.0 / F2 — Calcule la fin d'une activité à partir de sa charge et du
 * rythme d'allocation du collab sur le projet (miroir exact de
 * `computeEndFromCharge` côté client).
 *
 * Sans collab affecté OU sans allocation existante → retombe sur l'ancien
 * comportement F0 (`addWorkingDaysServer`).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} startIso  Date de début YYYY-MM-DD.
 * @param {number} charge    Charge en jours ouvrés (≥ 1).
 * @param {string|null} projectId
 * @param {string|null} collabId
 * @returns {string}         Date de fin YYYY-MM-DD (incluse).
 */
function findAllocationPctForDay(allocs, dateIso) {
  // Hypothèse : pas de chevauchement (invariant RG-GANTT-1301), on prend
  // la 1ʳᵉ période qui couvre `dateIso`.
  for (const a of allocs) {
    if (dateIso >= a.start_date && dateIso <= a.end_date)
      return a.allocation_pct
  }
  return 0
}

function addWorkingDaysWithAllocationServer(
  db,
  startIso,
  charge,
  projectId,
  collabId,
) {
  if (!collabId || !projectId) return addWorkingDaysServer(startIso, charge)
  const allocs = listAllocationsServer(db, projectId, collabId)
  if (allocs.length === 0) return addWorkingDaysServer(startIso, charge)
  const needed = Math.max(1, charge)
  let consumed = 0
  let cur = startIso
  let lastWorked = startIso
  const maxScan = Math.max(needed * 30, 10000)
  for (let i = 0; i < maxScan; i++) {
    if (!isNonWorkingDayIso(cur)) {
      const pct = findAllocationPctForDay(allocs, cur)
      if (pct > 0) {
        consumed += pct / 100
        lastWorked = cur
        if (consumed >= needed - 1e-9) return lastWorked
      }
    }
    cur = addDaysIsoServer(cur, 1)
  }
  return lastWorked
}

/**
 * v2.0 — Calcule la charge effective et la date de fin dérivée pour une
 * mutation de tâche, en appliquant la règle « charge = source de vérité ».
 *
 * Politique de réconciliation (par ordre de priorité) :
 *   1. **Jalon** → charge = NULL, end = start (toujours).
 *   2. **Phase** → charge = NULL (les dates sont synthétisées depuis les enfants).
 *   3. **Activité** :
 *      a) si `patch.charge_jours` est fourni → charge = valeur fournie,
 *         end = addWorkingDays(start, charge).
 *      b) sinon si `patch.end_date` est fourni → charge = back-dérivée depuis
 *         (start, end) via workingDaysBetween, end conservé tel quel
 *         (cas du drag bord droit dans le Gantt, Q1 option a).
 *      c) sinon si la charge existante est connue → end = addWorkingDays(start, chargeExistante)
 *         (cas du drag horizontal "move" ou d'un patch qui ne touche que start).
 *      d) sinon (fallback ultime, base très ancienne) → charge = 1, end = start.
 *
 * @param {{kind:string, start_date:string, end_date?:string, charge_jours?:number|null}} next
 *        État courant fusionné (`{...current, ...patch}`) avant écriture.
 * @param {object} patch  Le patch reçu (utilisé pour détecter quelles clés
 *        ont été explicitement fournies par l'appelant).
 * @returns {{charge_jours:number|null, end_date:string}}
 */
function resolveChargeAndEnd(next, patch, db) {
  if (next.kind === 'milestone') {
    return { charge_jours: null, end_date: next.start_date }
  }
  if (next.kind === 'phase') {
    // Une phase n'a pas de charge propre ; sa fin est recalculée depuis ses
    // enfants par `recomputePhaseDates`. On garde l'end_date courante (sera
    // écrasée juste après par la synthèse).
    return { charge_jours: null, end_date: next.end_date || next.start_date }
  }
  // v2.0 / F2 — Helper local : calcule la fin d'une activité depuis sa charge
  // en consommant la capacité quotidienne du collab (allocation %). Si `db`
  // n'est pas fourni (cas exceptionnel) ou si la tâche n'a pas de collab,
  // on retombe sur l'ancien comportement F0.
  const endFromCharge = (start, c) =>
    db
      ? addWorkingDaysWithAllocationServer(
          db,
          start,
          c,
          next.project_id,
          next.collaborator_id,
        )
      : addWorkingDaysServer(start, c)
  const hasExplicitCharge =
    patch &&
    Object.prototype.hasOwnProperty.call(patch, 'charge_jours') &&
    patch.charge_jours !== null &&
    patch.charge_jours !== undefined
  const hasExplicitEnd =
    patch &&
    Object.prototype.hasOwnProperty.call(patch, 'end_date') &&
    patch.end_date
  // Cas 3a : charge explicite gagne.
  if (hasExplicitCharge) {
    const c = Math.max(1, Math.floor(Number(patch.charge_jours)))
    return { charge_jours: c, end_date: endFromCharge(next.start_date, c) }
  }
  // Cas 3b : end_date explicite → back-dérivation de la charge.
  // v2.0 / F2 — La back-dérivation reste basée sur l'écart en jours ouvrés
  // bruts (workingDaysBetween), pas sur la capacité allouée : un drag du
  // bord droit exprime « je veux que ça dure tant de jours-travail »,
  // indépendamment du rythme d'allocation. Cohérent avec Q1 option a.
  if (hasExplicitEnd) {
    const c = Math.max(
      1,
      workingDaysBetweenServer(next.start_date, patch.end_date),
    )
    return { charge_jours: c, end_date: patch.end_date }
  }
  // Cas 3c : charge déjà connue (sur la tâche courante) → on la conserve et
  // recalcule end depuis le start (potentiellement nouveau).
  if (next.charge_jours && next.charge_jours >= 1) {
    return {
      charge_jours: next.charge_jours,
      end_date: endFromCharge(next.start_date, next.charge_jours),
    }
  }
  // Cas 3d : fallback ultime — base très ancienne où ni charge_jours ni end_date
  // ne sont disponibles. On reconstitue depuis l'end_date courante (qui existe
  // forcément en base, NOT NULL), bornée à 1 minimum.
  const fallbackCharge = Math.max(
    1,
    workingDaysBetweenServer(next.start_date, next.end_date || next.start_date),
  )
  return {
    charge_jours: fallbackCharge,
    end_date: endFromCharge(next.start_date, fallbackCharge),
  }
}

/**
 * v1.24 — Applique la contrainte SNET en POUSSANT `start_date` au jour ouvré
 * de la date de démarrage au plus tôt si elle est en deçà. La règle « le plus tardif gagne »
 * est garantie en appelant cette fonction APRÈS la cascade de prédécesseur :
 *   • si `pred.end + lag` > SNET → start déjà au bon endroit, SNET silencieux,
 *   • si SNET > `pred.end + lag` → ici on relève start au niveau de SNET,
 *   • sans prédécesseur → on relève juste start au niveau de SNET.
 *
 * La date de démarrage au plus tôt est snappée au prochain jour ouvré si elle tombe un week-end
 * ou un jour férié (saisie libre côté UI, snap au runtime côté serveur).
 *
 * Mute `next` en place : start_date / end_date (charge en jours ouvrés
 * préservée pour les activités, end = start pour les jalons).
 *
 * @param {object} next  Tâche en cours d'évaluation (kind, start_date, end_date, not_before_date).
 */
function enforceNotBeforeDate(next, db) {
  const snet = normalizeNotBeforeDate(next.not_before_date, next.kind)
  if (!snet) return
  const snapped = snapForwardToWorkingDayServer(snet)
  if (next.start_date >= snapped) return
  // v2.0 — Préserve la charge en jours ouvrés pour les activités. La charge
  // est lue depuis `charge_jours` quand elle existe (source de vérité), avec
  // un filet de sécurité sur l'écart courant pour les patches qui ne
  // l'auraient pas encore positionnée.
  let charge = 0
  if (next.kind !== 'milestone') {
    charge =
      next.charge_jours && next.charge_jours >= 1
        ? next.charge_jours
        : Math.max(1, workingDaysBetweenServer(next.start_date, next.end_date))
  }
  next.start_date = snapped
  // v2.0 / F2 — Recalcul allocation-aware si `db` fourni (chemin nominal). Sinon
  // on retombe sur le calcul jours ouvrés bruts (rétro-compat anciens chemins).
  if (next.kind === 'milestone') {
    next.end_date = snapped
  } else if (db) {
    next.end_date = addWorkingDaysWithAllocationServer(
      db,
      snapped,
      charge,
      next.project_id,
      next.collaborator_id,
    )
  } else {
    next.end_date = addWorkingDaysServer(snapped, charge)
  }
}

/**
 * Calcule la prochaine position libre pour une nouvelle tâche.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
function nextTaskPosition(db) {
  const row = db
    .prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM tasks`)
    .get()
  return row.m + 1
}

/**
 * Crée une tâche, un jalon ou une phase dans un projet donné.
 * Pour un jalon, end_date est forcée à start_date.
 *
 * Si `project_id` n'est pas fourni, on rattache au premier projet existant
 * (filet de sécurité pour les anciens clients ; en pratique le frontend
 * passe toujours l'id du projet courant).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   id:string, name:string, kind?:'task'|'milestone'|'phase',
 *   start_date:string, end_date?:string, progress?:number,
 *   collaborator_id?:string|null, color?:string|null,
 *   parent_id?:string|null, predecessor_id?:string|null,
 *   project_id?:string
 * }} input
 * @returns {{version:number, task:object}}
 */
/**
 * v1.10 — Résout {start_date, predecessor_lag} pour une nouvelle tâche
 * en fonction de la présence (ou non) d'un prédécesseur et d'un délai.
 * Extrait pour limiter la complexité cyclomatique de `createTask`.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} input  Payload de création (cf. createTask).
 * @returns {{startDate:string, lag:number}}
 */
/**
 * v1.21 — Calcule la date de début initiale d'une tâche à partir de la liste
 * fournie de prédécesseurs (règle PERT : MAX(pred.end + lag)). Si la liste
 * est vide ou si aucun prédécesseur n'existe encore dans la base, on respecte
 * `input.start_date`. Si une borne basse calculée dépasse `input.start_date`,
 * on aligne sur la borne (cohérent avec le comportement runtime de
 * `reconcilePredecessors`).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{start_date?:string, kind?:string}} input
 * @param {Array<{id:string, lag:number}>|null} predecessors
 * @returns {string}  Date 'YYYY-MM-DD'.
 */
function resolveCreateStart(db, input, predecessors) {
  const fallback = input.start_date
  if (input.kind === 'phase' || !predecessors || predecessors.length === 0) {
    return fallback
  }
  const ids = predecessors.map((p) => p.id)
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id, end_date FROM tasks WHERE id IN (${placeholders})`)
    .all(...ids)
  const endById = new Map(rows.map((r) => [r.id, r.end_date]))
  let minStart = null
  for (const p of predecessors) {
    const predEnd = endById.get(p.id)
    if (!predEnd) continue
    const cand = computeSuccessorStart(predEnd, p.lag)
    if (minStart === null || cand > minStart) minStart = cand
  }
  if (minStart === null) return fallback
  return fallback && fallback > minStart ? fallback : minStart
}

export function createTask(db, input) {
  const tx = db.transaction(() => {
    const kind = input.kind || 'task'
    // v1.21 — Liste de prédécesseurs (nouveau format) ou conversion depuis
    // l'ancien (`predecessor_id` seul). Pour les phases, toujours vide.
    const predecessors =
      kind === 'phase' ? null : resolvePredecessorsInput(input)
    const startDate = resolveCreateStart(db, input, predecessors)
    // Pour un jalon, on ignore end_date envoyé par le client : un jalon est
    // ponctuel, donc end_date = start_date par construction.
    const endDate =
      kind === 'milestone' ? startDate : input.end_date || startDate
    const position = nextTaskPosition(db)
    // v1.8 — Résout le projet de rattachement : id fourni > premier projet.
    // Si la base ne contient encore aucun projet (cas d'un boot très tôt
    // ou de tests qui créent une tâche sans seed), on crée à la volée le
    // projet par défaut. Comportement cohérent avec la migration v1.8.
    let projectId = input.project_id
    if (!projectId) {
      const first = db
        .prepare(
          `SELECT id FROM projects ORDER BY position ASC, id ASC LIMIT 1`,
        )
        .get()
      if (first) {
        projectId = first.id
      } else {
        db.prepare(
          `INSERT INTO projects(id, name, position) VALUES (?, ?, 0)`,
        ).run(DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME)
        projectId = DEFAULT_PROJECT_ID
      }
    }
    // v2.0 / F1 — Garde : interdit l'affectation d'un collab non membre du
    // projet de la tâche (RG-GANTT-1200). Ne s'applique qu'aux activités —
    // jalons et phases n'ont jamais de collab.
    if (kind === 'task') {
      ensureCollabIsMember(db, input.collaborator_id ?? null, projectId)
    }
    // v1.24 — SNET : on applique la contrainte « ne doit pas démarrer avant le »
    // en dernière étape, après que la cascade prédécesseur a déjà fixé
    // {startDate, endDate}. La règle « plus tardif gagne » est ainsi respectée.
    // v2.0 — La charge devient la source de vérité : on résout d'abord
    // {charge_jours, end_date} via resolveChargeAndEnd, PUIS on applique SNET
    // qui pourra repousser start (et l'end suivra en préservant la charge).
    // v2.0 / F2 — On passe `project_id` et `collaborator_id` dans le `next`
    // virtuel pour que resolveChargeAndEnd consomme la capacité allouée
    // (allocations %) plutôt que les seuls jours ouvrés bruts.
    const resolved = resolveChargeAndEnd(
      {
        kind,
        start_date: startDate,
        end_date: endDate,
        charge_jours: null,
        project_id: projectId,
        collaborator_id:
          kind === 'task' ? (input.collaborator_id ?? null) : null,
      },
      input,
      db,
    )
    const draft = {
      kind,
      start_date: startDate,
      end_date: resolved.end_date,
      charge_jours: resolved.charge_jours,
      project_id: projectId,
      collaborator_id: kind === 'task' ? (input.collaborator_id ?? null) : null,
      not_before_date: normalizeNotBeforeDate(input.not_before_date, kind),
    }
    enforceNotBeforeDate(draft, db)

    db.prepare(
      `INSERT INTO tasks
        (id, name, kind, start_date, end_date, progress,
         collaborator_id, color, parent_id, predecessor_id,
         predecessor_lag, priority, not_before_date, charge_jours, position, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.name,
      kind,
      draft.start_date,
      draft.end_date,
      input.progress ?? 0,
      // v1.6 — Une phase n'est jamais affectée à un collaborateur.
      // v1.24 — Un jalon non plus (règle J3). Seules les activités le sont.
      kind === 'task' ? (input.collaborator_id ?? null) : null,
      input.color ?? null,
      input.parent_id ?? null,
      // v1.21 — Colonnes legacy mises à null/0 : la source de vérité est
      // désormais la table `task_predecessors`. Elles restent dans le schéma
      // pour ne pas casser les bases anciennes mais ne sont plus lues par
      // le code v1.21+.
      null,
      0,
      // v1.18 / v1.24 — Pr2 : 3 par défaut sur les activités, null sur jalon/phase.
      normalizePriority(input.priority, kind),
      // v1.24 — SNET : valeur saisie ou null si phase / format invalide.
      draft.not_before_date,
      // v2.0 — Charge stockée en source de vérité. Null pour jalons/phases.
      draft.charge_jours,
      position,
      projectId,
    )
    // v1.21 — Persiste les prédécesseurs dans la table N:M (après l'INSERT,
    // sinon la FK `task_id` rejette).
    if (predecessors && predecessors.length > 0) {
      setPredecessorsForTask(db, input.id, predecessors)
    }
    // v1.6 — Si on vient d'ajouter une feuille (task / milestone) à une
    // phase, il faut recalculer les dates de cette phase et de ses ancêtres.
    recomputeAncestorPhases(db, input.id)
    const version = bumpVersion(db)
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(input.id)
    // v1.21 — Enrichit le retour avec la liste de prédécesseurs et les alias
    // rétro-compat `predecessor_id` / `predecessor_lag` (= 1er prédécesseur).
    const preds = listPredecessorsForTask(db, input.id)
    task.predecessors = preds
    task.predecessor_id = preds[0]?.id ?? null
    task.predecessor_lag = preds[0]?.lag ?? 0
    return { version, task }
  })
  return tx()
}

/**
 * Met à jour une tâche existante (mise à jour partielle).
 * Si on passe une tâche en jalon, end_date est réalignée sur start_date.
 * Si un prédécesseur est défini, start_date est forcée sur sa end_date.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {{
 *   name?:string, kind?:'task'|'milestone',
 *   start_date?:string, end_date?:string, progress?:number,
 *   collaborator_id?:string|null, color?:string|null,
 *   parent_id?:string|null, predecessor_id?:string|null
 * }} patch
 * @returns {{version:number, changed:boolean}}
 */
export function updateTask(db, id, patch) {
  const tx = db.transaction(() => {
    const current = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id)
    if (!current) return { version: getVersion(db), changed: false }

    const next = { ...current, ...patch }

    // v1.21 — Synchronise la table `task_predecessors` AVANT la logique
    // de réconciliation des dates : la liste à jour est la source de vérité.
    syncPredecessorsFromPatch(db, id, next.kind, patch)

    // v1.21 — Aligne start_date sur MAX(pred.end + lag) si la liste actuelle
    // l'impose. Si `next.start_date` est déjà au-delà (saisie utilisateur ou
    // Replan), on respecte la valeur — le lag reste un MINIMUM.
    if (next.kind !== 'phase') {
      reconcilePredecessors(db, current, next)
    }
    // Cohérence : un jalon a end_date == start_date, toujours.
    if (next.kind === 'milestone') next.end_date = next.start_date

    // v1.24 — Règle J3 : un jalon n'a pas de collaborateur affecté.
    // On force le nettoyage à chaque update (même si le client ne l'a pas
    // explicitement effacé) pour rester aligné avec la règle métier.
    if (next.kind === 'milestone') next.collaborator_id = null

    // v1.6 — Une phase n'a pas de collaborateur (et plus de prédécesseur ;
    // on a déjà vidé sa liste juste au-dessus).
    if (next.kind === 'phase') {
      next.collaborator_id = null
      next.priority = null
    }
    // v1.18 / v1.24 — Normalise la priorité selon le type final de la tâche :
    //   • activité  → 1..5, défaut 3 si saisie invalide ;
    //   • jalon/phase → null (la priorité n'a pas de sens hors activité).
    next.priority = normalizePriority(next.priority, next.kind)
    // v1.24 — Normalise la date de démarrage au plus tôt SNET (null pour les phases, format
    // ISO 'YYYY-MM-DD' sinon, null si invalide).
    next.not_before_date = normalizeNotBeforeDate(
      next.not_before_date,
      next.kind,
    )
    // v2.0 / F1 — Garde : interdit l'affectation d'un collab non membre du
    // projet de la tâche (RG-GANTT-1200). Ne s'applique qu'aux activités —
    // jalons et phases viennent d'être forcés à `collaborator_id = null`.
    if (next.kind === 'task') {
      ensureCollabIsMember(db, next.collaborator_id, next.project_id)
    }
    // v2.0 — Résolution charge_jours / end_date AVANT l'enforcement SNET pour
    // que ce dernier puisse repousser start tout en préservant la nouvelle
    // charge calculée. Politique gérée par resolveChargeAndEnd :
    //   • charge_jours explicite → end = start + charge,
    //   • end_date explicite (drag bord droit) → charge back-dérivée,
    //   • sinon → charge existante conservée, end recalculée depuis start.
    // v2.0 / F2 — `db` est transmis pour que le recalcul consomme la
    // capacité allouée du collab (allocations %) jour par jour.
    const resolved = resolveChargeAndEnd(next, patch, db)
    next.charge_jours = resolved.charge_jours
    next.end_date = resolved.end_date
    // v1.24 — Applique la contrainte SNET en dernière étape (la borne basse
    // prédécesseur a déjà été réconciliée juste avant). Si SNET > borne basse
    // actuelle, start (et end) sont relevés en respectant la charge en jours ouvrés.
    enforceNotBeforeDate(next, db)

    db.prepare(
      `UPDATE tasks
         SET name = ?, kind = ?, start_date = ?, end_date = ?, progress = ?,
             collaborator_id = ?, color = ?, parent_id = ?,
             priority = ?, not_before_date = ?, charge_jours = ?
         WHERE id = ?`,
    ).run(
      next.name,
      next.kind,
      next.start_date,
      next.end_date,
      next.progress,
      next.collaborator_id,
      next.color,
      next.parent_id,
      next.priority,
      next.not_before_date,
      next.charge_jours,
      id,
    )
    // v1.6 — Si la tâche modifiée est elle-même une phase, on recalcule ses
    // propres dates (au cas où des enfants ont été déplacés). Et dans tous
    // les cas, on remonte aux ancêtres pour propager.
    if (next.kind === 'phase') recomputePhaseDates(db, id)
    recomputeAncestorPhases(db, id)
    // Si on a changé de parent (rare en update, mais possible), il faut
    // aussi recalculer l'ancien parent.
    if (current.parent_id && current.parent_id !== next.parent_id) {
      recomputeAncestorPhases(db, current.parent_id)
    }
    // v1.9 — Cascade aux successeurs : si la date de fin (ou de début) de
    // cette tâche a changé, certains successeurs peuvent se retrouver à
    // démarrer AVANT la nouvelle fin → on les repousse pour préserver la
    // dépendance, en conservant leur charge en jours ouvrés.
    if (
      current.end_date !== next.end_date ||
      current.start_date !== next.start_date
    ) {
      propagateToSuccessors(db, id)
    }
    const version = bumpVersion(db)
    return { version, changed: true }
  })
  return tx()
}

/**
 * Supprime une tâche. Les tâches enfants (parent_id) sont supprimées en cascade.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {{version:number, changed:boolean}}
 */
export function deleteTask(db, id) {
  const tx = db.transaction(() => {
    // v1.6 — On capture parent_id AVANT la suppression pour pouvoir
    // recalculer les dates de l'ancêtre (s'il s'agit d'une phase).
    const before = db
      .prepare(`SELECT parent_id FROM tasks WHERE id = ?`)
      .get(id)
    const info = db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id)
    if (info.changes === 0) return { version: getVersion(db), changed: false }
    if (before?.parent_id) {
      // Recompute via le parent (recomputeAncestorPhases part d'un id
      // existant ; on appelle directement avec le parent comme cursor).
      const parent = db
        .prepare(`SELECT id, kind FROM tasks WHERE id = ?`)
        .get(before.parent_id)
      if (parent?.kind === 'phase') recomputePhaseDates(db, parent.id)
      recomputeAncestorPhases(db, before.parent_id)
    }
    const version = bumpVersion(db)
    return { version, changed: true }
  })
  return tx()
}

/**
 * v1.5 — Récupère récursivement l'ensemble des descendants d'une tâche
 * (enfants + petits-enfants…). Utilisé par `moveTask` pour rejeter un
 * déplacement qui créerait un cycle (déposer une tâche dans un de ses
 * propres descendants).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} rootId
 * @returns {Set<string>}  Set des ids descendants (n'inclut PAS rootId).
 */
function descendantTaskIds(db, rootId) {
  const out = new Set()
  const stmt = db.prepare(`SELECT id FROM tasks WHERE parent_id = ?`)
  const queue = [rootId]
  while (queue.length > 0) {
    const cur = queue.shift()
    for (const row of stmt.all(cur)) {
      if (out.has(row.id)) continue
      out.add(row.id)
      queue.push(row.id)
    }
  }
  return out
}

/**
 * v1.5 — Déplace une tâche dans la hiérarchie : change son `parent_id`
 * et/ou sa position parmi ses frères. Renumérote ensuite les positions
 * des frères (ancien et nouveau parent) pour rester compactes.
 *
 * Sémantique de `before_id` :
 *   • `null` → la tâche est insérée en DERNIÈRE position du nouveau parent.
 *   • Sinon → la tâche est insérée juste AVANT la tâche `before_id`,
 *     qui doit déjà être enfant du même parent (sinon ignoré).
 *
 * Anti-cycle : refuse si `parent_id` est la tâche elle-même ou un de ses
 * descendants.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id           Id de la tâche à déplacer.
 * @param {{parent_id: string|null, before_id: string|null}} target
 * @returns {{version:number, changed:boolean}}
 */
/**
 * Vérifie que `parent_id` est un parent valide pour la tâche `id` :
 *   • pas elle-même
 *   • pas un de ses descendants (anti-cycle)
 *   • doit exister en base
 *
 * Lève une Error explicite (convertie en HTTP 400 par le caller).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id          Id de la tâche déplacée.
 * @param {string|null} parentId  Id du parent cible (null = racine).
 */
function assertValidMoveParent(db, id, parentId) {
  if (parentId === id) {
    throw new Error('Une tâche ne peut pas être son propre parent')
  }
  if (!parentId) return
  const banned = descendantTaskIds(db, id)
  if (banned.has(parentId)) {
    throw new Error(
      'Impossible de déplacer une tâche dans un de ses propres descendants',
    )
  }
  const parentExists = db
    .prepare(`SELECT 1 AS x FROM tasks WHERE id = ?`)
    .get(parentId)
  if (!parentExists) {
    throw new Error(`parent introuvable : ${parentId}`)
  }
}

/**
 * Liste les ids des frères d'une tâche dans un parent donné (en l'excluant),
 * triés par position. Gère le cas spécial parent NULL (= racine).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string|null} parentId
 * @param {string} excludeId   Id à exclure de la liste.
 * @returns {string[]}         Ids triés.
 */
function siblingIds(db, parentId, excludeId) {
  const rows =
    parentId === null
      ? db
          .prepare(
            `SELECT id FROM tasks WHERE parent_id IS NULL AND id != ?
               ORDER BY position ASC, id ASC`,
          )
          .all(excludeId)
      : db
          .prepare(
            `SELECT id FROM tasks WHERE parent_id = ? AND id != ?
               ORDER BY position ASC, id ASC`,
          )
          .all(parentId, excludeId)
  return rows.map((r) => r.id)
}

/**
 * Réécrit `position` (0..N-1) pour la liste d'ids passée — compaction.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} ids
 */
function renumberPositions(db, ids) {
  const upd = db.prepare(`UPDATE tasks SET position = ? WHERE id = ?`)
  for (let i = 0; i < ids.length; i++) upd.run(i, ids[i])
}

export function moveTask(db, id, { parent_id, before_id }) {
  const tx = db.transaction(() => {
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id)
    if (!task) return { version: getVersion(db), changed: false }

    assertValidMoveParent(db, id, parent_id)

    const oldParentId = task.parent_id
    const newParentId = parent_id ?? null

    // 1. Met à jour parent_id de la tâche déplacée.
    db.prepare(`UPDATE tasks SET parent_id = ? WHERE id = ?`).run(
      newParentId,
      id,
    )

    // 2. Construit la nouvelle liste de frères avec la tâche insérée
    //    à la bonne position, puis renumérote.
    const newSiblings = siblingIds(db, newParentId, id)
    let insertAt = newSiblings.length
    if (before_id) {
      const idx = newSiblings.indexOf(before_id)
      if (idx >= 0) insertAt = idx
    }
    newSiblings.splice(insertAt, 0, id)
    renumberPositions(db, newSiblings)

    // 3. Si parent change, on renumérote aussi l'ancien parent (compaction).
    if (oldParentId !== newParentId) {
      renumberPositions(db, siblingIds(db, oldParentId, id))
    }

    // v1.6 — Recompute des dates des phases ancêtres (ancien ET nouveau parent).
    recomputeAncestorPhases(db, id) // remonte vers le nouveau parent
    if (oldParentId && oldParentId !== newParentId) {
      const oldParent = db
        .prepare(`SELECT id, kind FROM tasks WHERE id = ?`)
        .get(oldParentId)
      if (oldParent?.kind === 'phase') recomputePhaseDates(db, oldParent.id)
      recomputeAncestorPhases(db, oldParentId)
    }

    const version = bumpVersion(db)
    return { version, changed: true }
  })
  return tx()
}

// -----------------------------------------------------------------------------
// REMPLACEMENT GLOBAL & DEMO
// -----------------------------------------------------------------------------

/**
 * Données de démonstration chargées au premier démarrage (base vide).
 * Inspirées de l'exemple "Video Production Template" fourni à la création
 * du projet.
 */
export const DEMO_STATE = {
  // v1.8 — Le jeu de démo s'inscrit dans un projet "Projet 1" unique.
  projects: [{ id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME }],
  collaborators: [
    { id: 'c1', name: 'Alice', color: '#3b82f6' },
    { id: 'c2', name: 'Benoît', color: '#10b981' },
    { id: 'c3', name: 'Camille', color: '#f59e0b' },
  ],
  tasks: [
    // Phase 1
    {
      // v1.6 — kind 'phase' : dates auto-calculées depuis les enfants
      id: 't1',
      name: 'Pré-production',
      kind: 'phase',
      start_date: '2026-05-15',
      end_date: '2026-06-30',
      progress: 0,
    },
    {
      id: 't1a',
      name: 'Recherche audience',
      kind: 'task',
      start_date: '2026-05-15',
      end_date: '2026-05-29',
      progress: 100,
      collaborator_id: 'c1',
      parent_id: 't1',
    },
    {
      id: 't1b',
      name: 'Définir le message',
      kind: 'task',
      start_date: '2026-05-25',
      end_date: '2026-06-05',
      progress: 100,
      collaborator_id: 'c1',
      parent_id: 't1',
    },
    {
      id: 't1c',
      name: 'Écrire le script',
      kind: 'task',
      start_date: '2026-06-01',
      end_date: '2026-06-15',
      progress: 80,
      collaborator_id: 'c2',
      parent_id: 't1',
    },
    {
      id: 't1d',
      name: 'Storyboard',
      kind: 'task',
      start_date: '2026-06-10',
      end_date: '2026-06-25',
      progress: 30,
      collaborator_id: 'c2',
      parent_id: 't1',
    },
    {
      id: 'm1',
      name: 'Validation pré-production',
      kind: 'milestone',
      start_date: '2026-06-30',
      parent_id: 't1',
    },

    // Phase 2
    {
      id: 't2',
      name: 'Tournage',
      kind: 'phase',
      start_date: '2026-07-01',
      end_date: '2026-07-20',
      progress: 0,
    },
    {
      id: 't2a',
      name: 'Tournage extérieur',
      kind: 'task',
      start_date: '2026-07-01',
      end_date: '2026-07-10',
      progress: 0,
      collaborator_id: 'c3',
      parent_id: 't2',
    },
    {
      id: 't2b',
      name: 'Tournage intérieur',
      kind: 'task',
      start_date: '2026-07-08',
      end_date: '2026-07-20',
      progress: 0,
      collaborator_id: 'c3',
      parent_id: 't2',
    },

    // Phase 3
    {
      id: 't3',
      name: 'Post-production',
      kind: 'phase',
      start_date: '2026-07-21',
      end_date: '2026-08-31',
      progress: 0,
    },
    {
      id: 't3a',
      name: 'Montage',
      kind: 'task',
      start_date: '2026-07-21',
      end_date: '2026-08-10',
      progress: 0,
      collaborator_id: 'c2',
      parent_id: 't3',
    },
    {
      id: 't3b',
      name: 'Voix off',
      kind: 'task',
      // v1.18.1 — fin alignée sur un jour ouvré (vendredi 14/08), au lieu
      // du samedi 15/08 qui faisait apparaître la tâche dans l'aperçu Replan
      // alors qu'aucune surcharge ne la concernait (Replan ramène toujours
      // la fin sur un jour ouvré via addWorkingDays).
      start_date: '2026-08-05',
      end_date: '2026-08-14',
      progress: 0,
      collaborator_id: 'c1',
      parent_id: 't3',
    },
    {
      id: 'm2',
      name: 'Livraison finale',
      kind: 'milestone',
      start_date: '2026-08-31',
      parent_id: 't3',
    },
  ],
}

/**
 * Vide entièrement la base (collaborateurs + tâches) puis insère un état
 * complet. Utilisé par le reset démo et les tests d'intégration.
 *
 * Toute l'opération est dans une transaction pour rester atomique : si
 * une insertion échoue, rien n'est appliqué.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{collaborators:Array, tasks:Array}} state
 * @returns {{version:number}}
 */
export function replaceFullState(db, state) {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM tasks`).run()
    db.prepare(`DELETE FROM collaborators`).run()
    db.prepare(`DELETE FROM projects`).run()

    // v1.8 — Projets. Si l'état ne fournit aucun projet (ex. ancien export),
    // on en crée un par défaut auquel toutes les tâches seront rattachées.
    const projects =
      state.projects && state.projects.length > 0
        ? state.projects
        : [{ id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME }]
    const insProject = db.prepare(
      `INSERT INTO projects(id, name, position) VALUES (?, ?, ?)`,
    )
    projects.forEach((p, idx) => {
      insProject.run(p.id, p.name, idx)
    })
    const fallbackProjectId = projects[0].id

    const insCollab = db.prepare(
      `INSERT INTO collaborators(id, name, color, position) VALUES (?, ?, ?, ?)`,
    )
    state.collaborators.forEach((c, idx) => {
      insCollab.run(c.id, c.name, c.color || '#3b82f6', idx)
    })

    const insTask = db.prepare(
      `INSERT INTO tasks
        (id, name, kind, start_date, end_date, progress,
         collaborator_id, color, parent_id, predecessor_id,
         predecessor_lag, priority, not_before_date,
         position, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    // v1.21 — On insère d'abord toutes les tâches SANS leurs prédécesseurs,
    // puis on remplit `task_predecessors` dans une 2ᵉ passe — sinon une
    // liaison qui pointe vers une tâche pas encore insérée ferait échouer la
    // FK. La liste de préds par tâche est mémorisée pendant la 1ʳᵉ passe.
    const predsByTaskId = new Map()
    state.tasks.forEach((t, idx) => {
      const kind = t.kind || 'task'
      const endDate =
        kind === 'milestone' ? t.start_date : t.end_date || t.start_date
      const predecessors = kind === 'phase' ? null : resolvePredecessorsInput(t)
      if (predecessors && predecessors.length > 0) {
        predsByTaskId.set(t.id, predecessors)
      }
      insTask.run(
        t.id,
        t.name,
        kind,
        t.start_date,
        endDate,
        t.progress ?? 0,
        // v1.6 / v1.24 — Ni les phases ni les jalons n'ont de collaborateur.
        kind === 'task' ? (t.collaborator_id ?? null) : null,
        t.color ?? null,
        t.parent_id ?? null,
        // v1.21 — Colonnes legacy figées à null/0. Source de vérité = table
        // `task_predecessors` remplie dans la 2ᵉ passe ci-dessous.
        null,
        0,
        // v1.18 / v1.24 — priorité 1..5 (défaut 3) sur les activités, null
        // sur les jalons et les phases.
        normalizePriority(t.priority, kind),
        // v1.24 — SNET : valeur saisie ou null (forcé à null si phase).
        normalizeNotBeforeDate(t.not_before_date, kind),
        idx,
        t.project_id || fallbackProjectId,
      )
    })
    // 2ᵉ passe : toutes les tâches existent désormais, on peut relier.
    for (const [taskId, preds] of predsByTaskId) {
      setPredecessorsForTask(db, taskId, preds)
    }

    // v1.6 — Recalcul des dates de toutes les phases (depuis les feuilles
    // les plus profondes vers la racine pour gérer les phases imbriquées).
    // On itère plusieurs passes : à chaque passe, les dates remontent d'un
    // niveau ; en pratique 2-3 passes suffisent pour les arborescences
    // courantes mais on borne à 10 par sécurité.
    const phaseIds = db
      .prepare(`SELECT id FROM tasks WHERE kind = 'phase'`)
      .all()
      .map((r) => r.id)
    for (let pass = 0; pass < 10; pass++) {
      let changed = false
      for (const pid of phaseIds) {
        const before = db
          .prepare(`SELECT start_date, end_date FROM tasks WHERE id = ?`)
          .get(pid)
        recomputePhaseDates(db, pid)
        const after = db
          .prepare(`SELECT start_date, end_date FROM tasks WHERE id = ?`)
          .get(pid)
        if (
          before?.start_date !== after?.start_date ||
          before?.end_date !== after?.end_date
        ) {
          changed = true
        }
      }
      if (!changed) break
    }

    const version = bumpVersion(db)
    return { version }
  })
  return tx()
}

/**
 * Restaure les données de démonstration. Utilisé par POST /api/reset.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{version:number}}
 */
export function resetToDemo(db) {
  return replaceFullState(db, DEMO_STATE)
}

/**
 * Indique si la base est complètement vide (pas de collab, pas de tâche).
 * Utilisé au boot pour décider s'il faut charger les données démo.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean}
 */
export function isDatabaseEmpty(db) {
  const c = db.prepare(`SELECT COUNT(*) AS n FROM collaborators`).get().n
  const t = db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get().n
  const p = db.prepare(`SELECT COUNT(*) AS n FROM projects`).get().n
  return c === 0 && t === 0 && p === 0
}
