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
})

describe('v1.9 — cascade aux successeurs', () => {
  let db
  beforeEach(() => {
    db = initDb(':memory:')
    // X : lundi 18 → vendredi 22 mai (5 jours ouvrés).
    createTask(db, {
      id: 'X',
      name: 'X',
      start_date: '2026-05-18',
      end_date: '2026-05-22',
    })
    // Y : prédécesseur=X → start initialisé à la fin de X.
    // Charge 3 j ouvrés (vendredi → mardi en sautant le w-e).
    createTask(db, {
      id: 'Y',
      name: 'Y',
      start_date: '2026-05-22',
      end_date: '2026-05-26',
      predecessor_id: 'X',
    })
  })

  /** Helper pour récupérer une tâche par id depuis l'état courant. */
  function get(id) {
    return getFullState(db).tasks.find((t) => t.id === id)
  }

  it('allonger X : Y est repoussé en conservant sa charge', () => {
    // X passe de 22 mai à 27 mai (mer) → +3 jours ouvrés.
    updateTask(db, 'X', { end_date: '2026-05-27' })
    const y = get('Y')
    // Y démarre à la nouvelle fin de X (mercredi 27, jour ouvré).
    expect(y.start_date).toBe('2026-05-27')
    // Charge conservée = 3 jours ouvrés → mer + 2 = vendredi 29 mai.
    expect(y.end_date).toBe('2026-05-29')
  })

  it("raccourcir X : Y n'est PAS reculé (décalage volontaire respecté)", () => {
    // X réduit au mercredi 20 mai → fin antérieure à Y.start (22 mai).
    // Comme Y.start (22) >= nouvelle fin de X (20), on ne touche pas à Y.
    updateTask(db, 'X', { end_date: '2026-05-20' })
    const y = get('Y')
    expect(y.start_date).toBe('2026-05-22')
    expect(y.end_date).toBe('2026-05-26')
  })

  it('chaîne X → Y → Z : la cascade se propage récursivement', () => {
    // Z : prédécesseur = Y, charge 2 j ouvrés.
    createTask(db, {
      id: 'Z',
      name: 'Z',
      start_date: '2026-05-26',
      end_date: '2026-05-27',
      predecessor_id: 'Y',
    })
    // X étendu de 22 mai (ven) à 29 mai (ven, +5 j ouvrés).
    updateTask(db, 'X', { end_date: '2026-05-29' })
    const y = get('Y')
    const z = get('Z')
    // Y poussé à 29 mai (ven), charge=3 j → fin mardi 2 juin.
    expect(y.start_date).toBe('2026-05-29')
    expect(y.end_date).toBe('2026-06-02')
    // Z poussé à 2 juin (mar), charge=2 j → fin mercredi 3 juin.
    expect(z.start_date).toBe('2026-06-02')
    expect(z.end_date).toBe('2026-06-03')
  })

  it('la nouvelle fin de X qui tombe un week-end est snappée au lundi pour Y', () => {
    // X.end = samedi 23 mai (cas pathologique : saisie manuelle).
    updateTask(db, 'X', { end_date: '2026-05-23' })
    const y = get('Y')
    // Y.start (22) < X.end (23) → pousser ; snap au lundi 25 mai.
    expect(y.start_date).toBe('2026-05-25')
  })

  it('jalon successeur : end suit start (pas de charge à propager)', () => {
    // M : jalon avec prédécesseur = X.
    createTask(db, {
      id: 'M',
      name: 'M',
      kind: 'milestone',
      start_date: '2026-05-22',
      end_date: '2026-05-22',
      predecessor_id: 'X',
    })
    updateTask(db, 'X', { end_date: '2026-05-27' })
    const m = get('M')
    expect(m.start_date).toBe('2026-05-27')
    expect(m.end_date).toBe('2026-05-27')
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
