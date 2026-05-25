// =============================================================================
// TESTS d'intégration HTTP — API Gantt (supertest, base :memory:)
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from './app.js'
import { initDb, replaceFullState, DEMO_STATE } from '../db/index.js'

/** Construit une app fraîche avec base mémoire pré-remplie. */
function makeApp() {
  const db = initDb(':memory:')
  replaceFullState(db, DEMO_STATE)
  return createApp(db, { requestLog: false })
}

describe('GET /api/state', () => {
  it("renvoie l'état complet", async () => {
    const app = makeApp()
    const res = await request(app).get('/api/state').expect(200)
    expect(res.body.collaborators.length).toBe(DEMO_STATE.collaborators.length)
    expect(res.body.tasks.length).toBe(DEMO_STATE.tasks.length)
    expect(typeof res.body.version).toBe('number')
  })
})

describe('POST /api/reset', () => {
  it('restaure les données démo', async () => {
    const app = makeApp()
    const res = await request(app).post('/api/reset').expect(200)
    expect(res.body.tasks.length).toBe(DEMO_STATE.tasks.length)
  })
})

describe('Collaborateurs', () => {
  let app
  beforeEach(() => {
    app = makeApp()
  })

  it('POST crée', async () => {
    const r = await request(app)
      .post('/api/collaborators')
      .send({ id: 'cZ', name: 'Zoé', color: '#ff0000' })
      .expect(200)
    expect(r.body.collaborator.name).toBe('Zoé')
  })

  it('POST sans id → 400', async () => {
    const r = await request(app)
      .post('/api/collaborators')
      .send({ name: 'X' })
      .expect(400)
    expect(r.body.error).toBe('Validation échouée')
  })

  it('POST couleur invalide → 400', async () => {
    await request(app)
      .post('/api/collaborators')
      .send({ id: 'cX', name: 'X', color: 'rouge' })
      .expect(400)
  })

  it('PATCH nom', async () => {
    const r = await request(app)
      .patch('/api/collaborators/c1')
      .send({ name: 'Alicia' })
      .expect(200)
    expect(r.body.changed).toBe(true)
  })

  it('PATCH inconnu → 404', async () => {
    await request(app)
      .patch('/api/collaborators/inconnu')
      .send({ name: 'X' })
      .expect(404)
  })

  it('DELETE', async () => {
    await request(app).delete('/api/collaborators/c1').expect(200)
  })
})

