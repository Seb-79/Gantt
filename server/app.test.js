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

  it('PATCH definir un predecesseur recale start_date', async () => {
    // t2a (tournage extérieur) commence 2026-07-01 ; on lui ajoute t1a comme
    // prédécesseur (fin 2026-05-29) → start_date doit être recalée.
    const r = await request(app)
      .patch('/api/tasks/t2a')
      .send({ predecessor_id: 't1a' })
      .expect(200)
    expect(r.body.changed).toBe(true)
    const state = await request(app).get('/api/state').expect(200)
    const t2a = state.body.tasks.find((t) => t.id === 't2a')
    expect(t2a.start_date).toBe('2026-05-29')
    expect(t2a.predecessor_id).toBe('t1a')
  })
})
