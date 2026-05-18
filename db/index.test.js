// =============================================================================
// TESTS — Couche DAL SQLite (Vitest, base :memory:)
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createCollaborator,
  createTask,
  deleteCollaborator,
  deleteTask,
  DEMO_STATE,
  getFullState,
  getVersion,
  initDb,
  isDatabaseEmpty,
  moveTask,
  replaceFullState,
  resetToDemo,
  updateCollaborator,
  updateTask,
} from './index.js'

describe('initDb', () => {
  it('crée les tables et la version 0', () => {
    const db = initDb(':memory:')
    expect(getVersion(db)).toBe(0)
    expect(isDatabaseEmpty(db)).toBe(true)
  })

  it('migre une base ancienne (sans predecessor_id) sans erreur', async () => {
    // Simule une base v1.0/v1.1 : on ouvre directement better-sqlite3,
    // on crée la table tasks AVEC l'ancien schéma (sans predecessor_id),
    // puis on ferme. Quand initDb la rouvre, la migration ALTER TABLE
    // doit s'exécuter et la colonne doit apparaître.
    const Database = (await import('better-sqlite3')).default
    const tmpFile = `/tmp/gantt-migration-test-${Date.now()}.db`
    const old = new Database(tmpFile)
    old.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE collaborators (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#3b82f6', position INTEGER NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'task',
        start_date TEXT NOT NULL, end_date TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        collaborator_id TEXT, color TEXT,
        parent_id TEXT, position INTEGER NOT NULL
      );
      INSERT INTO meta(key, value) VALUES ('version', '5');
    `)
    old.close()

    // Ne doit pas lever : la migration ajoute predecessor_id.
    const db = initDb(tmpFile)
    const cols = db
      .prepare(`PRAGMA table_info(tasks)`)
      .all()
      .map((c) => c.name)
    expect(cols).toContain('predecessor_id')
    db.close()
  })
})

describe('createCollaborator', () => {
  let db
  beforeEach(() => {
    db = initDb(':memory:')
  })

  it('insère et incrémente la version', () => {
    const r = createCollaborator(db, { id: 'c1', name: 'Alice' })
    expect(r.version).toBe(1)
    expect(r.collaborator.name).toBe('Alice')
    expect(r.collaborator.color).toBe('#3b82f6') // défaut
  })

  it('positions auto-incrémentées', () => {
    createCollaborator(db, { id: 'c1', name: 'A' })
    const r2 = createCollaborator(db, { id: 'c2', name: 'B' })
    expect(r2.collaborator.position).toBe(1)
  })
})

describe('updateCollaborator', () => {
  let db
  beforeEach(() => {
    db = initDb(':memory:')
    createCollaborator(db, { id: 'c1', name: 'Alice', color: '#000000' })
  })

  it('renomme', () => {
    const r = updateCollaborator(db, 'c1', { name: 'Alicia' })
    expect(r.changed).toBe(true)
    expect(getFullState(db).collaborators[0].name).toBe('Alicia')
  })

  it('inconnu → changed=false', () => {
    expect(updateCollaborator(db, 'inconnu', { name: 'X' }).changed).toBe(false)
  })
})

describe('deleteCollaborator', () => {
  let db
  beforeEach(() => {
    db = initDb(':memory:')
    createCollaborator(db, { id: 'c1', name: 'Alice' })
    createTask(db, {
      id: 't1',
      name: 'Tâche',
      start_date: '2026-05-01',
      end_date: '2026-05-05',
      collaborator_id: 'c1',
    })
  })

  it('supprime + détache les tâches (SET NULL)', () => {
    const r = deleteCollaborator(db, 'c1')
    expect(r.changed).toBe(true)
    const state = getFullState(db)
    expect(state.collaborators).toHaveLength(0)
    expect(state.tasks[0].collaborator_id).toBeNull()
  })
})

describe('createTask', () => {
  let db
  beforeEach(() => {
    db = initDb(':memory:')
  })

  it('insère une tâche normale', () => {
    const r = createTask(db, {
      id: 't1',
      name: 'X',
      start_date: '2026-05-01',
      end_date: '2026-05-10',
    })
    expect(r.task.kind).toBe('task')
    expect(r.task.progress).toBe(0)
  })

  it('jalon : end_date = start_date forcé', () => {
    const r = createTask(db, {
      id: 'm1',
      name: 'J',
      kind: 'milestone',
      start_date: '2026-05-15',
      end_date: '2026-05-20',
    })
    expect(r.task.end_date).toBe('2026-05-15')
  })

  // v1.24 — Règle Pr2 : la priorité est obligatoire sur les activités (défaut 3),
  // et inexistante sur les jalons.
  it('v1.24 / Pr2 — activité créée sans priorité → priorité 3 par défaut', () => {
    const r = createTask(db, {
      id: 't_default_prio',
      name: 'A',
      start_date: '2026-06-08',
      end_date: '2026-06-08',
    })
    expect(r.task.priority).toBe(3)
  })

  it('v1.24 / Pr2 — jalon créé avec priorité → priorité forcée à null', () => {
    const r = createTask(db, {
      id: 'm_prio',
      name: 'Démo',
      kind: 'milestone',
      start_date: '2026-06-08',
      priority: 1,
    })
    expect(r.task.priority).toBeNull()
  })

  // v1.24 — RG-GANTT-0201 : un jalon n'a pas de charge. Même si l'utilisateur
  // tente de saisir une end_date différente de start_date, le serveur la
  // ramène à start_date (la durée d'un jalon est toujours nulle).
  it('v1.24 / RG-GANTT-0201 — jalon : impossible de lui donner une charge (end forcée = start)', () => {
    const r = createTask(db, {
      id: 'mc',
      name: 'Démo',
      kind: 'milestone',
      start_date: '2026-06-08',
      end_date: '2026-06-20', // tentative de charge → ignorée
    })
    expect(r.task.end_date).toBe('2026-06-08')
    // Et un PATCH qui modifie end_date sans toucher au type est lui aussi
    // ramené : un jalon reste ponctuel après n'importe quel update.
    updateTask(db, 'mc', { end_date: '2026-07-01' })
    const t = getFullState(db).tasks.find((t) => t.id === 'mc')
    expect(t.end_date).toBe(t.start_date)
  })

  // v1.24 — RG-GANTT-0205 : un jalon peut être rattaché à une phase parente
  // (et une seule). On vérifie l'invariant : sa start est intégrée dans le
  // MIN/MAX de la phase.
  it('v1.24 / RG-GANTT-0205 — jalon enfant d`une phase : la phase intègre sa date', () => {
    createTask(db, {
      id: 'P',
      name: 'Phase A',
      kind: 'phase',
      start_date: '2026-06-01',
      end_date: '2026-06-01',
    })
    createTask(db, {
      id: 'mj',
      name: 'Jalon dans phase',
      kind: 'milestone',
      start_date: '2026-06-25',
      parent_id: 'P',
    })
    const ph = getFullState(db).tasks.find((t) => t.id === 'P')
    // La phase synthétise les dates des enfants → end = date du jalon.
    expect(ph.end_date).toBe('2026-06-25')
  })

  // v1.24 — RG-GANTT-0701 : la contrainte SNET est facultative. Une activité
  // créée sans `not_before_date` doit l'avoir à null en base.
  it('v1.24 / RG-GANTT-0701 — SNET facultatif : null par défaut à la création', () => {
    const r = createTask(db, {
      id: 't_sans_snet',
      name: 'Sans SNET',
      start_date: '2026-06-08',
      end_date: '2026-06-08',
    })
    expect(r.task.not_before_date).toBeNull()
  })

  // v1.24 — Règle J3 : un jalon créé avec un collaborateur ne le conserve pas.
  it('v1.24 / J3 — un jalon créé avec un collaborateur a collaborator_id = null', () => {
    // On crée d'abord un collaborateur de référence.
    db.prepare(
      `INSERT INTO collaborators(id, name, color, position) VALUES (?, ?, ?, ?)`,
    ).run('c1', 'Léa', '#3b82f6', 0)
    const r = createTask(db, {
      id: 'm1',
      name: 'Démo',
      kind: 'milestone',
      start_date: '2026-05-15',
      collaborator_id: 'c1',
    })
    expect(r.task.collaborator_id).toBeNull()
  })
})