describe('Tâches', () => {
  let app
  beforeEach(() => {
    app = makeApp()
  })

  it('POST tâche', async () => {
    const r = await request(app)
      .post('/api/tasks')
      .send({
        id: 'tZ',
        name: 'Nouvelle',
        kind: 'task',
        start_date: '2026-09-01',
        end_date: '2026-09-15',
        progress: 25,
        collaborator_id: 'c1',
      })
      .expect(200)
    expect(r.body.task.name).toBe('Nouvelle')
    expect(r.body.task.progress).toBe(25)
  })

  it('POST jalon (end_date forcée)', async () => {
    const r = await request(app)
      .post('/api/tasks')
      .send({
        id: 'mZ',
        name: 'Livraison',
        kind: 'milestone',
        start_date: '2026-12-01',
      })
      .expect(200)
    expect(r.body.task.end_date).toBe('2026-12-01')
  })

  it('POST end_date < start_date → 400', async () => {
    await request(app)
      .post('/api/tasks')
      .send({
        id: 'tBad',
        name: 'X',
        start_date: '2026-09-10',
        end_date: '2026-09-01',
      })
      .expect(400)
  })

  it('POST progress hors borne → 400', async () => {
    await request(app)
      .post('/api/tasks')
      .send({
        id: 'tBad',
        name: 'X',
        start_date: '2026-09-01',
        end_date: '2026-09-02',
        progress: 150,
      })
      .expect(400)
  })

  it('PATCH progress', async () => {
    const r = await request(app)
      .patch('/api/tasks/t1a')
      .send({ progress: 75 })
      .expect(200)
    expect(r.body.changed).toBe(true)
  })

  it('PATCH sans champ → 400', async () => {
    await request(app).patch('/api/tasks/t1a').send({}).expect(400)
  })

  it('DELETE', async () => {
    await request(app).delete('/api/tasks/t1a').expect(200)
  })

  it('DELETE inconnu → 404', async () => {
    await request(app).delete('/api/tasks/inconnu').expect(404)
  })

  // ---- v1.2 — Prédécesseur ------------------------------------------------

  it('POST avec predecessor_id : start_date forcée à la fin du prédécesseur', async () => {
    // t1a finit le 2026-05-29 dans les données démo.
    const r = await request(app)
      .post('/api/tasks')
      .send({
        id: 'tSucc',
        name: 'Successeur',
        start_date: '2026-01-01', // sera ignoré
        end_date: '2026-01-02',
        predecessor_id: 't1a',
      })
      .expect(200)
    expect(r.body.task.predecessor_id).toBe('t1a')
    expect(r.body.task.start_date).toBe('2026-05-29')
  })

  // ---- v1.21 — Multi-prédécesseurs (nouveau format API) ------------------

  it('POST avec predecessors[] = 2 entrées : start = MAX(pred.end) et liste exposée', async () => {
    // Démo : t1a finit 2026-05-29, t1c finit 2026-06-15. MAX = 2026-06-15.
    const r = await request(app)
      .post('/api/tasks')
      .send({
        id: 'tMulti',
        name: 'Tâche multi-préd',
        start_date: '2026-01-01',
        end_date: '2026-01-02',
        predecessors: [
          { id: 't1a', lag: 0 },
          { id: 't1c', lag: 0 },
        ],
      })
      .expect(200)
    expect(r.body.task.start_date).toBe('2026-06-15')
    // L'API expose la liste complète, triée par id ASC.
    expect(r.body.task.predecessors).toEqual([
      { id: 't1a', lag: 0 },
      { id: 't1c', lag: 0 },
    ])
    // Alias rétro-compat (= 1er pred par id ASC).
    expect(r.body.task.predecessor_id).toBe('t1a')
  })

  it('PATCH predecessors[] : remplace atomiquement la liste', async () => {
    // Crée une tâche avec t1a comme prédécesseur, puis bascule vers t1c.
    await request(app)
      .post('/api/tasks')
      .send({
        id: 'tSwap',
        name: 'Tâche à modifier',
        start_date: '2026-01-01',
        end_date: '2026-01-02',
        predecessors: [{ id: 't1a', lag: 0 }],
      })
      .expect(200)
    await request(app)
      .patch('/api/tasks/tSwap')
      .send({ predecessors: [{ id: 't1c', lag: 0 }] })
      .expect(200)
    const state = await request(app).get('/api/state').expect(200)
    const t = state.body.tasks.find((x) => x.id === 'tSwap')
    expect(t.predecessors).toEqual([{ id: 't1c', lag: 0 }])
    expect(t.start_date).toBe('2026-06-15') // recalé sur t1c.end
  })

  // ---- v1.5 — Déplacement (drag & drop) ----------------------------------

  it('POST /move : insère avant un sibling', async () => {
    // Démo : t1a, t1b, t1c, t1d, m1 sont enfants de t1.
    // On déplace t1d juste avant t1b.
    const r = await request(app)
      .post('/api/tasks/t1d/move')
      .send({ parent_id: 't1', before_id: 't1b' })
      .expect(200)
    expect(r.body.changed).toBe(true)
    const state = await request(app).get('/api/state').expect(200)
    const order = state.body.tasks
      .filter((t) => t.parent_id === 't1')
      .sort((a, b) => a.position - b.position)
      .map((t) => t.id)
    expect(order.slice(0, 2)).toEqual(['t1a', 't1d'])
  })

  it('POST /move : change de parent en fin de liste', async () => {
    // Déplace t2a (enfant de t2) en dernier enfant de t1.
    await request(app)
      .post('/api/tasks/t2a/move')
      .send({ parent_id: 't1', before_id: null })
      .expect(200)
    const state = await request(app).get('/api/state').expect(200)
    const t2a = state.body.tasks.find((t) => t.id === 't2a')
    expect(t2a.parent_id).toBe('t1')
  })

  it('POST /move : refuse cycle (déposer dans un descendant)', async () => {
    const r = await request(app)
      .post('/api/tasks/t1/move')
      .send({ parent_id: 't1a', before_id: null })
      .expect(400)
    expect(r.body.error).toMatch(/descendants/)
  })

  it('POST /move : 404 si tâche inconnue', async () => {
    await request(app)
      .post('/api/tasks/inconnu/move')
      .send({ parent_id: null, before_id: null })
      .expect(404)
  })

  // ---- v1.6 — Phases ------------------------------------------------------

  it("POST kind=phase puis ajout d'une activité enfant : phase recalculée", async () => {
    // Crée une phase vide
    await request(app)
      .post('/api/tasks')
      .send({
        id: 'pNew',
        name: 'Nouvelle phase',
        kind: 'phase',
        start_date: '2026-09-01',
        end_date: '2026-09-01',
      })
      .expect(200)
    // Ajoute une activité enfant
    await request(app)
      .post('/api/tasks')
      .send({
        id: 'aNew',
        name: 'Activité',
        start_date: '2026-09-15',
        end_date: '2026-09-25',
        parent_id: 'pNew',
      })
      .expect(200)
    // La phase doit avoir adopté les dates de son enfant
    const state = await request(app).get('/api/state').expect(200)
    const phase = state.body.tasks.find((t) => t.id === 'pNew')
    expect(phase.kind).toBe('phase')
    expect(phase.start_date).toBe('2026-09-15')
    expect(phase.end_date).toBe('2026-09-25')
  })

  it('PATCH definir un predecesseur preserve start_date si elle est posterieure', async () => {
    // t2a commence 2026-07-01 ; t1a finit 2026-05-29. Comme le start_date
    // actuel est DÉJÀ après la fin du prédécesseur, on doit le conserver
    // (l'utilisateur a le droit de décaler volontairement le début).
    const r = await request(app)
      .patch('/api/tasks/t2a')
      .send({ predecessor_id: 't1a' })
      .expect(200)
    expect(r.body.changed).toBe(true)
    const state = await request(app).get('/api/state').expect(200)
    const t2a = state.body.tasks.find((t) => t.id === 't2a')
    expect(t2a.start_date).toBe('2026-07-01')
    expect(t2a.predecessor_id).toBe('t1a')
  })

  it('PATCH predecesseur pousse start_date si elle est anterieure a la fin du predecesseur', async () => {
    // On force d'abord t2a à démarrer AVANT la fin de t1a (2026-05-29),
    // puis on ajoute t1a comme prédécesseur : le serveur doit repousser
    // start_date jusqu'à 2026-05-29 (la borne MIN imposée).
    await request(app)
      .patch('/api/tasks/t2a')
      .send({ start_date: '2026-05-01', end_date: '2026-05-10' })
      .expect(200)
    await request(app)
      .patch('/api/tasks/t2a')
      .send({ predecessor_id: 't1a' })
      .expect(200)
    const state = await request(app).get('/api/state').expect(200)
    const t2a = state.body.tasks.find((t) => t.id === 't2a')
    expect(t2a.start_date).toBe('2026-05-29')
    expect(t2a.predecessor_id).toBe('t1a')
  })
})

