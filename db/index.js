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

  // Initialise la version à 0 si la ligne meta n'existe pas encore.
  db.prepare(
    `INSERT OR IGNORE INTO meta(key, value) VALUES ('version', '0')`,
  ).run()

  return db
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
      position        INTEGER NOT NULL,
      CHECK (progress BETWEEN 0 AND 100)
    );
    INSERT INTO tasks_new
      (id, name, kind, start_date, end_date, progress,
       collaborator_id, color, parent_id, predecessor_id, position)
    SELECT
       id, name, kind, start_date, end_date, progress,
       collaborator_id, color, parent_id, predecessor_id, position
    FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE tasks_new RENAME TO tasks;
    CREATE INDEX IF NOT EXISTS idx_tasks_collab      ON tasks(collaborator_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent      ON tasks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_predecessor ON tasks(predecessor_id);
  `)
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
 * Renvoie l'état complet du Gantt : version, collaborateurs, tâches.
 * Format identique à celui consommé par le frontend.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{
 *   version: number,
 *   collaborators: Array<{id:string,name:string,color:string,position:number}>,
 *   tasks: Array<{
 *     id:string, name:string, kind:'task'|'milestone',
 *     start_date:string, end_date:string, progress:number,
 *     collaborator_id:string|null, color:string|null,
 *     parent_id:string|null, predecessor_id:string|null, position:number
 *   }>
 * }}
 */
export function getFullState(db) {
  const collaborators = db
    .prepare(
      `SELECT id, name, color, position
         FROM collaborators
         ORDER BY position ASC, id ASC`,
    )
    .all()
  const tasks = db
    .prepare(
      `SELECT id, name, kind, start_date, end_date, progress,
              collaborator_id, color, parent_id, predecessor_id, position
         FROM tasks
         ORDER BY position ASC, id ASC`,
    )
    .all()
  return { version: getVersion(db), collaborators, tasks }
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
 * Crée une tâche ou un jalon. Pour un jalon, end_date est forcée à start_date.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   id:string, name:string, kind?:'task'|'milestone',
 *   start_date:string, end_date?:string, progress?:number,
 *   collaborator_id?:string|null, color?:string|null,
 *   parent_id?:string|null, predecessor_id?:string|null
 * }} input
 * @returns {{version:number, task:object}}
 */
export function createTask(db, input) {
  const tx = db.transaction(() => {
    const kind = input.kind || 'task'
    let startDate = input.start_date
    // v1.2 — Si un prédécesseur est défini, on garantit que start_date ≥
    // end_date du prédécesseur. Si le client a saisi une date plus tardive
    // (décalage volontaire), on la conserve : seule la borne MIN est imposée.
    if (input.predecessor_id) {
      const pred = db
        .prepare(`SELECT end_date FROM tasks WHERE id = ?`)
        .get(input.predecessor_id)
      if (pred && (!startDate || startDate < pred.end_date)) {
        startDate = pred.end_date
      }
    }
    // Pour un jalon, on ignore end_date envoyé par le client : un jalon est
    // ponctuel, donc end_date = start_date par construction.
    const endDate =
      kind === 'milestone' ? startDate : input.end_date || startDate
    const position = nextTaskPosition(db)
    db.prepare(
      `INSERT INTO tasks
        (id, name, kind, start_date, end_date, progress,
         collaborator_id, color, parent_id, predecessor_id, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.name,
      kind,
      startDate,
      endDate,
      input.progress ?? 0,
      // v1.6 — Une phase n'est jamais affectée à un collaborateur.
      kind === 'phase' ? null : (input.collaborator_id ?? null),
      input.color ?? null,
      input.parent_id ?? null,
      kind === 'phase' ? null : (input.predecessor_id ?? null),
      position,
    )
    // v1.6 — Si on vient d'ajouter une feuille (task / milestone) à une
    // phase, il faut recalculer les dates de cette phase et de ses ancêtres.
    recomputeAncestorPhases(db, input.id)
    const version = bumpVersion(db)
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(input.id)
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

    // v1.2 — Si un prédécesseur est défini (ou réaffirmé), start_date doit
    // être ≥ end_date du prédécesseur. Si elle est antérieure, on la pousse
    // à la fin du prédécesseur (en conservant la durée existante pour ne pas
    // rétrécir/étirer la tâche involontairement). Si elle est déjà postérieure,
    // on respecte la valeur saisie par l'utilisateur (décalage volontaire).
    if (next.predecessor_id && next.predecessor_id !== id) {
      const pred = db
        .prepare(`SELECT end_date FROM tasks WHERE id = ?`)
        .get(next.predecessor_id)
      if (pred && next.start_date < pred.end_date) {
        const oldStart = new Date(next.start_date)
        const oldEnd = new Date(next.end_date)
        const durationDays = Math.max(
          0,
          Math.round((oldEnd - oldStart) / 86400000),
        )
        next.start_date = pred.end_date
        // Conserve la durée existante (sauf jalon : end_date = start_date)
        if (next.kind !== 'milestone') {
          const newStart = new Date(next.start_date)
          newStart.setDate(newStart.getDate() + durationDays)
          next.end_date = newStart.toISOString().slice(0, 10)
        }
      }
    }
    // Cohérence : un jalon a end_date == start_date, toujours.
    if (next.kind === 'milestone') next.end_date = next.start_date

    // v1.6 — Une phase n'a pas de collaborateur ni de prédécesseur.
    if (next.kind === 'phase') {
      next.collaborator_id = null
      next.predecessor_id = null
    }
    db.prepare(
      `UPDATE tasks
         SET name = ?, kind = ?, start_date = ?, end_date = ?, progress = ?,
             collaborator_id = ?, color = ?, parent_id = ?, predecessor_id = ?
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
      next.predecessor_id,
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
export function moveTask(db, id, { parent_id, before_id }) {
  const tx = db.transaction(() => {
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id)
    if (!task) return { version: getVersion(db), changed: false }

    // Anti-cycle : on refuse de placer la tâche dans elle-même ou un de
    // ses descendants. Lève une erreur explicite (le caller la convertit
    // en HTTP 400).
    if (parent_id === id) {
      throw new Error('Une tâche ne peut pas être son propre parent')
    }
    if (parent_id) {
      const banned = descendantTaskIds(db, id)
      if (banned.has(parent_id)) {
        throw new Error(
          'Impossible de déplacer une tâche dans un de ses propres descendants',
        )
      }
      // Vérifier aussi que le parent existe.
      const parentExists = db
        .prepare(`SELECT 1 AS x FROM tasks WHERE id = ?`)
        .get(parent_id)
      if (!parentExists) {
        throw new Error(`parent introuvable : ${parent_id}`)
      }
    }

    const oldParentId = task.parent_id
    const newParentId = parent_id ?? null

    // 1. Met à jour parent_id de la tâche déplacée (la position sera
    //    écrasée par la renumérotation ci-dessous).
    db.prepare(`UPDATE tasks SET parent_id = ? WHERE id = ?`).run(
      newParentId,
      id,
    )

    // 2. Liste des nouveaux frères (sans la tâche déplacée), triés.
    //    Note : on prépare 2 versions car SQLite n'accepte pas `= NULL`.
    const siblingsStmtNull = db.prepare(
      `SELECT id FROM tasks WHERE parent_id IS NULL AND id != ?
         ORDER BY position ASC, id ASC`,
    )
    const siblingsStmt = db.prepare(
      `SELECT id FROM tasks WHERE parent_id = ? AND id != ?
         ORDER BY position ASC, id ASC`,
    )
    const newSiblings =
      newParentId === null
        ? siblingsStmtNull.all(id).map((r) => r.id)
        : siblingsStmt.all(newParentId, id).map((r) => r.id)

    // 3. Calcul de l'index d'insertion. before_id absent ou inconnu = fin.
    let insertAt = newSiblings.length
    if (before_id) {
      const idx = newSiblings.indexOf(before_id)
      if (idx >= 0) insertAt = idx
    }
    newSiblings.splice(insertAt, 0, id)

    // 4. Renumérotation compacte du nouveau parent (positions 0..N-1).
    const updatePos = db.prepare(`UPDATE tasks SET position = ? WHERE id = ?`)
    for (let i = 0; i < newSiblings.length; i++) {
      updatePos.run(i, newSiblings[i])
    }

    // 5. Si parent change, on renumérote aussi l'ancien parent (compaction).
    if (oldParentId !== newParentId) {
      const oldSiblings =
        oldParentId === null
          ? siblingsStmtNull.all(id).map((r) => r.id)
          : siblingsStmt.all(oldParentId, id).map((r) => r.id)
      for (let i = 0; i < oldSiblings.length; i++) {
        updatePos.run(i, oldSiblings[i])
      }
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
      start_date: '2026-08-05',
      end_date: '2026-08-15',
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

    const insCollab = db.prepare(
      `INSERT INTO collaborators(id, name, color, position) VALUES (?, ?, ?, ?)`,
    )
    state.collaborators.forEach((c, idx) => {
      insCollab.run(c.id, c.name, c.color || '#3b82f6', idx)
    })

    const insTask = db.prepare(
      `INSERT INTO tasks
        (id, name, kind, start_date, end_date, progress,
         collaborator_id, color, parent_id, predecessor_id, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    state.tasks.forEach((t, idx) => {
      const kind = t.kind || 'task'
      const endDate =
        kind === 'milestone' ? t.start_date : t.end_date || t.start_date
      insTask.run(
        t.id,
        t.name,
        kind,
        t.start_date,
        endDate,
        t.progress ?? 0,
        // v1.6 — pas de collaborateur ni de prédécesseur sur une phase.
        kind === 'phase' ? null : (t.collaborator_id ?? null),
        t.color ?? null,
        t.parent_id ?? null,
        kind === 'phase' ? null : (t.predecessor_id ?? null),
        idx,
      )
    })

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
  return c === 0 && t === 0
}