describe('updateTask', () => {
  let db
  beforeEach(() => {
    db = initDb(':memory:')
    createTask(db, {
      id: 't1',
      name: 'X',
      start_date: '2026-05-01',
      end_date: '2026-05-10',
    })
  })

  it('met à jour le progress', () => {
    updateTask(db, 't1', { progress: 50 })
    expect(getFullState(db).tasks[0].progress).toBe(50)
  })

  it('passage en jalon → end_date réalignée', () => {
    updateTask(db, 't1', { kind: 'milestone' })
    const t = getFullState(db).tasks[0]
    expect(t.end_date).toBe(t.start_date)
  })

  // v1.24 — Contrainte SNET : la date de début ne peut pas être antérieure
  // à la date de démarrage au plus tôt. Si elle l'est, le serveur relève start au prochain
  // jour ouvré de la date de démarrage au plus tôt et préserve la charge.
  it('v1.24 / SNET — start_date relevée à la date de démarrage au plus tôt si en deçà', () => {
    updateTask(db, 't1', {
      start_date: '2026-05-01',
      end_date: '2026-05-08',
      not_before_date: '2026-05-15',
    })
    const t = getFullState(db).tasks[0]
    expect(t.not_before_date).toBe('2026-05-15')
    expect(t.start_date).toBe('2026-05-15')
    // Charge préservée : 2026-05-01 → 2026-05-08 = 6 jours ouvrés
    // (semaine du 27 au 1er ferié + 4 jours suivants + WE) — on vérifie
    // simplement que la fin est postérieure ou égale au début.
    expect(t.end_date >= t.start_date).toBe(true)
  })

  it('v1.24 / SNET — date de démarrage au plus tôt un week-end → snap au prochain jour ouvré', () => {
    // 2026-05-16 = samedi → snap au lundi 18/05.
    updateTask(db, 't1', {
      start_date: '2026-05-01',
      end_date: '2026-05-01',
      not_before_date: '2026-05-16',
    })
    expect(getFullState(db).tasks[0].start_date).toBe('2026-05-18')
  })

  // v1.24 — RG-GANTT-0703 : si une tâche a à la fois un prédécesseur et un
  // SNET, sa date de début effective doit respecter le PLUS TARDIF des deux.
  it('v1.24 / SNET RG-GANTT-0703 — SNET > pred.end : le SNET gagne', () => {
    // Pred X finit le 08/06/2026 (lundi). Y a un SNET au 22/06 (lundi suivant).
    // → Y doit démarrer le 22/06, pas le 09/06.
    createTask(db, {
      id: 'x',
      name: 'X',
      start_date: '2026-06-08',
      end_date: '2026-06-08',
    })
    createTask(db, {
      id: 'y',
      name: 'Y',
      start_date: '2026-06-09',
      end_date: '2026-06-09',
      predecessor_id: 'x',
      predecessor_lag: 0,
      not_before_date: '2026-06-22',
    })
    const y = getFullState(db).tasks.find((t) => t.id === 'y')
    expect(y.start_date).toBe('2026-06-22')
  })

  it('v1.24 / SNET RG-GANTT-0703 — pred.end > SNET : le prédécesseur gagne', () => {
    // Pred X finit le 22/06. Y a un SNET au 08/06 (antérieur).
    // → Y doit démarrer après la fin de X, le SNET est silencieusement satisfait.
    createTask(db, {
      id: 'x',
      name: 'X',
      start_date: '2026-06-15',
      end_date: '2026-06-22',
    })
    createTask(db, {
      id: 'y',
      name: 'Y',
      start_date: '2026-06-23',
      end_date: '2026-06-23',
      predecessor_id: 'x',
      predecessor_lag: 0,
      not_before_date: '2026-06-08', // antérieur à pred.end → sans effet
    })
    const y = getFullState(db).tasks.find((t) => t.id === 'y')
    expect(y.start_date >= '2026-06-22').toBe(true)
  })

  it('v1.24 / SNET — phase : la date de démarrage au plus tôt est forcée à null', () => {
    createTask(db, {
      id: 'ph_snet',
      name: 'P',
      kind: 'phase',
      start_date: '2026-06-01',
      end_date: '2026-06-01',
      not_before_date: '2026-07-01',
    })
    const ph = getFullState(db).tasks.find((t) => t.id === 'ph_snet')
    expect(ph.not_before_date).toBeNull()
  })

  // v1.24 — RG-GANTT-0405 : sans prédécesseur, le délai (lag) est forcé à 0.
  // Si on retire le prédécesseur d'une tâche qui en avait un (avec un lag),
  // le serveur efface le lag pour rester cohérent (un lag isolé n'a aucun sens).
  it('v1.24 / RG-GANTT-0405 — retirer le prédécesseur remet predecessor_lag à 0', () => {
    createTask(db, {
      id: 'X',
      name: 'X',
      start_date: '2026-06-08',
      end_date: '2026-06-08',
    })
    // Y a un prédécesseur ET un lag de 3 jours.
    updateTask(db, 't1', {
      predecessor_id: 'X',
      predecessor_lag: 3,
    })
    let y = getFullState(db).tasks.find((t) => t.id === 't1')
    expect(y.predecessor_id).toBe('X')
    expect(y.predecessor_lag).toBe(3)
    // On retire le prédécesseur.
    updateTask(db, 't1', { predecessor_id: null })
    y = getFullState(db).tasks.find((t) => t.id === 't1')
    expect(y.predecessor_id).toBeNull()
    expect(y.predecessor_lag).toBe(0)
  })

  // v1.24 — Règle J3 : passer une activité affectée en jalon efface le collab.
  it('v1.24 / J3 — passage en jalon → collaborator_id forcé à null', () => {
    db.prepare(
      `INSERT INTO collaborators(id, name, color, position) VALUES (?, ?, ?, ?)`,
    ).run('c1', 'Léa', '#3b82f6', 0)
    updateTask(db, 't1', { collaborator_id: 'c1' })
    expect(getFullState(db).tasks[0].collaborator_id).toBe('c1')
    updateTask(db, 't1', { kind: 'milestone' })
    expect(getFullState(db).tasks[0].collaborator_id).toBeNull()
  })
})