// =============================================================================
// PROJETS (v1.8)
// =============================================================================

describe('Projets', () => {
  let app
  beforeEach(() => {
    app = makeApp()
  })

  it('GET /api/state renvoie le projet courant + la liste des projets', async () => {
    const res = await request(app).get('/api/state').expect(200)
    expect(Array.isArray(res.body.projects)).toBe(true)
    expect(res.body.projects.length).toBeGreaterThanOrEqual(1)
    expect(res.body.current_project_id).toBe(res.body.projects[0].id)
    // Toutes les tâches du résultat appartiennent au projet courant.
    for (const t of res.body.tasks) {
      expect(t.project_id).toBe(res.body.current_project_id)
    }
  })

  it('POST /api/projects crée un projet, GET /api/state?project_id=… le charge vide', async () => {
    const created = await request(app)
      .post('/api/projects')
      .send({ id: 'p_test', name: 'Mon test' })
      .expect(200)
    expect(created.body.project.name).toBe('Mon test')

    const state = await request(app)
      .get('/api/state?project_id=p_test')
      .expect(200)
    expect(state.body.current_project_id).toBe('p_test')
    expect(state.body.tasks.length).toBe(0)
    expect(state.body.projects.length).toBe(2)
  })

  it('v2.3 / RG-GANTT-2100 — POST /api/projects accepte project_start_date', async () => {
    const created = await request(app)
      .post('/api/projects')
      .send({ id: 'p_v23', name: 'V23', project_start_date: '2026-09-01' })
      .expect(200)
    expect(created.body.project.project_start_date).toBe('2026-09-01')
    const state = await request(app)
      .get('/api/state?project_id=p_v23')
      .expect(200)
    expect(
      state.body.projects.find((p) => p.id === 'p_v23').project_start_date,
    ).toBe('2026-09-01')
  })

  it('v2.3 / RG-GANTT-2100 — POST /api/projects sans project_start_date → défaut today', async () => {
    const created = await request(app)
      .post('/api/projects')
      .send({ id: 'p_v23_def', name: 'Def' })
      .expect(200)
    const today = new Date().toISOString().slice(0, 10)
    expect(created.body.project.project_start_date).toBe(today)
  })

  it('v2.3 / RG-GANTT-2101 — PATCH /api/projects/:id modifie aussi project_start_date', async () => {
    const list = await request(app).get('/api/projects').expect(200)
    const first = list.body.projects[0]
    // On choisit une date antérieure à toutes les tâches en cours du projet
    // pour éviter de buter sur la validation RG-2010 (les tâches démo ont
    // start_date >= 2026-05-15).
    await request(app)
      .patch(`/api/projects/${first.id}`)
      .send({ project_start_date: '2026-01-01' })
      .expect(200)
    const after = await request(app).get('/api/state').expect(200)
    expect(
      after.body.projects.find((p) => p.id === first.id).project_start_date,
    ).toBe('2026-01-01')
  })

  it("v2.3 / RG-GANTT-2110 — PATCH refusé si date > start d'une tâche progress>0", async () => {
    // Dans la démo, t1a a progress=100, start_date=2026-05-15.
    const list = await request(app).get('/api/projects').expect(200)
    const first = list.body.projects[0]
    const res = await request(app)
      .patch(`/api/projects/${first.id}`)
      .send({ project_start_date: '2026-09-01' })
      .expect(400)
    expect(res.body.code).toBe('PROJECT_START_AFTER_TASK')
    expect(res.body.error).toMatch(/déjà démarrée/i)
    expect(res.body.conflictingTask).toBeDefined()
  })

  it('PATCH /api/projects/:id renomme', async () => {
    const list = await request(app).get('/api/projects').expect(200)
    const first = list.body.projects[0]
    await request(app)
      .patch(`/api/projects/${first.id}`)
      .send({ name: 'Renommé' })
      .expect(200)
    const after = await request(app).get('/api/projects').expect(200)
    expect(after.body.projects.find((p) => p.id === first.id).name).toBe(
      'Renommé',
    )
  })

  it('DELETE /api/projects/:id supprime le projet et ses tâches (cascade)', async () => {
    // Crée un 2e projet pour pouvoir supprimer le 1er.
    await request(app)
      .post('/api/projects')
      .send({ id: 'p_other', name: 'Autre' })
      .expect(200)
    // Récupère l'id du projet par défaut.
    const list = await request(app).get('/api/projects').expect(200)
    const def = list.body.projects.find((p) => p.id !== 'p_other')
    await request(app).delete(`/api/projects/${def.id}`).expect(200)
    // Plus aucune tâche : le seul projet restant est p_other (vide).
    const state = await request(app)
      .get('/api/state?project_id=p_other')
      .expect(200)
    expect(state.body.tasks.length).toBe(0)
    expect(state.body.projects.length).toBe(1)
  })

  // v1.24 — RG-GANTT-1106 : la suppression du dernier projet est autorisée.
  // La base se retrouve alors vide (current_project_id = null, tasks = []).
  it('v1.24 / RG-GANTT-1106 — DELETE /api/projects/:id autorise la suppression du dernier projet', async () => {
    const list = await request(app).get('/api/projects').expect(200)
    const only = list.body.projects[0]
    await request(app).delete(`/api/projects/${only.id}`).expect(200)
    const after = await request(app).get('/api/state').expect(200)
    expect(after.body.projects).toEqual([])
    expect(after.body.current_project_id).toBeNull()
    expect(after.body.tasks).toEqual([])
  })

  it('POST /api/tasks rattache la tâche au project_id fourni', async () => {
    await request(app)
      .post('/api/projects')
      .send({ id: 'p_other', name: 'Autre' })
      .expect(200)
    await request(app)
      .post('/api/tasks')
      .send({
        id: 't_iso',
        name: 'Tâche isolée',
        start_date: '2026-09-01',
        project_id: 'p_other',
      })
      .expect(200)
    const state = await request(app)
      .get('/api/state?project_id=p_other')
      .expect(200)
    expect(state.body.tasks).toHaveLength(1)
    expect(state.body.tasks[0].id).toBe('t_iso')
  })

  // v1.24 — RG-GANTT-1107 : les collaborateurs sont partagés entre TOUS les
  // projets. Créer un collab le rend disponible quel que soit le projet
  // courant.
  it('v1.24 / RG-GANTT-1107 — les collaborateurs sont partagés entre projets', async () => {
    // Récupère l'id du projet par défaut existant.
    const initial = await request(app).get('/api/state').expect(200)
    const projetDefault = initial.body.current_project_id
    // Crée un 2e projet pour exercer le partage.
    await request(app)
      .post('/api/projects')
      .send({ id: 'p_partage', name: 'Projet partagé' })
      .expect(200)
    // Crée un nouveau collaborateur.
    await request(app)
      .post('/api/collaborators')
      .send({ id: 'c_partagee', name: 'Inès' })
      .expect(200)
    // GET state du projet par défaut → voit Inès.
    const s1 = await request(app)
      .get(`/api/state?project_id=${projetDefault}`)
      .expect(200)
    expect(s1.body.collaborators.some((c) => c.id === 'c_partagee')).toBe(true)
    // GET state du 2e projet → voit aussi Inès (collabs partagés).
    const s2 = await request(app)
      .get('/api/state?project_id=p_partage')
      .expect(200)
    expect(s2.body.collaborators.some((c) => c.id === 'c_partagee')).toBe(true)
  })

  it('GET /api/projects renvoie la liste seule', async () => {
    const r = await request(app).get('/api/projects').expect(200)
    expect(Array.isArray(r.body.projects)).toBe(true)
    expect(r.body.projects.length).toBeGreaterThanOrEqual(1)
  })

  it('GET /api/state?project_id=inconnu retombe sur le premier projet', async () => {
    const r = await request(app)
      .get('/api/state?project_id=p_inexistant')
      .expect(200)
    // Le projet demandé n'existe pas → le serveur substitue le premier projet.
    expect(r.body.current_project_id).not.toBe('p_inexistant')
    expect(r.body.projects.length).toBeGreaterThanOrEqual(1)
  })

  it('POST /api/projects sans id → 400 (validation Zod)', async () => {
    const r = await request(app)
      .post('/api/projects')
      .send({ name: 'Sans id' })
      .expect(400)
    expect(r.body.error).toBe('Validation échouée')
  })

  it('PATCH /api/projects/inconnu → 404', async () => {
    await request(app)
      .patch('/api/projects/inconnu')
      .send({ name: 'X' })
      .expect(404)
  })

  it('PATCH /api/projects body vide → 400', async () => {
    const list = await request(app).get('/api/projects').expect(200)
    await request(app)
      .patch(`/api/projects/${list.body.projects[0].id}`)
      .send({})
      .expect(400)
  })

  it('DELETE /api/projects/inconnu (avec autre projet existant) → 404', async () => {
    // Crée un 2e projet pour ne pas tomber sur la règle "dernier projet".
    await request(app)
      .post('/api/projects')
      .send({ id: 'p_x', name: 'X' })
      .expect(200)
    await request(app).delete('/api/projects/p_inconnu').expect(404)
  })
})

