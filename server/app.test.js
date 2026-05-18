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