describe('v1.9 — cascade aux successeurs', () => {
  let db
  beforeEach(() => {
    db = initDb(':memory:')
    // v1.23 — Scénarios shiftés sur la semaine du 08/06/2026 (sans jour
    // férié français) pour rester focalisés sur la sémantique de cascade,
    // sans interférence avec Pentecôte (25/05) ou Ascension (14/05).
    // X : lundi 08/06 → vendredi 12/06 (5 jours ouvrés).
    createTask(db, {
      id: 'X',
      name: 'X',
      start_date: '2026-06-08',
      end_date: '2026-06-12',
    })
    // Y : prédécesseur=X → start initialisé à la fin de X (lag inféré = 0).
    // Charge 3 j ouvrés (ven 12/06 → mar 16/06 en sautant le w-e).
    createTask(db, {
      id: 'Y',
      name: 'Y',
      start_date: '2026-06-12',
      end_date: '2026-06-16',
      predecessor_id: 'X',
    })
  })

  /** Helper pour récupérer une tâche par id depuis l'état courant. */
  function get(id) {
    return getFullState(db).tasks.find((t) => t.id === id)
  }

  it('allonger X : Y est repoussé en conservant sa charge', () => {
    // X passe de 12/06 à 17/06 (mer) → +3 j ouvrés.
    updateTask(db, 'X', { end_date: '2026-06-17' })
    const y = get('Y')
    // Y démarre à la nouvelle fin de X (mer 17/06).
    expect(y.start_date).toBe('2026-06-17')
    // Charge conservée = 3 j ouvrés → mer + 2 = ven 19/06.
    expect(y.end_date).toBe('2026-06-19')
  })

  it('raccourcir X : Y reste sur place (lag = MINIMUM, v1.23)', () => {
    // v1.23 — Le lag est désormais un délai MINIMUM. Réduire X ne tire plus
    // Y en arrière (changement vs. v1.10). Y conserve sa start initiale.
    updateTask(db, 'X', { end_date: '2026-06-10' })
    const y = get('Y')
    expect(y.start_date).toBe('2026-06-12')
    expect(y.end_date).toBe('2026-06-16')
  })

  it("v1.10 / v1.23 — le délai (predecessor_lag) est respecté lors d'un allongement", () => {
    // Pose un délai de 2 j ouvrés sur Y.
    updateTask(db, 'Y', { predecessor_lag: 2 })
    let y = get('Y')
    // X.end = ven 12/06 ; lag=2 ⇒ Y.start = base + 4 j ouvrés
    // = ven 12 (1) + lun 15 (2) + mar 16 (3) + mer 17 (4) → mer 17/06.
    // (v1.23 : lag = nombre de j ouvrés STRICTEMENT entre — cf.
    //  computeSuccessorStart.)
    expect(y.start_date).toBe('2026-06-17')
    // Charge initiale conservée (3 j ouvrés) → mer 17 + 2 = ven 19/06.
    expect(y.end_date).toBe('2026-06-19')
    // X allongé jusqu'au 17/06 → Y poussé en gardant le délai de 2.
    updateTask(db, 'X', { end_date: '2026-06-17' })
    y = get('Y')
    // X.end = mer 17/06 ; lag=2 → 17(1) + 18(2) + 19(3) + WE + 22(4) → lun 22/06.
    expect(y.start_date).toBe('2026-06-22')
  })

  it("v1.23 — le délai n'est PAS rétro-appliqué lors d'un raccourcissement", () => {
    // Sémantique « minimum » : si X raccourcit, Y reste sur place dès lors
    // que sa start_date courante respecte encore le minimum.
    updateTask(db, 'Y', { predecessor_lag: 2 })
    // Y.start est maintenant à mer 17/06 (cf. test précédent).
    updateTask(db, 'X', { end_date: '2026-06-10' })
    const y = get('Y')
    // X.end = 10/06 ; minStart(lag=2) = lun 15/06 ; Y.start (17/06) ≥ minStart
    // → on ne touche pas à Y.
    expect(y.start_date).toBe('2026-06-17')
  })

  it('chaîne X → Y → Z : la cascade se propage récursivement', () => {
    // Z : prédécesseur = Y, charge 2 j ouvrés.
    createTask(db, {
      id: 'Z',
      name: 'Z',
      start_date: '2026-06-16',
      end_date: '2026-06-17',
      predecessor_id: 'Y',
    })
    // X étendu de 12/06 (ven) à 19/06 (ven, +5 j ouvrés).
    updateTask(db, 'X', { end_date: '2026-06-19' })
    const y = get('Y')
    const z = get('Z')
    // Y poussé à 19/06 (ven), charge=3 j → fin mar 23/06.
    expect(y.start_date).toBe('2026-06-19')
    expect(y.end_date).toBe('2026-06-23')
    // Z poussé à 23/06 (mar), charge=2 j → fin mer 24/06.
    expect(z.start_date).toBe('2026-06-23')
    expect(z.end_date).toBe('2026-06-24')
  })

  it('la nouvelle fin de X qui tombe un week-end est snappée au lundi pour Y', () => {
    // X.end = samedi 13/06 (cas pathologique : saisie manuelle).
    updateTask(db, 'X', { end_date: '2026-06-13' })
    const y = get('Y')
    // Y.start (12) < X.end (13) → pousser ; snap au lun 15/06 (pas férié).
    expect(y.start_date).toBe('2026-06-15')
  })

  it('jalon successeur : end suit start (pas de charge à propager)', () => {
    // M : jalon avec prédécesseur = X.
    createTask(db, {
      id: 'M',
      name: 'M',
      kind: 'milestone',
      start_date: '2026-06-12',
      end_date: '2026-06-12',
      predecessor_id: 'X',
    })
    updateTask(db, 'X', { end_date: '2026-06-17' })
    const m = get('M')
    expect(m.start_date).toBe('2026-06-17')
    expect(m.end_date).toBe('2026-06-17')
  })
})