// =============================================================================
// CHEMINS D'ERREUR — couverture des branches restantes
// =============================================================================

describe('Erreurs et validation (couverture)', () => {
  let app
  beforeEach(() => {
    app = makeApp()
  })

  it('GET /api/state?project_id=… invalide (>64 char) → 400 (validation query)', async () => {
    const tooLong = 'a'.repeat(65)
    const r = await request(app)
      .get(`/api/state?project_id=${tooLong}`)
      .expect(400)
    expect(r.body.error).toBe('Validation échouée')
    expect(r.body.details[0].where).toBe('query')
  })

  it('PATCH /api/collaborators/<id>/ id trop long → 400 (validation params)', async () => {
    // 65 caractères → dépasse `NonEmptyId.max(64)` → branche `params` de validate().
    const tooLong = 'a'.repeat(65)
    const r = await request(app)
      .patch(`/api/collaborators/${tooLong}`)
      .send({ name: 'X' })
      .expect(400)
    expect(r.body.error).toBe('Validation échouée')
    expect(r.body.details[0].where).toBe('params')
  })

  it('POST /api/collaborators id déjà existant → 400 (PRIMARY KEY)', async () => {
    // Première création OK puis re-création avec le même id → catch dans
    // la route (createCollaborator lève → 400 explicite).
    await request(app).post('/api/collaborators').send({ id: 'c1', name: 'X' })
    const r = await request(app)
      .post('/api/collaborators')
      .send({ id: 'c1', name: 'Y' })
      .expect(400)
    expect(r.body.error).toMatch(/Création impossible/)
  })

  it('DELETE /api/collaborators/inconnu → 404', async () => {
    await request(app).delete('/api/collaborators/inconnu').expect(404)
  })

  it('PATCH /api/tasks/inconnu → 404', async () => {
    await request(app)
      .patch('/api/tasks/inconnu')
      .send({ name: 'X' })
      .expect(404)
  })

  it('POST /api/tasks predecessor_id inexistant → 400 (FK violée, catch route)', async () => {
    // La FK `predecessor_id REFERENCES tasks(id)` empêche l'insert : le
    // catch de la route renvoie 400 avec un message lisible. Cible la
    // branche `catch (err)` du POST /api/tasks.
    const origErr = console.error
    console.error = () => {}
    try {
      const r = await request(app)
        .post('/api/tasks')
        .send({
          id: 't_ok',
          name: 'OK',
          start_date: '2026-09-01',
          end_date: '2026-09-05',
          predecessor_id: 'inconnu',
        })
        .expect(400)
      expect(r.body.error).toMatch(/Création impossible/)
    } finally {
      console.error = origErr
    }
  })

  it('POST /api/tasks/:id/move sur cycle → 400 (catch route)', async () => {
    // On tente de déplacer t1 sous lui-même → moveTask lève → 400.
    const r = await request(app)
      .post('/api/tasks/t1/move')
      .send({ parent_id: 't1', before_id: null })
      .expect(400)
    expect(r.body.error).toMatch(/Déplacement impossible/)
  })

  it('POST /api/tasks/:id/move sur id inconnu → 404', async () => {
    await request(app)
      .post('/api/tasks/inconnu/move')
      .send({ parent_id: null, before_id: null })
      .expect(404)
  })

  it('POST /api/projects avec id dupliqué → 400 (catch route)', async () => {
    const origErr = console.error
    console.error = () => {}
    try {
      await request(app)
        .post('/api/projects')
        .send({ id: 'p_dup', name: 'A' })
        .expect(200)
      const r = await request(app)
        .post('/api/projects')
        .send({ id: 'p_dup', name: 'B' })
        .expect(400)
      expect(r.body.error).toMatch(/Création impossible/)
    } finally {
      console.error = origErr
    }
  })

  it('logger de requête activé (couverture de la branche requestLog)', async () => {
    // Construit une app à part avec le log activé pour couvrir la branche
    // (l'app de test par défaut est créée avec requestLog: false).
    const db = initDb(':memory:')
    replaceFullState(db, DEMO_STATE)
    const appWithLog = createApp(db, { requestLog: true })
    const origLog = console.log
    console.log = () => {}
    try {
      await request(appWithLog).get('/api/state').expect(200)
    } finally {
      console.log = origLog
    }
  })

  it('JSON malformé → 500 via le handler global', async () => {
    // express.json() rejette → next(err) → handler global → 500.
    // On désactive le log console pendant ce test pour ne pas polluer la sortie.
    const origErr = console.error
    console.error = () => {}
    try {
      await request(app)
        .post('/api/tasks')
        .set('Content-Type', 'application/json')
        .send('{"id": "tBad", ') // JSON tronqué volontaire
        .expect(500)
    } finally {
      console.error = origErr
    }
  })
})

