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
// v2.0 / Refacto (a) — Helpers « jours ouvrés » extraits dans un module
// dédié (pur, sans dépendance BDD). Une seule source de vérité serveur.
import {
  addWorkingDaysServer,
  computeSuccessorStart,
  snapForwardToWorkingDayServer,
  workingDaysBetweenServer,
} from './working-days.js'
// v2.0 / Refacto (a) — Migrations BDD extraites dans un module dédié.
// Chaque `ensureXxx` est idempotente ; l'ordre d'appel dans initDb est fixé.
import {
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  ensureChargeColumn,
  ensureCollaboratorAbsencesTable,
  ensureKindAcceptsPhase,
  ensureMemberAllocationsTable,
  ensureProjectMembersTable,
  ensureProjectsMigration,
  ensureProjectStartDateColumn,
  ensureTaskAssignmentsTable,
  ensureTaskColumns,
  ensureTaskPredecessorsTable,
} from './migrations.js'
// v2.0 / Refacto (a) — Moteur de capacité allouée extrait dans db/capacity.js.
// Couvre allocation × absence (F2+F3) et la sommation multi-collab (F6).
import { addWorkingDaysWithAllocationServer } from './capacity.js'
// v2.0 / Refacto (a) — Normalisations défensives extraites dans db/normalize.js
// (filet de sécurité au-dessus de la validation Zod côté API).
import {
  normalizeNotBeforeDate,
  normalizeNotLaterThanDate,
  normalizePriority,
} from './normalize.js'
// v2.0 / Refacto (a) — Données de démonstration extraites dans db/demo-state.js
// (data pure, sans logique). resetToDemo / replaceFullState restent ici car
// couplées à bumpVersion (privé).
import { DEMO_STATE } from './demo-state.js'

// Ré-export des constantes pour les modules qui les importent depuis db/index.js.
export { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME }
// Ré-export de DEMO_STATE pour les tests qui l'importent depuis db/index.js.
export { DEMO_STATE }

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

  // v2.3 / RG-GANTT-2000 — Ajoute la colonne `project_start_date` sur
  // `projects` si elle manque, puis initialise sa valeur pour les projets
  // existants à MIN(tasks.start_date) (ou today si projet vide). Doit
  // tourner APRÈS ensureProjectsMigration qui s'assure que la table existe
  // et qu'au moins un projet par défaut est créé.
  ensureProjectStartDateColumn(db)

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

  // v2.0 / F3 — Crée la table `collaborator_absences` (cross-projet). Pas
  // d'auto-pop : c'est une donnée entièrement nouvelle saisie par l'utilisateur.
  ensureCollaboratorAbsencesTable(db)

  // v2.0 / F6 — Crée la table `task_assignments` (multi-collab par tâche) et
  // auto-peuple depuis tasks.collaborator_id existants. Le champ legacy
  // reste alimenté en miroir (= 1er affecté par ordre alpha) pour ne pas
  // casser les lecteurs externes.
  ensureTaskAssignmentsTable(db)

  // Initialise la version à 0 si la ligne meta n'existe pas encore.
  db.prepare(
    `INSERT OR IGNORE INTO meta(key, value) VALUES ('version', '0')`,
  ).run()

  return db
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

/**
 * v1.21 — Joint les prédécesseurs depuis la table N:M et enrichit chaque
 * tâche `tasks[i]` en place avec `predecessors[]` + alias rétro-compat
 * `predecessor_id` / `predecessor_lag` (= 1er pred par id ASC).
 * Extrait pour limiter la complexité cognitive de `getFullState`.
 */
function enrichTasksWithPredecessors(db, tasks, currentId) {
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
  for (const t of tasks) {
    const list = predecessorsByTask.get(t.id) || []
    t.predecessors = list
    t.predecessor_id = list[0]?.id ?? null
    t.predecessor_lag = list[0]?.lag ?? 0
  }
}

/**
 * v2.0 / F6 — Joint les affectations multi-collab depuis `task_assignments`
 * et enrichit chaque tâche en place avec `collaborators[]`. Tableau toujours
 * présent (vide pour jalons/phases). Extrait pour limiter la complexité
 * cognitive de `getFullState`.
 */
