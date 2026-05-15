// =============================================================================
// FACTORY EXPRESS — API Gantt v1
// =============================================================================
// Reçoit une base SQLite déjà initialisée et renvoie une app Express prête
// à servir. Aucun effet de bord au top-level → testable directement avec
// supertest sur une base `:memory:`.
//
// Endpoints :
//   GET    /api/state                  → état complet
//   POST   /api/reset                  → restaure les données de démo
//   POST   /api/collaborators          → crée un collaborateur
//   PATCH  /api/collaborators/:id      → modifie un collaborateur
//   DELETE /api/collaborators/:id      → supprime
//   POST   /api/tasks                  → crée une tâche ou un jalon
//   PATCH  /api/tasks/:id              → modifie
//   DELETE /api/tasks/:id              → supprime (cascade enfants)
//
// Toutes les routes mutantes renvoient au minimum `{ version }`.
// =============================================================================

import express from 'express'
import helmet from 'helmet'
import {
  createCollaborator,
  createTask,
  deleteCollaborator,
  deleteTask,
  getFullState,
  getVersion,
  moveTask,
  resetToDemo,
  updateCollaborator,
  updateTask,
} from '../db/index.js'
import {
  CollaboratorIdParams,
  CreateCollaboratorBody,
  CreateTaskBody,
  MoveTaskBody,
  TaskIdParams,
  UpdateCollaboratorBody,
  UpdateTaskBody,
  validate,
} from './schemas.js'

/**
 * Wrap une route async pour qu'une exception non rattrapée soit transmise
 * au handler global d'erreur (qui répond 500 + JSON).
 *
 * @param {(req: import('express').Request, res: import('express').Response) => any} handler
 * @returns {import('express').RequestHandler}
 */
function safeRoute(handler) {
  return (req, res, next) => {
    try {
      Promise.resolve(handler(req, res)).catch(next)
    } catch (err) {
      next(err)
    }
  }
}

/**
 * Construit l'application Express attachée à la base passée en paramètre.
 *
 * @param {import('better-sqlite3').Database} db        Base SQLite déjà initialisée.
 * @param {object} [options]
 * @param {boolean} [options.requestLog=true]           Log de chaque requête.
 * @returns {import('express').Express}                 App prête à `listen()`.
 */
export function createApp(db, { requestLog = true } = {}) {
  const app = express()

  // Helmet — durcissement des headers HTTP. CSP désactivée (API JSON pure,
  // ne sert pas de pages HTML).
  app.use(
    helmet({
      contentSecurityPolicy: false,
      strictTransportSecurity: false,
    }),
  )

  app.use(express.json({ limit: '2mb' }))

  if (requestLog) {
    app.use((req, _res, next) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`)
      next()
    })
  }

  // -------------------------------------------------------------------------
  // LECTURE
  // -------------------------------------------------------------------------

  app.get(
    '/api/state',
    safeRoute((_req, res) => {
      res.json(getFullState(db))
    }),
  )

  // -------------------------------------------------------------------------
  // RESET (données de démo)
  // -------------------------------------------------------------------------

  app.post(
    '/api/reset',
    safeRoute((_req, res) => {
      resetToDemo(db)
      res.json(getFullState(db))
    }),
  )

  // -------------------------------------------------------------------------
  // COLLABORATEURS
  // -------------------------------------------------------------------------

  app.post(
    '/api/collaborators',
    validate({ body: CreateCollaboratorBody }),
    safeRoute((req, res) => {
      try {
        res.json(createCollaborator(db, req.body))
      } catch (err) {
        // PRIMARY KEY violée par exemple → 400 explicite
        res.status(400).json({ error: `Création impossible : ${err.message}` })
      }
    }),
  )

  app.patch(
    '/api/collaborators/:id',
    validate({ params: CollaboratorIdParams, body: UpdateCollaboratorBody }),
    safeRoute((req, res) => {
      const result = updateCollaborator(db, req.params.id, req.body)
      if (!result.changed) {
        return res.status(404).json({
          error: 'collaborateur introuvable',
          version: result.version,
        })
      }
      res.json(result)
    }),
  )

  app.delete(
    '/api/collaborators/:id',
    validate({ params: CollaboratorIdParams }),
    safeRoute((req, res) => {
      const result = deleteCollaborator(db, req.params.id)
      if (!result.changed) {
        return res.status(404).json({
          error: 'collaborateur introuvable',
          version: result.version,
        })
      }
      res.json(result)
    }),
  )

  // -------------------------------------------------------------------------
  // TÂCHES & JALONS
  // -------------------------------------------------------------------------

  app.post(
    '/api/tasks',
    validate({ body: CreateTaskBody }),
    safeRoute((req, res) => {
      try {
        res.json(createTask(db, req.body))
      } catch (err) {
        res.status(400).json({ error: `Création impossible : ${err.message}` })
      }
    }),
  )

  app.patch(
    '/api/tasks/:id',
    validate({ params: TaskIdParams, body: UpdateTaskBody }),
    safeRoute((req, res) => {
      const result = updateTask(db, req.params.id, req.body)
      if (!result.changed) {
        return res.status(404).json({
          error: 'tâche introuvable',
          version: result.version,
        })
      }
      res.json(result)
    }),
  )

  app.delete(
    '/api/tasks/:id',
    validate({ params: TaskIdParams }),
    safeRoute((req, res) => {
      const result = deleteTask(db, req.params.id)
      if (!result.changed) {
        return res.status(404).json({
          error: 'tâche introuvable',
          version: result.version,
        })
      }
      res.json(result)
    }),
  )

  /**
   * v1.5 — Déplace une tâche dans la hiérarchie (drag & drop côté UI).
   * Body : { parent_id, before_id } (cf. MoveTaskBody).
   * Erreurs métier (cycle, parent inexistant) → 400 explicite.
   */
  app.post(
    '/api/tasks/:id/move',
    validate({ params: TaskIdParams, body: MoveTaskBody }),
    safeRoute((req, res) => {
      try {
        const result = moveTask(db, req.params.id, req.body)
        if (!result.changed) {
          return res.status(404).json({
            error: 'tâche introuvable',
            version: result.version,
          })
        }
        res.json(result)
      } catch (err) {
        res
          .status(400)
          .json({ error: `Déplacement impossible : ${err.message}` })
      }
    }),
  )

  // -------------------------------------------------------------------------
  // GESTION D'ERREUR GLOBALE
  // -------------------------------------------------------------------------

  app.use((err, _req, res, _next) => {
    console.error('[ERR]', err)
    let version = null
    try {
      version = getVersion(db)
    } catch {
      // pas grave, on renvoie sans version
    }
    res.status(500).json({ error: err.message, version })
  })

  return app
}