// =============================================================================
// v2.0 / F1 — Routes Memberships
// =============================================================================

describe('v2.0 / F1 — /api/projects/:id/members', () => {
  let app
  beforeEach(() => {
    app = makeApp()
  })

  // RG-GANTT-1203 — GET expose la liste des ids membres du projet.
  it('GET liste les membres du projet', async () => {
    // L'app de test charge DEMO_STATE qui a déjà des tâches affectées : la
    // migration auto-pop a donc dû créer des memberships pour le projet
    // courant. On vérifie juste que la route répond 200 + tableau.
    const state = await request(app).get('/api/state').expect(200)
    const projectId = state.body.current_project_id
    const r = await request(app)
      .get(`/api/projects/${encodeURIComponent(projectId)}/members`)
      .expect(200)
    expect(Array.isArray(r.body.members)).toBe(true)
  })

  it('GET sur projet inconnu → 404', async () => {
    await request(app).get('/api/projects/unknown/members').expect(404)
  })

  // RG-GANTT-1201 — POST ajoute un membership (idempotent).
  it('POST ajoute un collaborateur à un projet', async () => {
    const state = await request(app).get('/api/state').expect(200)
    const projectId = state.body.current_project_id
    // On crée un nouveau collab dédié pour tester l'ajout proprement (les
    // memberships auto-créées par le seed concernent les collabs déjà
    // existants — on veut tester le cas added=true).
    const newCollabId = 'cNew'
    await request(app)
      .post('/api/collaborators')
      .send({ id: newCollabId, name: 'Nouveau', color: '#ff00ff' })
      .expect(200)

    const r1 = await request(app)
      .post(`/api/projects/${encodeURIComponent(projectId)}/members`)
      .send({ collaborator_id: newCollabId })
      .expect(200)
    expect(r1.body.added).toBe(true)

    // 2e POST : idempotent (added=false, même version).
    const r2 = await request(app)
      .post(`/api/projects/${encodeURIComponent(projectId)}/members`)
      .send({ collaborator_id: newCollabId })
      .expect(200)
    expect(r2.body.added).toBe(false)
    expect(r2.body.version).toBe(r1.body.version)

    // GET liste : doit contenir newCollabId.
    const list = await request(app)
      .get(`/api/projects/${encodeURIComponent(projectId)}/members`)
      .expect(200)
    expect(list.body.members).toContain(newCollabId)
  })

  it('POST sur projet inconnu → 400', async () => {
    await request(app)
      .post('/api/projects/unknown/members')
      .send({ collaborator_id: collabIdFromSeed() })
      .expect(400)
  })

  it('POST collab inconnu → 400', async () => {
    const state = await request(app).get('/api/state').expect(200)
    const projectId = state.body.current_project_id
    await request(app)
      .post(`/api/projects/${encodeURIComponent(projectId)}/members`)
      .send({ collaborator_id: 'unknown' })
      .expect(400)
  })

  it('POST sans body → 400 (validation)', async () => {
    const state = await request(app).get('/api/state').expect(200)
    const projectId = state.body.current_project_id
    await request(app)
      .post(`/api/projects/${encodeURIComponent(projectId)}/members`)
      .send({})
      .expect(400)
  })

  // Helper local : valeur arbitraire d'un collab dans le seed pour les
  // assertions qui n'ont besoin que d'un id existant.
  function collabIdFromSeed() {
    return DEMO_STATE.collaborators[0]?.id ?? 'c1'
  }
})

