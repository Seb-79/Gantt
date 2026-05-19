// =============================================================================
// TESTS — Couche DAL SQLite (Vitest, base :memory:)
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  addAbsence,
  addMemberAllocation,
  addProjectMember,
  createCollaborator,
  createTask,
  deleteAbsence,
  deleteCollaborator,
  deleteMemberAllocation,
  updateMemberAllocation,
  deleteTask,
  DEMO_STATE,
  getFullState,
  getVersion,
  initDb,
  isDatabaseEmpty,
  listAbsences,
  listMemberAllocations,
  listProjectMembers,
  listTaskAssignments,
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

  // v2.0 — Migration ensureChargeColumn : base ancienne SANS charge_jours
  // contenant des activités → la colonne est ajoutée et chaque activité
  // reçoit une charge_jours back-dérivée de son écart courant. Les jalons
  // restent à NULL (pas de notion de charge).
  it('v2.0 / RG-GANTT-0100 — migration : charge_jours initialisée depuis l`écart courant', async () => {
    const Database = (await import('better-sqlite3')).default
    const tmpFile = `/tmp/gantt-charge-migration-test-${Date.now()}.db`
    const old = new Database(tmpFile)
    // Base v1.x : schéma complet SAUF charge_jours.
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
        collaborator_id TEXT, color TEXT,
        parent_id TEXT, predecessor_id TEXT,
        predecessor_lag INTEGER NOT NULL DEFAULT 0,
        priority INTEGER, not_before_date TEXT,
        position INTEGER NOT NULL, project_id TEXT
      );
      INSERT INTO projects(id, name, position) VALUES ('p1', 'P', 0);
      -- Une activité de 5 jours ouvrés (lundi → vendredi).
      INSERT INTO tasks(id, name, kind, start_date, end_date, progress,
                        position, project_id, priority)
        VALUES ('t_act', 'Act', 'task', '2026-05-18', '2026-05-22', 0, 0, 'p1', 3);
      -- Un jalon (start == end).
      INSERT INTO tasks(id, name, kind, start_date, end_date, progress,
                        position, project_id)
        VALUES ('m_jal', 'Jal', 'milestone', '2026-05-20', '2026-05-20', 0, 1, 'p1');
      INSERT INTO meta(key, value) VALUES ('version', '10');
    `)
    old.close()

    const db = initDb(tmpFile)
    const cols = db
      .prepare(`PRAGMA table_info(tasks)`)
      .all()
      .map((c) => c.name)
    expect(cols).toContain('charge_jours')
    // Activité → charge_jours back-dérivée (5 jours ouvrés).
    const act = db.prepare(`SELECT * FROM tasks WHERE id = 't_act'`).get()
    expect(act.charge_jours).toBe(5)
    // Jalon → charge_jours toujours NULL.
    const jal = db.prepare(`SELECT * FROM tasks WHERE id = 'm_jal'`).get()
    expect(jal.charge_jours).toBeNull()
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

  // v2.0 — RG-GANTT-0100 (charge stockée) : à la création d'une activité avec
  // un `end_date` mais pas de `charge_jours`, le DAL back-dérive la charge
  // depuis l'écart en jours ouvrés. Lundi → vendredi = 5 jours ouvrés.
  it('v2.0 / RG-GANTT-0100 — activité créée sans charge_jours : charge back-dérivée depuis (start, end)', () => {
    const r = createTask(db, {
      id: 't_back',
      name: 'Back-dérivation',
      start_date: '2026-05-18', // lundi
      end_date: '2026-05-22', // vendredi de la même semaine
    })
    expect(r.task.charge_jours).toBe(5)
    expect(r.task.end_date).toBe('2026-05-22')
  })

  // v2.0 — RG-GANTT-0100 : si `charge_jours` est fournie explicitement, elle
  // gagne sur `end_date`. La fin est recalculée depuis (start + charge).
  it('v2.0 / RG-GANTT-0100 — charge_jours explicite à la création : end recalculée', () => {
    const r = createTask(db, {
      id: 't_charge',
      name: 'Charge explicite',
      start_date: '2026-05-18', // lundi
      end_date: '2026-05-18', // ignoré
      charge_jours: 5,
    })
    expect(r.task.charge_jours).toBe(5)
    expect(r.task.end_date).toBe('2026-05-22') // lundi + 5 ouvrés = vendredi
  })

  // v2.0 — La charge saute week-ends ET fériés FR (1er mai 2026 = vendredi).
  // Du jeudi 30/04 + 3 jours ouvrés : 30/04, 4/05, 5/05 (1er mai férié sauté).
  it('v2.0 / RG-GANTT-0100 — charge_jours saute les fériés français', () => {
    const r = createTask(db, {
      id: 't_ferie',
      name: 'Charge avec férié',
      start_date: '2026-04-30', // jeudi
      charge_jours: 3,
    })
    // 30/04 (J1) → 01/05 férié → 04/05 lundi (J2) → 05/05 mardi (J3)
    expect(r.task.end_date).toBe('2026-05-05')
  })

  // v2.0 — Jalon : charge_jours est toujours NULL (un jalon est ponctuel).
  it('v2.0 / RG-GANTT-0201 — jalon : charge_jours forcée à NULL même si fournie', () => {
    const r = createTask(db, {
      id: 'm_charge',
      name: 'Jalon avec charge',
      kind: 'milestone',
      start_date: '2026-05-18',
      charge_jours: 7,
    })
    expect(r.task.charge_jours).toBeNull()
    expect(r.task.end_date).toBe('2026-05-18')
  })

  // v2.0 — Phase : charge_jours est toujours NULL (dates dérivées des enfants).
  it('v2.0 / RG-GANTT-0301 — phase : charge_jours toujours NULL', () => {
    const r = createTask(db, {
      id: 'p_charge',
      name: 'Phase',
      kind: 'phase',
      start_date: '2026-05-18',
      end_date: '2026-05-22',
      charge_jours: 99,
    })
    expect(r.task.charge_jours).toBeNull()
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

  // v2.0 — Patch charge_jours seule : end_date est recalculée depuis (start + charge).
  it('v2.0 / RG-GANTT-0100 — patch charge_jours : end_date recalculée', () => {
    // 't1' a été créé dans le beforeEach avec start=2026-05-01, end=2026-05-10.
    // On force d'abord un start propre (lundi 18 mai) pour avoir un cas net.
    updateTask(db, 't1', { start_date: '2026-05-18', charge_jours: 1 })
    let t = getFullState(db).tasks.find((x) => x.id === 't1')
    expect(t.start_date).toBe('2026-05-18')
    expect(t.charge_jours).toBe(1)
    expect(t.end_date).toBe('2026-05-18') // 1 jour ouvré = lundi seul

    updateTask(db, 't1', { charge_jours: 5 })
    t = getFullState(db).tasks.find((x) => x.id === 't1')
    expect(t.charge_jours).toBe(5)
    expect(t.end_date).toBe('2026-05-22') // lundi + 5 ouvrés = vendredi
  })

  // v2.0 — Patch end_date seul (simulation drag bord droit dans GanttChart,
  // Q1 option a) : la charge est back-dérivée depuis (start, new end).
  it('v2.0 / RG-GANTT-0100 — patch end_date seul : charge back-dérivée (drag bord droit)', () => {
    updateTask(db, 't1', { start_date: '2026-05-18', charge_jours: 3 })
    // Drag bord droit : on étire la fin de mercredi (J3) à vendredi (J5).
    updateTask(db, 't1', { end_date: '2026-05-22' })
    const t = getFullState(db).tasks.find((x) => x.id === 't1')
    expect(t.end_date).toBe('2026-05-22')
    expect(t.charge_jours).toBe(5) // back-dérivée
  })

  // v2.0 — Patch start_date seul (simulation drag horizontal "move") : la
  // charge est PRÉSERVÉE et end_date est recalculée depuis le nouveau start.
  // Semaine du 08/06 choisie volontairement (aucun férié FR mobile à proximité).
  it('v2.0 / RG-GANTT-0100 — patch start_date seul : charge préservée, end suit', () => {
    updateTask(db, 't1', { start_date: '2026-06-01', charge_jours: 5 })
    // Drag horizontal d'une semaine vers la droite.
    updateTask(db, 't1', { start_date: '2026-06-08' })
    const t = getFullState(db).tasks.find((x) => x.id === 't1')
    expect(t.start_date).toBe('2026-06-08')
    expect(t.charge_jours).toBe(5) // charge inchangée
    expect(t.end_date).toBe('2026-06-12') // 08/06 + 5 ouvrés = vendredi 12/06
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

// =============================================================================
// v2.0 / F1 — Memberships projet ↔ collaborateur
// =============================================================================
// Couvre :
//   • migration auto-population : les couples (projet, collab) déjà présents
//     dans les tâches deviennent des memberships au boot ;
//   • listProjectMembers : ne renvoie que les membres du projet demandé ;
//   • addProjectMember : idempotent, valide projet/collab ;
//   • ensureCollabIsMember (indirectement) : créer une tâche avec un collab
//     non encore membre crée la membership à la volée.
// =============================================================================

describe('v2.0 / F1 — project_members', () => {
  let db
  beforeEach(() => {
    db = initDb(':memory:')
    // Seed minimal : 2 projets, 2 collabs.
    db.prepare(`INSERT INTO projects(id, name, position) VALUES (?, ?, ?)`).run(
      'pA',
      'Projet A',
      0,
    )
    db.prepare(`INSERT INTO projects(id, name, position) VALUES (?, ?, ?)`).run(
      'pB',
      'Projet B',
      1,
    )
    createCollaborator(db, { id: 'c1', name: 'Léa', color: '#3b82f6' })
    createCollaborator(db, { id: 'c2', name: 'Karim', color: '#10b981' })
  })

  // v2.0 / RG-GANTT-1201 — `listProjectMembers` renvoie un tableau vide pour
  // un projet sans membre.
  it('v2.0 / RG-GANTT-1201 — projet vide d`équipe : liste vide', () => {
    expect(listProjectMembers(db, 'pA')).toEqual([])
  })

  // v2.0 / RG-GANTT-1201 — `addProjectMember` crée la membership et bump la
  // version. Un 2e appel sur la même paire est idempotent (added=false).
  it('v2.0 / RG-GANTT-1201 — addProjectMember : idempotent + bump version', () => {
    const v0 = getVersion(db)
    const r1 = addProjectMember(db, 'pA', 'c1')
    expect(r1.added).toBe(true)
    expect(r1.version).toBeGreaterThan(v0)
    expect(listProjectMembers(db, 'pA')).toEqual(['c1'])
    // 2e appel sur la même paire : no-op, version inchangée.
    const r2 = addProjectMember(db, 'pA', 'c1')
    expect(r2.added).toBe(false)
    expect(r2.version).toBe(r1.version)
  })

  // v2.0 / RG-GANTT-1201 — projet inexistant → erreur typée.
  it('v2.0 / RG-GANTT-1201 — addProjectMember rejette un projet inconnu', () => {
    expect(() => addProjectMember(db, 'unknown', 'c1')).toThrow(/Project/)
  })

  // v2.0 / RG-GANTT-1201 — collab inexistant → erreur typée.
  it('v2.0 / RG-GANTT-1201 — addProjectMember rejette un collab inconnu', () => {
    expect(() => addProjectMember(db, 'pA', 'unknown')).toThrow(/Collaborator/)
  })

  // v2.0 / RG-GANTT-1200 — créer une tâche avec un collab non membre crée
  // automatiquement la membership (auto-heal côté DAL ; l'UI filtre en amont).
  it('v2.0 / RG-GANTT-1200 — createTask avec collab non-membre auto-ajoute la membership', () => {
    expect(listProjectMembers(db, 'pA')).toEqual([])
    createTask(db, {
      id: 't1',
      name: 'Tâche affectée',
      start_date: '2026-06-08',
      end_date: '2026-06-08',
      collaborator_id: 'c1',
      project_id: 'pA',
    })
    expect(listProjectMembers(db, 'pA')).toEqual(['c1'])
    // Et la même tâche sur le projet B → membership distincte.
    createTask(db, {
      id: 't2',
      name: 'Tâche projet B',
      start_date: '2026-06-08',
      end_date: '2026-06-08',
      collaborator_id: 'c1',
      project_id: 'pB',
    })
    expect(listProjectMembers(db, 'pB')).toEqual(['c1'])
    // Les memberships du projet A n'ont pas bougé.
    expect(listProjectMembers(db, 'pA')).toEqual(['c1'])
  })

  // v2.0 / RG-GANTT-1202 — la migration auto-pop : sur une base v1.x qui
  // contient déjà des affectations, les memberships sont créées au boot.
  it('v2.0 / RG-GANTT-1202 — migration : auto-pop des memberships depuis les tâches', async () => {
    const Database = (await import('better-sqlite3')).default
    const tmpFile = `/tmp/gantt-members-migration-${Date.now()}.db`
    const old = new Database(tmpFile)
    // Base v1.x complète (sans project_members) avec des tâches affectées.
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
        collaborator_id TEXT, color TEXT,
        parent_id TEXT, predecessor_id TEXT,
        predecessor_lag INTEGER NOT NULL DEFAULT 0,
        priority INTEGER, not_before_date TEXT,
        position INTEGER NOT NULL, project_id TEXT
      );
      INSERT INTO collaborators(id, name, color, position) VALUES ('c1', 'L', '#3b82f6', 0);
      INSERT INTO collaborators(id, name, color, position) VALUES ('c2', 'K', '#10b981', 1);
      INSERT INTO projects(id, name, position) VALUES ('pA', 'A', 0);
      INSERT INTO projects(id, name, position) VALUES ('pB', 'B', 1);
      INSERT INTO tasks(id, name, kind, start_date, end_date, progress,
                        collaborator_id, position, project_id, priority)
        VALUES ('t1', 'T1', 'task', '2026-06-08', '2026-06-08', 0, 'c1', 0, 'pA', 3);
      INSERT INTO tasks(id, name, kind, start_date, end_date, progress,
                        collaborator_id, position, project_id, priority)
        VALUES ('t2', 'T2', 'task', '2026-06-08', '2026-06-08', 0, 'c2', 1, 'pA', 3);
      INSERT INTO tasks(id, name, kind, start_date, end_date, progress,
                        collaborator_id, position, project_id, priority)
        VALUES ('t3', 'T3', 'task', '2026-06-08', '2026-06-08', 0, 'c1', 2, 'pB', 3);
      INSERT INTO meta(key, value) VALUES ('version', '20');
    `)
    old.close()

    const fresh = initDb(tmpFile)
    // Les memberships ont été auto-créées : (pA,c1), (pA,c2), (pB,c1).
    expect(listProjectMembers(fresh, 'pA').sort()).toEqual(['c1', 'c2'])
    expect(listProjectMembers(fresh, 'pB')).toEqual(['c1'])
    fresh.close()
  })

  // v2.0 / RG-GANTT-1203 — getFullState renvoie `current_project_members`
  // alignée avec le projet courant retourné par le serveur.
  it('v2.0 / RG-GANTT-1203 — getFullState expose current_project_members', () => {
    addProjectMember(db, 'pA', 'c1')
    addProjectMember(db, 'pB', 'c2')
    const stateA = getFullState(db, 'pA')
    expect(stateA.current_project_id).toBe('pA')
    expect(stateA.current_project_members).toEqual(['c1'])
    const stateB = getFullState(db, 'pB')
    expect(stateB.current_project_id).toBe('pB')
    expect(stateB.current_project_members).toEqual(['c2'])
  })

  // v2.0 / RG-GANTT-1204 — suppression d'un projet → ses memberships sont
  // retirées en cascade (FK ON DELETE CASCADE).
  it('v2.0 / RG-GANTT-1204 — suppression projet : cascade sur les memberships', () => {
    addProjectMember(db, 'pA', 'c1')
    addProjectMember(db, 'pA', 'c2')
    db.prepare(`DELETE FROM projects WHERE id = ?`).run('pA')
    expect(listProjectMembers(db, 'pA')).toEqual([])
  })

  // v2.0 / RG-GANTT-1205 — suppression d'un collab → ses memberships sont
  // retirées en cascade.
  it('v2.0 / RG-GANTT-1205 — suppression collab : cascade sur les memberships', () => {
    addProjectMember(db, 'pA', 'c1')
    addProjectMember(db, 'pB', 'c1')
    deleteCollaborator(db, 'c1')
    expect(listProjectMembers(db, 'pA')).toEqual([])
    expect(listProjectMembers(db, 'pB')).toEqual([])
  })
})

// =============================================================================
// v2.0 / F2 — Allocations (périodes %) + impact sur end_date
// =============================================================================

describe('v2.0 / F2 — member_allocations', () => {
  let db
  /** Helper : retire toutes les allocations du couple (pA, c1) pour partir
   *  d'une page blanche dans les tests qui ne testent pas l'auto-pop. */
  function clearAllocations() {
    for (const a of listMemberAllocations(db, 'pA', 'c1')) {
      deleteMemberAllocation(db, a.id)
    }
  }
  beforeEach(() => {
    db = initDb(':memory:')
    db.prepare(`INSERT INTO projects(id, name, position) VALUES (?, ?, ?)`).run(
      'pA',
      'Projet A',
      0,
    )
    createCollaborator(db, { id: 'c1', name: 'Léa', color: '#3b82f6' })
    addProjectMember(db, 'pA', 'c1')
    // `addProjectMember` insère désormais une allocation 100 % par défaut
    // (2020 → 2099). Les tests qui testent l'auto-pop la lisent telle quelle ;
    // les autres appellent `clearAllocations()` pour partir d'un état vide.
  })

  // RG-GANTT-1300 — Ajout d'une période propre.
  it('v2.0 / RG-GANTT-1300 — addMemberAllocation : ajoute une période propre', () => {
    clearAllocations()
    const r = addMemberAllocation(db, {
      project_id: 'pA',
      collaborator_id: 'c1',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      allocation_pct: 50,
    })
    expect(r.allocation.allocation_pct).toBe(50)
    const list = listMemberAllocations(db, 'pA', 'c1')
    expect(list).toHaveLength(1)
    expect(list[0].start_date).toBe('2026-06-01')
  })

  // RG-GANTT-1301 — Chevauchement strictement interdit.
  it('v2.0 / RG-GANTT-1301 — chevauchement rejeté', () => {
    clearAllocations()
    addMemberAllocation(db, {
      project_id: 'pA',
      collaborator_id: 'c1',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      allocation_pct: 50,
    })
    expect(() =>
      addMemberAllocation(db, {
        project_id: 'pA',
        collaborator_id: 'c1',
        start_date: '2026-06-15',
        end_date: '2026-07-15',
        allocation_pct: 75,
      }),
    ).toThrow(/overlap/)
  })

  // RG-GANTT-1301 — Deux périodes adjacentes (sans intersection) acceptées.
  it('v2.0 / RG-GANTT-1301 — périodes contiguës sans chevauchement OK', () => {
    clearAllocations()
    addMemberAllocation(db, {
      project_id: 'pA',
      collaborator_id: 'c1',
      start_date: '2026-06-01',
      end_date: '2026-06-15',
      allocation_pct: 50,
    })
    // Note : 06-15 et 06-16 = bornes adjacentes mais distinctes → OK
    const r = addMemberAllocation(db, {
      project_id: 'pA',
      collaborator_id: 'c1',
      start_date: '2026-06-16',
      end_date: '2026-06-30',
      allocation_pct: 100,
    })
    expect(r.allocation.allocation_pct).toBe(100)
  })

  // RG-GANTT-1302 — % ∈ {25, 50, 75, 100}.
  it('v2.0 / RG-GANTT-1302 — % invalide rejeté', () => {
    expect(() =>
      addMemberAllocation(db, {
        project_id: 'pA',
        collaborator_id: 'c1',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        allocation_pct: 60,
      }),
    ).toThrow(/25,50,75,100/)
  })

  // RG-GANTT-1300 — Non-membre rejeté.
  it('v2.0 / RG-GANTT-1300 — non membre rejeté', () => {
    createCollaborator(db, { id: 'c2', name: 'Karim', color: '#10b981' })
    expect(() =>
      addMemberAllocation(db, {
        project_id: 'pA',
        collaborator_id: 'c2',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        allocation_pct: 100,
      }),
    ).toThrow(/Not a member/)
  })

  // RG-GANTT-1303 — Suppression d'une période par id.
  it('v2.0 / RG-GANTT-1303 — deleteMemberAllocation : retire par id', () => {
    clearAllocations()
    const r = addMemberAllocation(db, {
      project_id: 'pA',
      collaborator_id: 'c1',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      allocation_pct: 100,
    })
    const id = r.allocation.id
    const del = deleteMemberAllocation(db, id)
    expect(del.changed).toBe(true)
    expect(listMemberAllocations(db, 'pA', 'c1')).toHaveLength(0)
  })

  // v2.1 / F2.9 — updateMemberAllocation : prolonge end_date sans erreur.
  it('v2.1 / F2.9 — updateMemberAllocation : prolonge end_date', () => {
    clearAllocations()
    const r = addMemberAllocation(db, {
      project_id: 'pA',
      collaborator_id: 'c1',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      allocation_pct: 100,
    })
    const id = r.allocation.id
    const upd = updateMemberAllocation(db, id, { end_date: '2026-07-15' })
    expect(upd.changed).toBe(true)
    expect(upd.allocation.end_date).toBe('2026-07-15')
    expect(upd.allocation.allocation_pct).toBe(100)
    // start_date inchangée.
    expect(upd.allocation.start_date).toBe('2026-06-01')
  })

  // v2.1 / F2.9 — id inconnu → changed=false (no-op cohérent avec delete).
  it('v2.1 / F2.9 — updateMemberAllocation : id inconnu → changed=false', () => {
    const upd = updateMemberAllocation(db, 'alloc_inexistant', {
      end_date: '2026-12-31',
    })
    expect(upd.changed).toBe(false)
  })

  // v2.1 / F2.9 — Rejette si l'extension chevauche une autre période existante.
  it('v2.1 / F2.9 — updateMemberAllocation : chevauchement → INVALID/OVERLAP', () => {
    clearAllocations()
    const r1 = addMemberAllocation(db, {
      project_id: 'pA',
      collaborator_id: 'c1',
      start_date: '2026-06-01',
      end_date: '2026-06-15',
      allocation_pct: 100,
    })
    addMemberAllocation(db, {
      project_id: 'pA',
      collaborator_id: 'c1',
      start_date: '2026-07-01',
      end_date: '2026-07-31',
      allocation_pct: 100,
    })
    // Tenter de pousser la 1ère allocation jusqu'au 15/07 → chevauche la 2e.
    expect(() =>
      updateMemberAllocation(db, r1.allocation.id, {
        end_date: '2026-07-15',
      }),
    ).toThrow(/overlaps/)
  })

  // v2.1 / F2.9 — Modification du pct vers une valeur interdite.
  it('v2.1 / F2.9 — updateMemberAllocation : pct invalide → rejette', () => {
    clearAllocations()
    const r = addMemberAllocation(db, {
      project_id: 'pA',
      collaborator_id: 'c1',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      allocation_pct: 100,
    })
    expect(() =>
      updateMemberAllocation(db, r.allocation.id, { allocation_pct: 33 }),
    ).toThrow(/allocation_pct must be one of/)
  })

  // RG-GANTT-1304 — Cascade suppression membership → ses allocations.
  it('v2.0 / RG-GANTT-1304 — suppression collab : cascade sur allocations', () => {
    clearAllocations()
    addMemberAllocation(db, {
      project_id: 'pA',
      collaborator_id: 'c1',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      allocation_pct: 100,
    })
    deleteCollaborator(db, 'c1')
    expect(listMemberAllocations(db, 'pA', 'c1')).toHaveLength(0)
  })

  // RG-GANTT-1305 — Auto-pop migration : memberships F1 → allocation 100 %.
  it('v2.0 / RG-GANTT-1305 — migration auto-pop : allocation 100 % par défaut', () => {
    // L'app de test charge 'c1' membre de 'pA' via le beforeEach.
    // ensureMemberAllocationsTable a déjà tourné lors du initDb.
    const list = listMemberAllocations(db, 'pA', 'c1')
    expect(list.length).toBeGreaterThan(0)
    expect(list[0].allocation_pct).toBe(100)
  })

  // RG-GANTT-1310 — Impact moteur : 5j charge @ 50% → end = start + 9 ouvrés.
  // Lundi 8 juin 2026 + 5 jours d'effort à 50 % :
  //   J1=08/06 (0.5), J2=09/06 (1.0), J3=10/06 (1.5), J4=11/06 (2.0),
  //   J5=12/06 (2.5), J6=15/06 (3.0), J7=16/06 (3.5), J8=17/06 (4.0),
  //   J9=18/06 (4.5), J10=19/06 (5.0) → fin = 19/06 (vendredi).
  it('v2.0 / RG-GANTT-1310 — charge 5j @ 50 % → 10 jours ouvrés', () => {
    // Vide d'abord l'allocation auto-pop (100 % par défaut), puis pose 50 %.
    for (const a of listMemberAllocations(db, 'pA', 'c1')) {
      deleteMemberAllocation(db, a.id)
    }
    addMemberAllocation(db, {
      project_id: 'pA',
      collaborator_id: 'c1',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      allocation_pct: 50,
    })
    const r = createTask(db, {
      id: 't_alloc',
      name: 'Tâche 50%',
      start_date: '2026-06-08',
      charge_jours: 5,
      collaborator_id: 'c1',
      project_id: 'pA',
    })
    expect(r.task.charge_jours).toBe(5)
    expect(r.task.end_date).toBe('2026-06-19') // 10e jour ouvré depuis lundi 08/06
  })

  // RG-GANTT-1311 — Sans collab affecté : pas d'effet allocation (F0).
  it('v2.0 / RG-GANTT-1311 — tâche sans collab : end = addWorkingDays (F0)', () => {
    const r = createTask(db, {
      id: 't_solo',
      name: 'Tâche sans collab',
      start_date: '2026-06-08',
      charge_jours: 5,
      project_id: 'pA',
    })
    expect(r.task.end_date).toBe('2026-06-12') // 5 ouvrés depuis lundi
  })

  // RG-GANTT-1312 — Auto-heal : créer une tâche avec un collab non-membre
  // crée la membership + une allocation 100 % par défaut.
  it('v2.0 / RG-GANTT-1312 — auto-heal : membership + allocation 100 %', () => {
    createCollaborator(db, { id: 'c2', name: 'Karim', color: '#10b981' })
    createTask(db, {
      id: 't_heal',
      name: 'Auto-heal',
      start_date: '2026-06-08',
      charge_jours: 3,
      collaborator_id: 'c2',
      project_id: 'pA',
    })
    expect(listProjectMembers(db, 'pA').sort()).toEqual(['c1', 'c2'])
    const allocs = listMemberAllocations(db, 'pA', 'c2')
    expect(allocs.length).toBeGreaterThan(0)
    expect(allocs[0].allocation_pct).toBe(100)
  })

  // RG-GANTT-1313 — getFullState expose member_allocations.
  it('v2.0 / RG-GANTT-1313 — getFullState : member_allocations exposé', () => {
    const state = getFullState(db, 'pA')
    expect(Array.isArray(state.member_allocations)).toBe(true)
    expect(state.member_allocations.length).toBeGreaterThan(0)
  })
})

// =============================================================================
// v2.0 / F3 — Absences (congés cross-projet)
// =============================================================================

describe('v2.0 / F3 — collaborator_absences', () => {
  let db
  beforeEach(() => {
    db = initDb(':memory:')
    db.prepare(`INSERT INTO projects(id, name, position) VALUES (?, ?, ?)`).run(
      'pA',
      'Projet A',
      0,
    )
    createCollaborator(db, { id: 'c1', name: 'Léa', color: '#3b82f6' })
    addProjectMember(db, 'pA', 'c1')
  })

  // RG-GANTT-1400 — Ajout d'une absence simple.
  it('v2.0 / RG-GANTT-1400 — addAbsence : ajoute une absence', () => {
    const r = addAbsence(db, {
      collaborator_id: 'c1',
      date: '2026-07-15',
      fraction: 0.5,
    })
    expect(r.absence.fraction).toBe(0.5)
    const list = listAbsences(db, 'c1')
    expect(list).toHaveLength(1)
    expect(list[0].date).toBe('2026-07-15')
  })

  // RG-GANTT-1403 — UPSERT : la 2e saisie sur la même (collab,date) remplace.
  it('v2.0 / RG-GANTT-1403 — UPSERT : 2e saisie sur même date remplace la fraction', () => {
    addAbsence(db, {
      collaborator_id: 'c1',
      date: '2026-07-15',
      fraction: 0.5,
    })
    addAbsence(db, {
      collaborator_id: 'c1',
      date: '2026-07-15',
      fraction: 1,
    })
    const list = listAbsences(db, 'c1')
    expect(list).toHaveLength(1)
    expect(list[0].fraction).toBe(1)
  })

  // Fraction invalide rejetée.
  it('v2.0 / RG-GANTT-1400 — fraction invalide rejetée', () => {
    expect(() =>
      addAbsence(db, {
        collaborator_id: 'c1',
        date: '2026-07-15',
        fraction: 0.6,
      }),
    ).toThrow(/0.25, 0.5, 0.75, 1/)
  })

  // Collab inconnu rejeté.
  it('v2.0 / RG-GANTT-1400 — collab inconnu rejeté', () => {
    expect(() =>
      addAbsence(db, {
        collaborator_id: 'unknown',
        date: '2026-07-15',
        fraction: 1,
      }),
    ).toThrow(/Collaborator not found/)
  })

  // Suppression par (collab, date).
  it('v2.0 / RG-GANTT-1404 — deleteAbsence : retire la ligne', () => {
    addAbsence(db, {
      collaborator_id: 'c1',
      date: '2026-07-15',
      fraction: 1,
    })
    const r = deleteAbsence(db, 'c1', '2026-07-15')
    expect(r.changed).toBe(true)
    expect(listAbsences(db, 'c1')).toHaveLength(0)
  })

  // Cascade suppression collab → ses absences.
  it('v2.0 / RG-GANTT-1405 — cascade suppression collab → absences effacées', () => {
    addAbsence(db, {
      collaborator_id: 'c1',
      date: '2026-07-15',
      fraction: 1,
    })
    deleteCollaborator(db, 'c1')
    expect(listAbsences(db, 'c1')).toHaveLength(0)
  })

  // getFullState expose les absences (cross-projet, toutes connues).
  it('v2.0 / RG-GANTT-1406 — getFullState expose collaborator_absences', () => {
    addAbsence(db, {
      collaborator_id: 'c1',
      date: '2026-07-15',
      fraction: 0.5,
    })
    const state = getFullState(db, 'pA')
    expect(Array.isArray(state.collaborator_absences)).toBe(true)
    expect(state.collaborator_absences).toHaveLength(1)
    expect(state.collaborator_absences[0].date).toBe('2026-07-15')
  })

  // RG-GANTT-1402 — Lecture multiplicative dans le moteur : alloc 100 % +
  // congé 1 j → 0 % de capacité ce jour-là → la tâche est repoussée.
  // Lundi 8 juin charge=3, mais le mardi 9 est en congé complet :
  //   J1 08/06 (lun) → 1.0 (cumul 1.0)
  //   J2 09/06 (mar) → 0 (congé 1j) — sauté
  //   J3 10/06 (mer) → 1.0 (cumul 2.0)
  //   J4 11/06 (jeu) → 1.0 (cumul 3.0) → fin = 11/06
  it('v2.0 / RG-GANTT-1402 — absence 1 j décale la fin (alloc 100 %)', () => {
    // Allocation par défaut 100 % posée par addProjectMember.
    addAbsence(db, {
      collaborator_id: 'c1',
      date: '2026-06-09',
      fraction: 1,
    })
    const r = createTask(db, {
      id: 't_abs',
      name: 'Tâche avec congé',
      start_date: '2026-06-08',
      charge_jours: 3,
      collaborator_id: 'c1',
      project_id: 'pA',
    })
    expect(r.task.end_date).toBe('2026-06-11')
  })

  // RG-GANTT-1402 — Lecture multiplicative avec alloc 50 % + congé 0,5 j :
  // capacité du jour = 0,5 × (1 − 0,5) = 0,25.
  // Charge 1 j, lundi 8 juin congé 0,5 j, allocation 50 % :
  //   J1 08/06 → 0,5 × 0,5 = 0,25 (cumul 0,25)
  //   J2 09/06 → 0,5            (cumul 0,75)
  //   J3 10/06 → 0,5            (cumul 1,25) → atteint ≥ 1 sur J3
  // → fin = 10/06
  it('v2.0 / RG-GANTT-1402 — alloc 50 % + congé 0,5 j : capacité 25 % le jour concerné', () => {
    // Vider l'allocation auto-pop (100 %) et poser 50 %.
    for (const a of db
      .prepare(`SELECT id FROM member_allocations WHERE collaborator_id = ?`)
      .all('c1')) {
      deleteMemberAllocation(db, a.id)
    }
    addMemberAllocation(db, {
      project_id: 'pA',
      collaborator_id: 'c1',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      allocation_pct: 50,
    })
    addAbsence(db, {
      collaborator_id: 'c1',
      date: '2026-06-08',
      fraction: 0.5,
    })
    const r = createTask(db, {
      id: 't_mul',
      name: 'Multiplicatif',
      start_date: '2026-06-08',
      charge_jours: 1,
      collaborator_id: 'c1',
      project_id: 'pA',
    })
    expect(r.task.end_date).toBe('2026-06-10')
  })

  // RG-GANTT-1401 — Cross-projet : la même absence impacte tous les projets.
  // On crée un 2e projet avec le même collab, et on vérifie que l'absence
  // du 09/06 décale aussi la tâche du projet B (pas seulement A).
  it('v2.0 / RG-GANTT-1401 — absence cross-projet : impacte tous les projets', () => {
    db.prepare(`INSERT INTO projects(id, name, position) VALUES (?, ?, ?)`).run(
      'pB',
      'Projet B',
      1,
    )
    addProjectMember(db, 'pB', 'c1')
    addAbsence(db, {
      collaborator_id: 'c1',
      date: '2026-06-09',
      fraction: 1,
    })
    const r = createTask(db, {
      id: 't_B',
      name: 'Tâche projet B',
      start_date: '2026-06-08',
      charge_jours: 2,
      collaborator_id: 'c1',
      project_id: 'pB',
    })
    // J1 08/06 → 1.0 ; J2 09/06 congé → 0 ; J3 10/06 → 1.0 → fin 10/06
    expect(r.task.end_date).toBe('2026-06-10')
  })
})

// =============================================================================
// v2.0 / F4 — FNLT « Fin au plus tard » (deadline non-bloquante)
// =============================================================================

describe('v2.0 / F4 — not_later_than_date', () => {
  let db
  beforeEach(() => {
    db = initDb(':memory:')
    db.prepare(`INSERT INTO projects(id, name, position) VALUES (?, ?, ?)`).run(
      'pA',
      'Projet A',
      0,
    )
  })

  // RG-GANTT-1500 — FNLT facultatif, null par défaut.
  it('v2.0 / RG-GANTT-1500 — FNLT facultatif : null par défaut', () => {
    const r = createTask(db, {
      id: 't_no_fnlt',
      name: 'Sans FNLT',
      start_date: '2026-06-08',
      charge_jours: 3,
      project_id: 'pA',
    })
    expect(r.task.not_later_than_date).toBeNull()
  })

  // RG-GANTT-1500 — FNLT saisi est persisté tel quel (aucun snap).
  it('v2.0 / RG-GANTT-1500 — FNLT saisi : persistance brute', () => {
    const r = createTask(db, {
      id: 't_fnlt',
      name: 'Avec FNLT',
      start_date: '2026-06-08',
      charge_jours: 3,
      not_later_than_date: '2026-06-30',
      project_id: 'pA',
    })
    expect(r.task.not_later_than_date).toBe('2026-06-30')
  })

  // RG-GANTT-1501 — Modification via PATCH possible.
  it('v2.0 / RG-GANTT-1501 — PATCH met à jour la FNLT', () => {
    createTask(db, {
      id: 't_patch',
      name: 'PATCH FNLT',
      start_date: '2026-06-08',
      charge_jours: 3,
      project_id: 'pA',
    })
    updateTask(db, 't_patch', { not_later_than_date: '2026-07-10' })
    const t = getFullState(db, 'pA').tasks.find((x) => x.id === 't_patch')
    expect(t.not_later_than_date).toBe('2026-07-10')
    // Et on peut le retirer en envoyant null.
    updateTask(db, 't_patch', { not_later_than_date: null })
    const t2 = getFullState(db, 'pA').tasks.find((x) => x.id === 't_patch')
    expect(t2.not_later_than_date).toBeNull()
  })

  // RG-GANTT-1502 — FNLT NON BLOQUANT : la sauvegarde est acceptée même si
  // la fin calculée dépasse la deadline. C'est la coherence côté front qui
  // signalera l'incohérence.
  it('v2.0 / RG-GANTT-1502 — FNLT non bloquante : sauvegarde acceptée même si dépassée', () => {
    // Charge 20 j depuis 08/06 → fin bien après le 12/06.
    const r = createTask(db, {
      id: 't_overrun',
      name: 'Dépasse la deadline',
      start_date: '2026-06-08',
      charge_jours: 20,
      not_later_than_date: '2026-06-12',
      project_id: 'pA',
    })
    expect(r.task.not_later_than_date).toBe('2026-06-12')
    // La fin calculée dépasse bien le FNLT.
    expect(r.task.end_date > '2026-06-12').toBe(true)
  })

  // RG-GANTT-1503 — Phase : FNLT toujours NULL, même si saisi.
  it('v2.0 / RG-GANTT-1503 — phase : FNLT forcée à NULL même si fournie', () => {
    const r = createTask(db, {
      id: 'p_fnlt',
      name: 'Phase',
      kind: 'phase',
      start_date: '2026-06-08',
      end_date: '2026-06-30',
      not_later_than_date: '2026-06-30',
      project_id: 'pA',
    })
    expect(r.task.not_later_than_date).toBeNull()
  })

  // RG-GANTT-1503 — Jalon : FNLT autorisé (sœur du SNET).
  it('v2.0 / RG-GANTT-1503 — jalon : FNLT autorisé', () => {
    const r = createTask(db, {
      id: 'm_fnlt',
      name: 'Jalon avec deadline',
      kind: 'milestone',
      start_date: '2026-06-30',
      not_later_than_date: '2026-07-15',
      project_id: 'pA',
    })
    expect(r.task.not_later_than_date).toBe('2026-07-15')
  })

  // RG-GANTT-1504 — Format invalide ignoré (cohérent avec SNET).
  it('v2.0 / RG-GANTT-1504 — format invalide ignoré, ramené à NULL', () => {
    const r = createTask(db, {
      id: 't_bad',
      name: 'Bad format',
      start_date: '2026-06-08',
      charge_jours: 1,
      not_later_than_date: 'not-a-date',
      project_id: 'pA',
    })
    expect(r.task.not_later_than_date).toBeNull()
  })

  // RG-GANTT-1505 — getFullState expose not_later_than_date.
  it('v2.0 / RG-GANTT-1505 — getFullState expose not_later_than_date', () => {
    createTask(db, {
      id: 't_expose',
      name: 'Test',
      start_date: '2026-06-08',
      charge_jours: 1,
      not_later_than_date: '2026-06-30',
      project_id: 'pA',
    })
    const state = getFullState(db, 'pA')
    const t = state.tasks.find((x) => x.id === 't_expose')
    expect(t.not_later_than_date).toBe('2026-06-30')
  })
})

// =============================================================================
// v2.0 / F6 — Multi-collaborateurs par activité
// =============================================================================

describe('v2.0 / F6 — task_assignments (multi-collab)', () => {
  let db
  beforeEach(() => {
    db = initDb(':memory:')
    db.prepare(`INSERT INTO projects(id, name, position) VALUES (?, ?, ?)`).run(
      'pA',
      'Projet A',
      0,
    )
    createCollaborator(db, { id: 'c1', name: 'Léa', color: '#3b82f6' })
    createCollaborator(db, { id: 'c2', name: 'Karim', color: '#10b981' })
    addProjectMember(db, 'pA', 'c1')
    addProjectMember(db, 'pA', 'c2')
  })

  // RG-GANTT-1700 — Création multi-collab via collaborator_ids[].
  it('v2.0 / RG-GANTT-1700 — createTask avec collaborator_ids[] : N collabs persistés', () => {
    const r = createTask(db, {
      id: 't_multi',
      name: 'Multi-collab',
      start_date: '2026-06-08',
      charge_jours: 5,
      collaborator_ids: ['c1', 'c2'],
      project_id: 'pA',
    })
    // La liste est exposée et triée par id ASC.
    expect(r.task.collaborators).toEqual([{ id: 'c1' }, { id: 'c2' }])
    // Le champ legacy `collaborator_id` est aligné sur le 1er (ordre alpha).
    expect(r.task.collaborator_id).toBe('c1')
    expect(listTaskAssignments(db, 't_multi').sort()).toEqual(['c1', 'c2'])
  })

  // RG-GANTT-1701 — Rétro-compat : collaborator_id (legacy) crée 1 affectation.
  it('v2.0 / RG-GANTT-1701 — createTask avec collaborator_id legacy : 1 affectation', () => {
    const r = createTask(db, {
      id: 't_legacy',
      name: 'Mono legacy',
      start_date: '2026-06-08',
      charge_jours: 1,
      collaborator_id: 'c1',
      project_id: 'pA',
    })
    expect(r.task.collaborators).toEqual([{ id: 'c1' }])
    expect(listTaskAssignments(db, 't_legacy')).toEqual(['c1'])
  })

  // RG-GANTT-1702 — Multi-collab additif uniforme : 2 collabs 100 % → fin 2× plus vite.
  // Charge 4 j, 2 collabs 100 % chacun (capacité jour = 2).
  // J1 lun 08/06 → 2 (cumul 2) ; J2 mar 09/06 → 2 (cumul 4) → fin = 09/06.
  it('v2.0 / RG-GANTT-1702 — additif : 2 collabs 100 % font une charge 4 j en 2 j', () => {
    const r = createTask(db, {
      id: 't_2x',
      name: 'Multi 100%',
      start_date: '2026-06-08',
      charge_jours: 4,
      collaborator_ids: ['c1', 'c2'],
      project_id: 'pA',
    })
    expect(r.task.end_date).toBe('2026-06-09')
  })

  // RG-GANTT-1702 — Multi-collab avec allocations différentes : Paul 100 %
  // + Marie 50 % → capacité 1,5/jour. Charge 3 j → 2 jours (1,5 + 1,5 = 3).
  it('v2.0 / RG-GANTT-1702 — additif : 100 % + 50 % → capacité 1,5/jour', () => {
    // Vide les allocations auto-pop et pose 100 % et 50 %.
    for (const a of listMemberAllocations(db, 'pA', 'c1')) {
      deleteMemberAllocation(db, a.id)
    }
    for (const a of listMemberAllocations(db, 'pA', 'c2')) {
      deleteMemberAllocation(db, a.id)
    }
    addMemberAllocation(db, {
      project_id: 'pA',
      collaborator_id: 'c1',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      allocation_pct: 100,
    })
    addMemberAllocation(db, {
      project_id: 'pA',
      collaborator_id: 'c2',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      allocation_pct: 50,
    })
    const r = createTask(db, {
      id: 't_mix',
      name: 'Mix 100/50',
      start_date: '2026-06-08',
      charge_jours: 3,
      collaborator_ids: ['c1', 'c2'],
      project_id: 'pA',
    })
    expect(r.task.end_date).toBe('2026-06-09')
  })

  // RG-GANTT-1703 — Update : on peut remplacer la liste de collabs.
  it('v2.0 / RG-GANTT-1703 — updateTask : remplace atomiquement la liste', () => {
    createTask(db, {
      id: 't_swap',
      name: 'Swap',
      start_date: '2026-06-08',
      charge_jours: 1,
      collaborator_ids: ['c1'],
      project_id: 'pA',
    })
    updateTask(db, 't_swap', { collaborator_ids: ['c1', 'c2'] })
    expect(listTaskAssignments(db, 't_swap').sort()).toEqual(['c1', 'c2'])
    updateTask(db, 't_swap', { collaborator_ids: [] })
    expect(listTaskAssignments(db, 't_swap')).toEqual([])
  })

  // RG-GANTT-1704 — Cascade : suppression d'une tâche retire les affectations.
  it('v2.0 / RG-GANTT-1704 — cascade suppression tâche : assignments effacés', () => {
    createTask(db, {
      id: 't_del',
      name: 'À supprimer',
      start_date: '2026-06-08',
      charge_jours: 1,
      collaborator_ids: ['c1', 'c2'],
      project_id: 'pA',
    })
    deleteTask(db, 't_del')
    expect(listTaskAssignments(db, 't_del')).toEqual([])
  })

  // RG-GANTT-1705 — Cascade : suppression d'un collab le retire de toutes ses tâches.
  it('v2.0 / RG-GANTT-1705 — cascade suppression collab : retiré des tâches', () => {
    createTask(db, {
      id: 't_ca',
      name: 'Avec c1+c2',
      start_date: '2026-06-08',
      charge_jours: 1,
      collaborator_ids: ['c1', 'c2'],
      project_id: 'pA',
    })
    deleteCollaborator(db, 'c2')
    expect(listTaskAssignments(db, 't_ca')).toEqual(['c1'])
  })

  // RG-GANTT-1706 — Migration auto-pop : tasks.collaborator_id pré-F6 →
  // ligne dans task_assignments au premier boot.
  it('v2.0 / RG-GANTT-1706 — migration auto-pop depuis tasks.collaborator_id', async () => {
    const Database = (await import('better-sqlite3')).default
    const tmpFile = `/tmp/gantt-f6-migration-${Date.now()}.db`
    const old = new Database(tmpFile)
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
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'task',
        start_date TEXT NOT NULL, end_date TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        collaborator_id TEXT, color TEXT, parent_id TEXT, predecessor_id TEXT,
        predecessor_lag INTEGER NOT NULL DEFAULT 0,
        priority INTEGER, not_before_date TEXT,
        position INTEGER NOT NULL, project_id TEXT
      );
      INSERT INTO collaborators(id, name, color, position) VALUES ('c1','L','#3b82f6',0);
      INSERT INTO projects(id, name, position) VALUES ('pA','A',0);
      INSERT INTO tasks(id, name, kind, start_date, end_date, progress,
                        collaborator_id, position, project_id, priority)
        VALUES ('tOld', 'Old', 'task', '2026-06-08', '2026-06-08', 0, 'c1', 0, 'pA', 3);
      INSERT INTO meta(key, value) VALUES ('version', '20');
    `)
    old.close()
    const fresh = initDb(tmpFile)
    expect(listTaskAssignments(fresh, 'tOld')).toEqual(['c1'])
    fresh.close()
  })
})