function enrichTasksWithAssignments(db, tasks, currentId) {
  const assignmentsByTask = new Map()
  if (currentId) {
    const rows = db
      .prepare(
        `SELECT a.task_id, a.collaborator_id
           FROM task_assignments a
           JOIN tasks t ON t.id = a.task_id
           WHERE t.project_id = ?
           ORDER BY a.collaborator_id ASC`,
      )
      .all(currentId)
    for (const r of rows) {
      if (!assignmentsByTask.has(r.task_id)) {
        assignmentsByTask.set(r.task_id, [])
      }
      assignmentsByTask.get(r.task_id).push({ id: r.collaborator_id })
    }
  }
  for (const t of tasks) {
    t.collaborators = assignmentsByTask.get(t.id) || []
  }
}

export function getFullState(db, projectId) {
  const projects = db
    .prepare(
      `SELECT id, name, position, project_start_date
         FROM projects ORDER BY position ASC, id ASC`,
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
                  priority, not_before_date, not_later_than_date,
                  charge_jours, position, project_id
             FROM tasks
             WHERE project_id = ?
             ORDER BY position ASC, id ASC`,
        )
        .all(currentId)
    : []
  // v2.0 / F6 — Enrichit les tâches avec leurs prédécesseurs et leurs
  // affectations multi-collab. Extrait dans des helpers privés pour limiter
  // la complexité cognitive de `getFullState` (sonarjs).
  enrichTasksWithPredecessors(db, tasks, currentId)
  enrichTasksWithAssignments(db, tasks, currentId)
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
  // v2.0 / F3 — Absences (cross-projet) : on retourne TOUTES les absences
  // de TOUS les collabs, car un congé saisi sur Léa impacte tous ses projets
  // (lecture multiplicative Q8b). L'onglet « Congés » est lui-même cross-projet.
  const collaboratorAbsences = listAbsences(db)
  // v2.0 / F5 — Allocations CROSS-PROJET : nécessaires pour calculer la
  // capacité totale d'un collab (Σ pct sur tous projets), qui sert de seuil
  // de coloration au plan de charge même en vue « projet courant ».
  // Volume négligeable (allocations restent quelques dizaines de lignes max).
  const allMemberAllocations = db
    .prepare(
      `SELECT id, project_id, collaborator_id, start_date, end_date, allocation_pct
         FROM member_allocations
         ORDER BY collaborator_id ASC, start_date ASC, id ASC`,
    )
    .all()
  // v2.2 / F5 — Memberships CROSS-PROJET : nécessaires pour la vue
  // « Affectation × Tous les projets » qui affiche la matrice complète
  // collab × projet (avec ✓ pour chaque couple membre). Volume négligeable
  // (~ quelques dizaines de lignes max sur des plannings PME/consulting).
  const allProjectMembers = db
    .prepare(
      `SELECT project_id, collaborator_id
         FROM project_members
         ORDER BY project_id ASC, collaborator_id ASC`,
    )
    .all()
  return {
    version: getVersion(db),
    current_project_id: currentId,
    projects,
    collaborators,
    tasks,
    current_project_members: currentProjectMembers,
    member_allocations: memberAllocations,
    all_member_allocations: allMemberAllocations,
    all_project_members: allProjectMembers,
    collaborator_absences: collaboratorAbsences,
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
      `SELECT id, name, position, project_start_date
         FROM projects ORDER BY position ASC, id ASC`,
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
    // v2.3 / RG-GANTT-2000 — Date de démarrage du projet. Si non fournie par
    // l'appelant, on prend `today` (format ISO YYYY-MM-DD). Toujours stockée
    // en base — colonne NOT NULL.
    const startDate =
      input.project_start_date || new Date().toISOString().slice(0, 10)
    db.prepare(
      `INSERT INTO projects(id, name, position, project_start_date)
         VALUES (?, ?, ?, ?)`,
    ).run(input.id, input.name, position, startDate)
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

/**
 * v2.1 / F2.9 — Met à jour une période d'allocation existante. Permet de :
 *   • prolonger `end_date` (cas d'usage F2.9 — extension d'allocation pour
 *     absorber une charge non absorbable) ;
 *   • optionnellement modifier `start_date` ou `allocation_pct`.
 *
 * Validations identiques à `addMemberAllocation` :
 *   • si `allocation_pct` fourni → ∈ {25, 50, 75, 100} ;
 *   • `start_date` ≤ `end_date` après application des patches ;
 *   • pas de chevauchement avec une AUTRE allocation du même (project, collab)
 *     (RG-GANTT-1301) — `hasAllocationOverlap` exclut l'id courant.
 *
 * No-op (changed=false) si l'id n'existe pas. Lève si la validation échoue.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {{start_date?:string, end_date?:string, allocation_pct?:number}} patch
 * @returns {{version:number, changed:boolean, allocation?:object}}
 */
export function updateMemberAllocation(db, id, patch) {
  const tx = db.transaction(() => {
    const cur = db
      .prepare(`SELECT * FROM member_allocations WHERE id = ?`)
      .get(id)
    if (!cur) return { version: getVersion(db), changed: false }
    // Construction de l'état cible (champs absents = inchangés).
    const next = {
      start_date: patch.start_date ?? cur.start_date,
      end_date: patch.end_date ?? cur.end_date,
      allocation_pct:
        patch.allocation_pct !== undefined
          ? Number(patch.allocation_pct)
          : cur.allocation_pct,
    }
    // Validations.
    if (!ALLOWED_ALLOCATION_PCTS.has(next.allocation_pct)) {
      const err = new Error(
        `allocation_pct must be one of 25,50,75,100 (got ${next.allocation_pct})`,
      )
      err.code = 'INVALID_ALLOCATION_PCT'
      throw err
    }
    if (next.end_date < next.start_date) {
      const err = new Error('end_date must be >= start_date')
      err.code = 'INVALID_DATE_RANGE'
      throw err
    }
    if (
      hasAllocationOverlap(
        db,
        cur.project_id,
        cur.collaborator_id,
        next.start_date,
        next.end_date,
        id, // exclut l'allocation en cours de mise à jour
      )
    ) {
      const err = new Error(
        'Allocation period overlaps an existing one for this member',
      )
      err.code = 'ALLOCATION_OVERLAP'
      throw err
    }
    db.prepare(
      `UPDATE member_allocations
         SET start_date = ?, end_date = ?, allocation_pct = ?
         WHERE id = ?`,
    ).run(next.start_date, next.end_date, next.allocation_pct, id)
    const version = bumpVersion(db)
    const allocation = db
      .prepare(`SELECT * FROM member_allocations WHERE id = ?`)
      .get(id)
    return { version, changed: true, allocation }
  })
  return tx()
}

// -----------------------------------------------------------------------------
// v2.0 / F3 — ABSENCES (congés cross-projet)
// -----------------------------------------------------------------------------

/** v2.0 / F3 — Paliers de fraction de jour autorisés pour un congé. */
const ALLOWED_ABSENCE_FRACTIONS = new Set([0.25, 0.5, 0.75, 1])

/**
 * v2.0 / F3 — Liste les absences d'un collaborateur, triées par date.
 * Si `collaboratorId` est omis, renvoie TOUTES les absences (cross-projet).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [collaboratorId]
 * @returns {Array<{collaborator_id:string, date:string, fraction:number}>}
 */
export function listAbsences(db, collaboratorId) {
  if (collaboratorId) {
    return db
      .prepare(
        `SELECT collaborator_id, date, fraction
           FROM collaborator_absences
           WHERE collaborator_id = ?
           ORDER BY date ASC`,
      )
      .all(collaboratorId)
  }
  return db
    .prepare(
      `SELECT collaborator_id, date, fraction
         FROM collaborator_absences
         ORDER BY collaborator_id ASC, date ASC`,
    )
    .all()
}

/**
 * v2.0 / F3 — Ajoute (ou remplace) une absence pour un collab à une date
 * donnée. Sémantique UPSERT : si une absence existe déjà sur cette date,
 * sa fraction est mise à jour (utile pour passer de 0,5 j à 1 j sans avoir
 * à supprimer d'abord).
 *
 * Validations :
 *   • `collaborator_id` doit pointer un collab existant.
 *   • `date` au format ISO YYYY-MM-DD (validation Zod côté API).
 *   • `fraction ∈ {0.25, 0.5, 0.75, 1}`.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{collaborator_id:string, date:string, fraction:number}} input
 * @returns {{version:number, absence:object}}
 */
export function addAbsence(db, input) {
  const tx = db.transaction(() => {
    const col = db
      .prepare(`SELECT 1 AS x FROM collaborators WHERE id = ?`)
      .get(input.collaborator_id)
    if (!col) {
      const err = new Error(`Collaborator not found: ${input.collaborator_id}`)
      err.code = 'COLLABORATOR_NOT_FOUND'
      throw err
    }
    const f = Number(input.fraction)
    if (!ALLOWED_ABSENCE_FRACTIONS.has(f)) {
      const err = new Error(
        `fraction must be one of 0.25, 0.5, 0.75, 1 (got ${input.fraction})`,
      )
      err.code = 'INVALID_ABSENCE_FRACTION'
      throw err
    }
    db.prepare(
      `INSERT INTO collaborator_absences (collaborator_id, date, fraction)
         VALUES (?, ?, ?)
         ON CONFLICT(collaborator_id, date) DO UPDATE SET fraction = excluded.fraction`,
    ).run(input.collaborator_id, input.date, f)
    const version = bumpVersion(db)
    const absence = db
      .prepare(
        `SELECT collaborator_id, date, fraction FROM collaborator_absences
           WHERE collaborator_id = ? AND date = ?`,
      )
      .get(input.collaborator_id, input.date)
    return { version, absence }
  })
  return tx()
}

/**
 * v2.0 / F3 — Supprime une absence par (collab, date). No-op si absente
 * (cohérent avec le reste du DAL).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} collaboratorId
 * @param {string} date  YYYY-MM-DD
 * @returns {{version:number, changed:boolean}}
 */
export function deleteAbsence(db, collaboratorId, date) {
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `DELETE FROM collaborator_absences
           WHERE collaborator_id = ? AND date = ?`,
      )
      .run(collaboratorId, date)
    if (info.changes === 0) return { version: getVersion(db), changed: false }
    const version = bumpVersion(db)
    return { version, changed: true }
  })
  return tx()
}

// -----------------------------------------------------------------------------
// v2.0 / F6 — TASK_ASSIGNMENTS (multi-collab par activité)
// -----------------------------------------------------------------------------

/**
 * v2.0 / F6 — Liste les ids des collaborateurs affectés à une tâche, triés
 * par id ASC pour un ordre déterministe (utilisé pour l'alias legacy
 * `collaborator_id` = 1er affecté).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} taskId
 * @returns {string[]}  Ids des collabs affectés.
 */
export function listTaskAssignments(db, taskId) {
  return db
    .prepare(
      `SELECT collaborator_id AS id
         FROM task_assignments
         WHERE task_id = ?
         ORDER BY collaborator_id ASC`,
    )
    .all(taskId)
    .map((r) => r.id)
}

/**
 * v2.0 / F6 — Remplace ATOMIQUEMENT la liste des affectations d'une tâche.
 * Sécurise les invariants : ignore les collabs inexistants, déduplique, et
 * appelle `ensureCollabIsMember` pour chaque collab (auto-heal de la
 * membership + allocation 100 % par défaut si nécessaire).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} taskId
 * @param {string[]} collabIds
 * @param {string|null} projectId  Projet de la tâche (pour l'auto-heal).
 */
function setTaskAssignments(db, taskId, collabIds, projectId) {
  db.prepare(`DELETE FROM task_assignments WHERE task_id = ?`).run(taskId)
  if (!Array.isArray(collabIds) || collabIds.length === 0) return
  const ins = db.prepare(
    `INSERT OR IGNORE INTO task_assignments(task_id, collaborator_id) VALUES (?, ?)`,
  )
  const seen = new Set()
  for (const cId of collabIds) {
    if (!cId || typeof cId !== 'string') continue
    if (seen.has(cId)) continue
    seen.add(cId)
    const exists = db
      .prepare(`SELECT 1 AS x FROM collaborators WHERE id = ?`)
      .get(cId)
    if (!exists) continue // collab inconnu : on l'ignore silencieusement
    // Auto-heal : assure la membership + une alloc 100 % par défaut.
    ensureCollabIsMember(db, cId, projectId)
    ins.run(taskId, cId)
  }
}

/**
 * v2.0 / F6 — Résout le tableau d'ids de collaborateurs depuis un payload
 * Create/Update, en supportant les deux formats :
 *   • Nouveau : `collaborator_ids: string[]` → utilisé tel quel.
 *   • Legacy  : `collaborator_id: string|null` → converti en tableau (0 ou 1
 *     élément). `null` → tableau vide (= retire toutes les affectations).
 *
 * Retourne `null` si AUCUN des deux champs n'est présent (= le caller ne
 * veut pas toucher aux affectations — patch sans clé d'affectation).
 *
 * @param {object} input
 * @returns {string[]|null}
 */
function resolveAssignmentsInput(input) {
  if (Array.isArray(input.collaborator_ids)) {
    return input.collaborator_ids.filter((x) => typeof x === 'string' && x)
  }
  if (Object.prototype.hasOwnProperty.call(input, 'collaborator_id')) {
    return input.collaborator_id ? [input.collaborator_id] : []
  }
  return null
}

/**
 * v2.0 / F6 — Persiste les affectations multi-collab d'une activité fraîchement
 * créée, et réaligne le champ legacy `tasks.collaborator_id` sur le 1er
 * affecté (ordre alpha). Factorisé pour limiter la complexité de `createTask`.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} input    Payload de création (cf. createTask).
 * @param {string} projectId Projet de la tâche (pour l'auto-heal membership).
 */
/**
 * v1.8 — Résout l'id de projet à utiliser pour une tâche fraîchement créée :
 *   • Si fourni dans le payload → utilisé tel quel.
 *   • Sinon → 1er projet par position.
 *   • Sinon → crée le projet par défaut à la volée et retourne son id.
 *
 * Extrait dans son propre helper pour limiter la complexité cognitive de
 * `createTask` (sonarjs).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string|undefined} explicit Id explicite (input.project_id), peut être undefined.
 * @returns {string}
 */
function resolveTaskProjectId(db, explicit) {
  if (explicit) return explicit
  const first = db
    .prepare(`SELECT id FROM projects ORDER BY position ASC, id ASC LIMIT 1`)
    .get()
  if (first) return first.id
  db.prepare(`INSERT INTO projects(id, name, position) VALUES (?, ?, 0)`).run(
    DEFAULT_PROJECT_ID,
    DEFAULT_PROJECT_NAME,
  )
  return DEFAULT_PROJECT_ID
}

function persistAssignmentsForCreate(db, input, projectId) {
  const assignList = resolveAssignmentsInput(input)
  if (assignList !== null) {
    setTaskAssignments(db, input.id, assignList, projectId)
    // Réaligne le legacy collaborator_id sur le 1er affecté (ordre alpha).
    const sorted = [...assignList].sort()
    const firstCollab = sorted[0] ?? null
    db.prepare(`UPDATE tasks SET collaborator_id = ? WHERE id = ?`).run(
      firstCollab,
      input.id,
    )
  } else if (input.collaborator_id) {
    // Compat : aucun nouveau champ mais collaborator_id fourni → 1 entrée.
    setTaskAssignments(db, input.id, [input.collaborator_id], projectId)
  }
}

/**
 * v2.0 / F6 — Synchronise les affectations d'une tâche updatée depuis le
 * patch reçu. Politique :
 *   • Jalon / phase → vide toujours (cohérent avec collaborator_id=null).
 *   • Activité avec collaborator_ids[] OU collaborator_id dans le patch →
 *     remplacement atomique + réalignement du legacy collaborator_id.
 *   • Sinon (patch sans clé d'affectation) → no-op (liste actuelle préservée).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id     Id de la tâche.
 * @param {object} next   Tâche après application du patch (kind, project_id).
 * @param {object} patch  Le patch brut (pour détecter quelles clés ont été fournies).
 */
function persistAssignmentsForUpdate(db, id, next, patch) {
  if (next.kind !== 'task') {
    setTaskAssignments(db, id, [], next.project_id)
    return
  }
  const assignList = resolveAssignmentsInput(patch)
  if (assignList === null) return // patch sans clé d'affectation → no-op
  setTaskAssignments(db, id, assignList, next.project_id)
  // Réaligne `collaborator_id` legacy sur le 1er affecté (ordre alpha).
  const sorted = [...assignList].sort()
  const firstCollab = sorted[0] ?? null
  db.prepare(`UPDATE tasks SET collaborator_id = ? WHERE id = ?`).run(
    firstCollab,
    id,
  )
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
function resolveChargeAndEnd(next, patch, db, isUpdate = false) {
  if (next.kind === 'milestone') {
    return { charge_jours: null, end_date: next.start_date }
  }
  if (next.kind === 'phase') {
    // Une phase n'a pas de charge propre ; sa fin est recalculée depuis ses
    // enfants par `recomputePhaseDates`. On garde l'end_date courante (sera
    // écrasée juste après par la synthèse).
    return { charge_jours: null, end_date: next.end_date || next.start_date }
  }
  // v2.0 / F2/F6 — Helper local : calcule la fin d'une activité depuis sa
  // charge en consommant la capacité quotidienne SOMMÉE de tous les collabs
  // affectés (multi-collab additif). Si `db` n'est pas fourni (cas
  // exceptionnel) ou si la tâche n'a aucun collab, on retombe sur F0.
  //
  // Source de vérité : `next.collaborator_ids` si fourni (multi-collab), sinon
  // fallback sur `next.collaborator_id` (legacy mono-collab).
  let collabIdsForCalc = []
  if (Array.isArray(next.collaborator_ids)) {
    collabIdsForCalc = next.collaborator_ids
  } else if (next.collaborator_id) {
    collabIdsForCalc = [next.collaborator_id]
  }
  const endFromCharge = (start, c) =>
    db
      ? addWorkingDaysWithAllocationServer(
          db,
          start,
          c,
          next.project_id,
          collabIdsForCalc,
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
  // v2.2 / RG-W — Cas 3a' : si charge ET end_date sont TOUS DEUX fournis par
  // le client (signal du Replan ou d'un éditeur qui contrôle les trois),
  // les deux valeurs sont honorées telles quelles. Pas de back-dérivation,
  // pas de recalcul. Ce cas court-circuite 3a (qui écraserait end) et 3b
  // (qui back-dériverait charge — bug B1 historique du Replan).
  // N'est actif que lors d'un PATCH (isUpdate=true) : à la création, si
  // charge_jours est fourni, end doit toujours être recalculée (cas 3a normal).
  if (isUpdate && hasExplicitCharge && hasExplicitEnd) {
    const c = Math.max(1, Math.floor(Number(patch.charge_jours)))
    return { charge_jours: c, end_date: patch.end_date }
  }
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
    // v1.8 — Résolution du projet de rattachement extraite dans un helper
    // pour limiter la complexité cognitive de `createTask` (sonarjs).
    const projectId = resolveTaskProjectId(db, input.project_id)
    // v2.0 / F6 — Résout la liste multi-collab depuis le payload. Priorité au
    // tableau `collaborator_ids` (nouveau format), fallback sur l'unique
    // `collaborator_id` (legacy). Ne s'applique qu'aux activités.
    let draftCollabIds = []
    if (kind === 'task') {
      const fromPatch = resolveAssignmentsInput(input)
      if (fromPatch !== null) {
        draftCollabIds = fromPatch
      } else if (input.collaborator_id) {
        draftCollabIds = [input.collaborator_id]
      }
    }
    // v2.0 / F1 — Garde : interdit l'affectation de chaque collab non membre
    // du projet (RG-GANTT-1200). Auto-heal côté DAL — l'UI filtre en amont.
    if (kind === 'task') {
      for (const cId of draftCollabIds) {
        ensureCollabIsMember(db, cId, projectId)
      }
    }
    // v1.24 — SNET : on applique la contrainte « ne doit pas démarrer avant le »
    // en dernière étape, après que la cascade prédécesseur a déjà fixé
    // {startDate, endDate}. La règle « plus tardif gagne » est ainsi respectée.
    // v2.0 — La charge devient la source de vérité : on résout d'abord
    // {charge_jours, end_date} via resolveChargeAndEnd, PUIS on applique SNET
    // qui pourra repousser start (et l'end suivra en préservant la charge).
    // v2.0 / F2/F6 — On passe `project_id` ET la liste multi-collab dans le
    // `next` virtuel pour que resolveChargeAndEnd consomme la capacité
    // sommée plutôt que les seuls jours ouvrés bruts.
    const resolved = resolveChargeAndEnd(
      {
        kind,
        start_date: startDate,
        end_date: endDate,
        charge_jours: null,
        project_id: projectId,
        collaborator_id:
          kind === 'task' ? (input.collaborator_id ?? null) : null,
        collaborator_ids: draftCollabIds,
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
      // v2.0 / F4 — FNLT : deadline non-bloquante. On la persiste telle quelle,
      // aucun enforcement sur les dates (contrairement à SNET).
      not_later_than_date: normalizeNotLaterThanDate(
        input.not_later_than_date,
        kind,
      ),
    }
    enforceNotBeforeDate(draft, db)

    db.prepare(
      `INSERT INTO tasks
        (id, name, kind, start_date, end_date, progress,
         collaborator_id, color, parent_id, predecessor_id,
         predecessor_lag, priority, not_before_date, not_later_than_date,
         charge_jours, position, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      // v2.0 / F4 — FNLT : valeur saisie ou null si phase / format invalide.
      draft.not_later_than_date,
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
    // v2.0 / F6 — Persiste les affectations multi-collab + réaligne le
    // champ legacy. Logique factorisée dans persistAssignmentsForCreate
    // pour limiter la complexité cognitive de `createTask` (sonarjs).
    if (kind === 'task') {
      persistAssignmentsForCreate(db, input, projectId)
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
    // v2.0 / F6 — Enrichit avec la liste multi-collab (alias legacy déjà
    // posé en base juste avant via l'UPDATE).
    task.collaborators = listTaskAssignments(db, input.id).map((id) => ({ id }))
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
    // v2.0 / F4 — Normalise la FNLT (null pour phase, ISO sinon, null si invalide).
    next.not_later_than_date = normalizeNotLaterThanDate(
      next.not_later_than_date,
      next.kind,
    )
    // v2.0 / F6 — Résout la liste multi-collab pour ce patch :
    //   • Si le patch porte un nouveau jeu (collaborator_ids[] ou collaborator_id)
    //     → on utilise cette nouvelle liste,
    //   • Sinon → on lit les assignments actuels (qui ne bougent pas).
    let collabIdsForCalc
    const patchAssigns = resolveAssignmentsInput(patch)
    if (patchAssigns !== null) {
      collabIdsForCalc = patchAssigns
    } else {
      collabIdsForCalc = listTaskAssignments(db, id)
    }
    next.collaborator_ids = next.kind === 'task' ? collabIdsForCalc : []
    // v2.0 / F1 — Garde : interdit l'affectation de chaque collab non membre
    // du projet (RG-GANTT-1200). Auto-heal côté DAL.
    if (next.kind === 'task') {
      for (const cId of next.collaborator_ids) {
        ensureCollabIsMember(db, cId, next.project_id)
      }
    }
    // v2.0 — Résolution charge_jours / end_date AVANT l'enforcement SNET pour
    // que ce dernier puisse repousser start tout en préservant la nouvelle
    // charge calculée. Politique gérée par resolveChargeAndEnd :
    //   • charge_jours explicite → end = start + charge,
    //   • end_date explicite (drag bord droit) → charge back-dérivée,
    //   • sinon → charge existante conservée, end recalculée depuis start.
    // v2.0 / F2/F6 — `db` + `next.collaborator_ids` permettent au recalcul
    // de consommer la capacité SOMMÉE des collabs jour par jour.
    const resolved = resolveChargeAndEnd(next, patch, db, true)
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
             priority = ?, not_before_date = ?, not_later_than_date = ?,
             charge_jours = ?
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
      // v2.0 / F4 — FNLT persistée (non bloquante).
      next.not_later_than_date,
      next.charge_jours,
      id,
    )
    // v2.0 / F6 — Synchronise les affectations multi-collab depuis le patch.
    // Politique factorisée dans `persistAssignmentsForUpdate` pour limiter la
    // complexité cognitive de `updateTask` (sonarjs).
    persistAssignmentsForUpdate(db, id, next, patch)
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