// =============================================================================
// v2.0 / F1 — GET /api/state expose current_project_members
// =============================================================================

describe('v2.0 / F1 — GET /api/state.current_project_members', () => {
  it('le tableau est exposé et cohérent avec la liste des membres', async () => {
    const app = makeApp()
    const r = await request(app).get('/api/state').expect(200)
    expect(Array.isArray(r.body.current_project_members)).toBe(true)
    // Doit correspondre à GET /members du projet courant.
    const projectId = r.body.current_project_id
    const list = await request(app)
      .get(`/api/projects/${encodeURIComponent(projectId)}/members`)
      .expect(200)
    expect(r.body.current_project_members.sort()).toEqual(
      list.body.members.sort(),
    )
  })
})

// =============================================================================
// v2.0 / F5 — Plan de charge global (cross-projet)
// =============================================================================

describe('v2.0 / F5 — /api/workload/global', () => {
  it('GET retourne les activités cross-projet (kind=task, collab non-null)', async () => {
    const app = makeApp()
    const r = await request(app).get('/api/workload/global').expect(200)
    expect(Array.isArray(r.body.tasks)).toBe(true)
    // Tous les retours doivent être des activités assignées.
    for (const t of r.body.tasks) {
      expect(t.kind).toBe('task')
      expect(t.collaborator_id).not.toBeNull()
    }
  })

  it('GET /api/state expose all_member_allocations', async () => {
    const app = makeApp()
    const r = await request(app).get('/api/state').expect(200)
    expect(Array.isArray(r.body.all_member_allocations)).toBe(true)
  })
})