// =============================================================================
// v1.21 — Multi-prédécesseurs (table N:M `task_predecessors`)
// =============================================================================
describe('v1.21 — multi-prédécesseurs', () => {
  let db
  beforeEach(() => {
    db = initDb(':memory:')
    // Base : deux activités sources A (08→12/06) et B (08→17/06).
    createTask(db, {
      id: 'A',
      name: 'A',
      start_date: '2026-06-08',
      end_date: '2026-06-12',
    })
    createTask(db, {
      id: 'B',
      name: 'B',
      start_date: '2026-06-08',
      end_date: '2026-06-17',
    })
  })

  /** Helper de lecture d'une tâche par id depuis l'état courant. */
  function get(id) {
    return getFullState(db).tasks.find((t) => t.id === id)
  }

  it('createTask avec predecessors[] = 2 préds → start = MAX(pred.end)', () => {
    createTask(db, {
      id: 'Y',
      name: 'Y',
      start_date: '2026-06-01',
      end_date: '2026-06-02',
      predecessors: [
        { id: 'A', lag: 0 },
        { id: 'B', lag: 0 },
      ],
    })
    const y = get('Y')
    // B finit plus tard (17/06) que A (12/06) → MAX = 17/06.
    expect(y.start_date).toBe('2026-06-17')
    // La liste est exposée et triée par id ASC (déterministe).
    expect(y.predecessors).toEqual([
      { id: 'A', lag: 0 },
      { id: 'B', lag: 0 },
    ])
  })

  it('lag par lien : MAX prend le plus tardif (pred + lag)', () => {
    // Sémantique v1.23 de `computeSuccessorStart(predEnd, lag)` :
    //   • lag = 0 → start = snapForward(predEnd)
    //   • lag > 0 → start = addWorkingDays(snapForward(predEnd), lag + 2)
    // A.end = ven 12/06 + lag=5 → 12→(15→16→17→18→19→22) = lun 22/06.
    // B.end = mer 17/06 + lag=0 → mer 17/06.
    // MAX = lun 22/06.
    createTask(db, {
      id: 'Y',
      name: 'Y',
      start_date: '2026-06-01',
      end_date: '2026-06-02',
      predecessors: [
        { id: 'A', lag: 5 },
        { id: 'B', lag: 0 },
      ],
    })
    expect(get('Y').start_date).toBe('2026-06-22')
  })

  it("cascade MAX : allonger un pred non-critique ne bouge pas Y tant qu'il ne devient pas le MAX", () => {
    createTask(db, {
      id: 'Y',
      name: 'Y',
      start_date: '2026-06-01',
      end_date: '2026-06-03',
      predecessors: [
        { id: 'A', lag: 0 },
        { id: 'B', lag: 0 },
      ],
    })
    // Y.start = MAX(A.end=12, B.end=17) = 17/06.
    expect(get('Y').start_date).toBe('2026-06-17')
    // Allonger A jusqu'au 15/06 (toujours < B.end=17) → Y reste sur 17/06.
    updateTask(db, 'A', { end_date: '2026-06-15' })
    expect(get('Y').start_date).toBe('2026-06-17')
    // Allonger A jusqu'au 22/06 → A devient le MAX → Y est repoussé à 22/06.
    updateTask(db, 'A', { end_date: '2026-06-22' })
    expect(get('Y').start_date).toBe('2026-06-22')
  })

  it('updateTask predecessors[] vide → la liste est supprimée', () => {
    createTask(db, {
      id: 'Y',
      name: 'Y',
      start_date: '2026-06-01',
      end_date: '2026-06-02',
      predecessors: [{ id: 'A', lag: 0 }],
    })
    expect(get('Y').predecessors.length).toBe(1)
    updateTask(db, 'Y', { predecessors: [] })
    expect(get('Y').predecessors).toEqual([])
  })

  it('anti-cycle indirect : A→B→C, on rejette silencieusement le lien C→A', () => {
    // On construit le chemin A→B→C (= B.preds=[A], C.preds=[B]), puis on
    // tente d'ajouter C comme prédécesseur de A : refermerait la boucle.
    updateTask(db, 'B', { predecessors: [{ id: 'A', lag: 0 }] })
    createTask(db, {
      id: 'C',
      name: 'C',
      start_date: '2026-06-20',
      end_date: '2026-06-21',
      predecessors: [{ id: 'B', lag: 0 }],
    })
    updateTask(db, 'A', { predecessors: [{ id: 'C', lag: 0 }] })
    // Le lien cyclique C→A est filtré → A n'a toujours aucun prédécesseur.
    expect(get('A').predecessors).toEqual([])
  })

  it("suppression d'un prédécesseur → CASCADE depuis task_predecessors", () => {
    createTask(db, {
      id: 'Y',
      name: 'Y',
      start_date: '2026-06-01',
      end_date: '2026-06-02',
      predecessors: [
        { id: 'A', lag: 0 },
        { id: 'B', lag: 0 },
      ],
    })
    expect(get('Y').predecessors.length).toBe(2)
    // Supprime A → la ligne (Y, A) disparaît automatiquement (ON DELETE CASCADE).
    deleteTask(db, 'A')
    expect(get('Y').predecessors).toEqual([{ id: 'B', lag: 0 }])
  })

  it('alias rétro-compat : predecessor_id = 1er pred, predecessor_lag = son lag', () => {
    createTask(db, {
      id: 'Y',
      name: 'Y',
      start_date: '2026-06-01',
      end_date: '2026-06-02',
      predecessors: [
        { id: 'B', lag: 4 },
        { id: 'A', lag: 1 },
      ],
    })
    const y = get('Y')
    // Tri par id ASC : A vient avant B.
    expect(y.predecessor_id).toBe('A')
    expect(y.predecessor_lag).toBe(1)
  })

  it('migration : une base v1.20 (predecessor_id en colonne) migre vers task_predecessors', async () => {
    const Database = (await import('better-sqlite3')).default
    const tmpFile = `/tmp/gantt-v121-migration-${Date.now()}.db`
    const old = new Database(tmpFile)
    // Schéma v1.20 simplifié : colonnes predecessor_id / predecessor_lag, pas
    // de table task_predecessors. On insère 1 tâche avec un prédécesseur.
    old.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE collaborators (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#3b82f6', position INTEGER NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'task',
        start_date TEXT NOT NULL, end_date TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        collaborator_id TEXT, color TEXT, parent_id TEXT,
        predecessor_id TEXT, predecessor_lag INTEGER NOT NULL DEFAULT 0,
        priority INTEGER, not_before_date TEXT,
        position INTEGER NOT NULL, project_id TEXT
      );
      INSERT INTO projects(id, name, position) VALUES ('p1', 'P1', 0);
      INSERT INTO tasks (id, name, kind, start_date, end_date, position, project_id)
        VALUES ('a','A','task','2026-06-08','2026-06-12',0,'p1');
      INSERT INTO tasks (id, name, kind, start_date, end_date, position,
                        predecessor_id, predecessor_lag, project_id)
        VALUES ('b','B','task','2026-06-12','2026-06-15',1,'a',3,'p1');
    `)
    old.close()
    // initDb rouvre et déclenche la migration v1.21.
    const migrated = initDb(tmpFile)
    const state = getFullState(migrated)
    const b = state.tasks.find((t) => t.id === 'b')
    expect(b.predecessors).toEqual([{ id: 'a', lag: 3 }])
    expect(b.predecessor_id).toBe('a') // alias rétro-compat
    expect(b.predecessor_lag).toBe(3)
    migrated.close()
  })
})

describe('deleteTask', () => {
  let db
  beforeEach(() => {
    db = initDb(':memory:')
    createTask(db, {
      id: 't1',
      name: 'P',
      start_date: '2026-05-01',
      end_date: '2026-05-10',
    })
    createTask(db, {
      id: 't1a',
      name: 'C',
      start_date: '2026-05-01',
      end_date: '2026-05-05',
      parent_id: 't1',
    })
  })

  it('cascade les enfants', () => {
    deleteTask(db, 't1')
    expect(getFullState(db).tasks).toHaveLength(0)
  })
})

describe('moveTask', () => {
  let db
  beforeEach(() => {
    db = initDb(':memory:')
    // Hiérarchie : P (parent), avec 3 enfants A, B, C en positions 0,1,2
    // + une tâche Q racine
    createTask(db, {
      id: 'P',
      name: 'P',
      start_date: '2026-05-01',
      end_date: '2026-05-30',
    })
    createTask(db, {
      id: 'A',
      name: 'A',
      start_date: '2026-05-01',
      end_date: '2026-05-05',
      parent_id: 'P',
    })
    createTask(db, {
      id: 'B',
      name: 'B',
      start_date: '2026-05-06',
      end_date: '2026-05-10',
      parent_id: 'P',
    })
    createTask(db, {
      id: 'C',
      name: 'C',
      start_date: '2026-05-11',
      end_date: '2026-05-15',
      parent_id: 'P',
    })
    createTask(db, {
      id: 'Q',
      name: 'Q',
      start_date: '2026-06-01',
      end_date: '2026-06-05',
    })
  })

  /** Renvoie l'ordre des enfants d'un parent (id, position). */
  function childrenOf(parentId) {
    return getFullState(db)
      .tasks.filter((t) => t.parent_id === parentId)
      .sort((a, b) => a.position - b.position)
      .map((t) => t.id)
  }

  it("réordonne au sein d'un même parent (insérer C entre A et B)", () => {
    moveTask(db, 'C', { parent_id: 'P', before_id: 'B' })
    expect(childrenOf('P')).toEqual(['A', 'C', 'B'])
  })

  it('change le parent (Q devient enfant de P en dernier)', () => {
    moveTask(db, 'Q', { parent_id: 'P', before_id: null })
    expect(childrenOf('P')).toEqual(['A', 'B', 'C', 'Q'])
    // Q n'est plus en racine
    const racines = getFullState(db).tasks.filter((t) => t.parent_id === null)
    expect(racines.map((t) => t.id)).toEqual(['P'])
  })

  it('change le parent et insère avant un sibling', () => {
    moveTask(db, 'Q', { parent_id: 'P', before_id: 'B' })
    expect(childrenOf('P')).toEqual(['A', 'Q', 'B', 'C'])
  })

  it('détache (parent_id = null) en fin de racine', () => {
    moveTask(db, 'A', { parent_id: null, before_id: null })
    expect(childrenOf('P')).toEqual(['B', 'C'])
    const racines = getFullState(db)
      .tasks.filter((t) => t.parent_id === null)
      .sort((a, b) => a.position - b.position)
      .map((t) => t.id)
    expect(racines).toEqual(['P', 'Q', 'A'])
  })

  it('refuse de devenir son propre parent', () => {
    expect(() =>
      moveTask(db, 'P', { parent_id: 'P', before_id: null }),
    ).toThrow(/son propre parent/)
  })

  it('refuse de se déplacer dans un de ses descendants (cycle)', () => {
    expect(() =>
      moveTask(db, 'P', { parent_id: 'A', before_id: null }),
    ).toThrow(/descendants/)
  })

  it('refuse un parent inexistant', () => {
    expect(() =>
      moveTask(db, 'A', { parent_id: 'inconnu', before_id: null }),
    ).toThrow(/parent introuvable/)
  })

  it('inconnu → changed=false sans throw', () => {
    expect(
      moveTask(db, 'inconnu', { parent_id: null, before_id: null }).changed,
    ).toBe(false)
  })
})

describe('phases (v1.6) — recompute auto des dates', () => {
  let db
  beforeEach(() => {
    db = initDb(':memory:')
    // Phase vide P initialisée à des dates "placeholder" 2026-05-01..2026-05-01
    createTask(db, {
      id: 'P',
      name: 'P',
      kind: 'phase',
      start_date: '2026-05-01',
      end_date: '2026-05-01',
    })
  })

  it('phase : créer une activité enfant recale ses dates', () => {
    createTask(db, {
      id: 'A',
      name: 'A',
      start_date: '2026-06-10',
      end_date: '2026-06-15',
      parent_id: 'P',
    })
    const phase = getFullState(db).tasks.find((t) => t.id === 'P')
    expect(phase.start_date).toBe('2026-06-10')
    expect(phase.end_date).toBe('2026-06-15')
  })

  it('phase : MIN/MAX sur plusieurs enfants', () => {
    createTask(db, {
      id: 'A',
      name: 'A',
      start_date: '2026-06-10',
      end_date: '2026-06-15',
      parent_id: 'P',
    })
    createTask(db, {
      id: 'B',
      name: 'B',
      start_date: '2026-06-05',
      end_date: '2026-06-12',
      parent_id: 'P',
    })
    createTask(db, {
      id: 'C',
      name: 'C',
      start_date: '2026-06-20',
      end_date: '2026-06-25',
      parent_id: 'P',
    })
    const phase = getFullState(db).tasks.find((t) => t.id === 'P')
    expect(phase.start_date).toBe('2026-06-05') // MIN
    expect(phase.end_date).toBe('2026-06-25') // MAX
  })

  it("phase : update d'un enfant recale les dates", () => {
    createTask(db, {
      id: 'A',
      name: 'A',
      start_date: '2026-06-10',
      end_date: '2026-06-15',
      parent_id: 'P',
    })
    updateTask(db, 'A', { end_date: '2026-07-01' })
    const phase = getFullState(db).tasks.find((t) => t.id === 'P')
    expect(phase.end_date).toBe('2026-07-01')
  })

  it("phase : suppression d'un enfant recale les dates", () => {
    createTask(db, {
      id: 'A',
      name: 'A',
      start_date: '2026-06-10',
      end_date: '2026-06-15',
      parent_id: 'P',
    })
    createTask(db, {
      id: 'B',
      name: 'B',
      start_date: '2026-06-20',
      end_date: '2026-06-25',
      parent_id: 'P',
    })
    deleteTask(db, 'B')
    const phase = getFullState(db).tasks.find((t) => t.id === 'P')
    expect(phase.start_date).toBe('2026-06-10')
    expect(phase.end_date).toBe('2026-06-15')
  })

  it('phase imbriquée : recompute remonte récursivement', () => {
    // Crée une sous-phase SP enfant de P, et une activité A enfant de SP.
    createTask(db, {
      id: 'SP',
      name: 'SP',
      kind: 'phase',
      start_date: '2026-05-01',
      end_date: '2026-05-01',
      parent_id: 'P',
    })
    createTask(db, {
      id: 'A',
      name: 'A',
      start_date: '2026-06-10',
      end_date: '2026-06-15',
      parent_id: 'SP',
    })
    const tasks = getFullState(db).tasks
    expect(tasks.find((t) => t.id === 'SP').start_date).toBe('2026-06-10')
    expect(tasks.find((t) => t.id === 'P').start_date).toBe('2026-06-10')
    expect(tasks.find((t) => t.id === 'P').end_date).toBe('2026-06-15')
  })

  it('createTask phase : ignore collaborator_id et predecessor_id', () => {
    createCollaborator(db, { id: 'c1', name: 'X' })
    const r = createTask(db, {
      id: 'PX',
      name: 'PX',
      kind: 'phase',
      start_date: '2026-05-01',
      end_date: '2026-05-01',
      collaborator_id: 'c1',
      predecessor_id: 'P',
    })
    expect(r.task.collaborator_id).toBeNull()
    expect(r.task.predecessor_id).toBeNull()
  })

  // v1.24 — RG-GANTT-0301 : une phase SANS ENFANT conserve ses dates
  // inchangées (aucun écrasement). Le recompute auto ne s'exécute QUE quand
  // il y a au moins un enfant à synthétiser.
  it('v1.24 / RG-GANTT-0301 — phase sans enfant : ses dates ne sont pas écrasées', () => {
    const r = createTask(db, {
      id: 'Pseule',
      name: 'Phase solo',
      kind: 'phase',
      start_date: '2026-07-01',
      end_date: '2026-07-15',
    })
    expect(r.task.start_date).toBe('2026-07-01')
    expect(r.task.end_date).toBe('2026-07-15')
    // Un update neutre ne doit pas non plus écraser les dates.
    updateTask(db, 'Pseule', { progress: 0 })
    const ph = getFullState(db).tasks.find((t) => t.id === 'Pseule')
    expect(ph.start_date).toBe('2026-07-01')
    expect(ph.end_date).toBe('2026-07-15')
  })
})

describe('migration : ancien CHECK kind restrictif', () => {
  it("recrée la table tasks pour autoriser kind='phase' sur une base v1.5", async () => {
    const Database = (await import('better-sqlite3')).default
    const tmpFile = `/tmp/gantt-phase-migration-test-${Date.now()}.db`
    const old = new Database(tmpFile)
    old.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE collaborators (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#3b82f6', position INTEGER NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'task',
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        collaborator_id TEXT,
        color TEXT,
        parent_id TEXT,
        predecessor_id TEXT,
        position INTEGER NOT NULL,
        CHECK (kind IN ('task', 'milestone')),
        CHECK (progress BETWEEN 0 AND 100)
      );
      INSERT INTO meta(key, value) VALUES ('version', '7');
      INSERT INTO tasks (id, name, kind, start_date, end_date, position)
        VALUES ('legacy', 'leg', 'task', '2026-01-01', '2026-01-05', 0);
    `)
    old.close()

    // Au boot, la migration doit recréer la table SANS le CHECK restrictif.
    const db = initDb(tmpFile)
    // L'insertion d'une phase ne doit plus planter.
    expect(() =>
      createTask(db, {
        id: 'phaseX',
        name: 'PX',
        kind: 'phase',
        start_date: '2026-01-01',
        end_date: '2026-01-01',
      }),
    ).not.toThrow()
    // Et la donnée legacy est préservée.
    expect(getFullState(db).tasks.find((t) => t.id === 'legacy').name).toBe(
      'leg',
    )
    db.close()
  })
})

describe('replaceFullState / resetToDemo', () => {
  it('charge les données démo', () => {
    const db = initDb(':memory:')
    resetToDemo(db)
    const state = getFullState(db)
    expect(state.collaborators.length).toBe(DEMO_STATE.collaborators.length)
    expect(state.tasks.length).toBe(DEMO_STATE.tasks.length)
  })

  it('atomicité — le 2e reset purge le 1er', () => {
    const db = initDb(':memory:')
    resetToDemo(db)
    const v1 = getVersion(db)
    replaceFullState(db, { collaborators: [], tasks: [] })
    expect(getFullState(db).tasks).toHaveLength(0)
    expect(getVersion(db)).toBeGreaterThan(v1)
  })
})