// =============================================================================
// v2.1 / F2.9 — PATCH /api/allocations/:id
// =============================================================================
// Vérifie la nouvelle route d'extension/modification d'une période
// d'allocation, utilisée par le AllocationFixDialog au save d'une activité
// non absorbable.
// =============================================================================

describe('v2.1 / RG-GANTT-1907 — PATCH /api/allocations/:id', () => {
  let app
  /** Id d'une allocation pré-créée pour les tests. */
  let allocId

  beforeEach(async () => {
    app = makeApp()
    // Ajouter une membership crée AUTOMATIQUEMENT une allocation par défaut
    // 100 % couvrant [2020-01-01, 2099-12-31] (cf. `addProjectMember`).
    // On la récupère via /api/state pour la patcher dans les tests.
    const state = await request(app).get('/api/state').expect(200)
    const projectId = state.body.current_project_id
    const collabId = state.body.collaborators[0].id
    await request(app)
      .post(`/api/projects/${encodeURIComponent(projectId)}/members`)
      .send({ collaborator_id: collabId })
      .expect(200)
    const after = await request(app).get('/api/state').expect(200)
    const alloc = after.body.member_allocations.find(
      (a) => a.collaborator_id === collabId,
    )
    expect(alloc).toBeTruthy()
    allocId = alloc.id
  })

  it('raccourcit end_date avec succès', async () => {
    // L'allocation par défaut couvre 2020-2099. On la raccourcit pour
    // vérifier que le PATCH agit bien (changed=true + valeur persistée).
    // Le test miroir (extension) est couvert par les tests DAL — ici on
    // valide juste le pipeline route → DAL.
    const r = await request(app)
      .patch(`/api/allocations/${allocId}`)
      .send({ end_date: '2030-12-31' })
      .expect(200)
    expect(r.body.changed).toBe(true)
    expect(r.body.allocation.end_date).toBe('2030-12-31')
    expect(r.body.allocation.allocation_pct).toBe(100)
  })

  it('id inconnu → 404', async () => {
    await request(app)
      .patch('/api/allocations/alloc_inexistant')
      .send({ end_date: '2030-12-31' })
      .expect(404)
  })

  it('pct invalide → 400', async () => {
    const r = await request(app)
      .patch(`/api/allocations/${allocId}`)
      .send({ allocation_pct: 33 })
      .expect(400)
    expect(r.body.error).toBeTruthy()
  })

  it('end_date < start_date → 400 (validation Zod)', async () => {
    await request(app)
      .patch(`/api/allocations/${allocId}`)
      .send({ start_date: '2030-08-01', end_date: '2030-07-01' })
      .expect(400)
  })
})
