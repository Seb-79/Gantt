// =============================================================================
// FACTORY EXPRESS — API Gantt v1
// =============================================================================
// Reçoit une base SQLite déjà initialisée et renvoie une app Express prête
// à servir. Aucun effet de bord au top-level → testable directement avec
// supertest sur une base `:memory:`.
//
// Endpoints :
//   GET    /api/state?project_id=…     → état du projet courant (v1.8)
//   POST   /api/reset                  → restaure les données de démo
//   GET    /api/projects               → liste les projets (v1.8)
//   POST   /api/projects               → crée un projet (v1.8)
//   PATCH  /api/projects/:id           → renomme un projet (v1.8)
//   DELETE /api/projects/:id           → supprime un projet (cascade tâches)
//   POST   /api/collaborators          → crée un collaborateur
//   PATCH  /api/collaborators/:id      → modifie un collaborateur
//   DELETE /api/collaborators/:id      → supprime
//   POST   /api/tasks                  → crée une tâche, un jalon ou une phase
//   PATCH  /api/tasks/:id              → modifie
//   DELETE /api/tasks/:id              → supprime (cascade enfants)
//   POST   /api/tasks/:id/move         → déplace dans la hiérarchie (drag&drop)
//
// Toutes les routes mutantes renvoient au minimum `{ version }`.
// =============================================================================

import express from 'express'
import helmet from 'helmet'
import {
  addAbsence,
  addMemberAllocation,
  addProjectMember,
  createCollaborator,
  createProject,
  createTask,
  deleteAbsence,
  deleteCollaborator,
  deleteMemberAllocation,
  updateMemberAllocation,
  deleteProject,
  deleteTask,
  getFullState,
  getVersion,
  listAbsences,
  listGlobalWorkloadTasks,
  listMemberAllocations,
  listProjectMembers,
  listProjects,
  moveTask,
  updateCollaborator,
  updateProject,
  updateTask,
} from '../db/index.js'
import {
  AddAbsenceBody,
  AddMemberAllocationBody,
  AddProjectMemberBody,
  AllocationIdParams,
  CollabAbsenceParams,
  CollaboratorIdParams,
  CreateCollaboratorBody,
  CreateProjectBody,
  CreateTaskBody,
  MoveTaskBody,
  ProjectCollabParams,
  ProjectIdParams,
  StateQuery,
  TaskIdParams,
  UpdateCollaboratorBody,
  UpdateMemberAllocationBody,
  UpdateProjectBody,
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

  // Helmet — durcissement des headers HTTP. CSP désactivée volontairement :
  // cette app Express ne sert QUE l'API JSON (les pages HTML sont servies par
  // Vite côté front, qui pose sa propre CSP). HSTS désactivée aussi : on est
  // en HTTP local sur LAN, pas en HTTPS public.
  // eslint-disable-next-line sonarjs/content-security-policy
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
    validate({ query: StateQuery }),
    safeRoute((req, res) => {
      // v1.8 — `validate({query})` dépose le query parsé sur req.validQuery
      // (req.query est read-only sur Express 5).
      const projectId = req.validQuery?.project_id
      res.json(getFullState(db, projectId))
    }),
  )

  /**
   * v2.0 / F5 — Plan de charge global : renvoie TOUTES les activités (kind=task)
   * de TOUS les projets avec les champs nécessaires au calcul du workload
   * (sans alourdir avec name, color, predecessors, etc.). Les allocations et
   * absences cross-projet sont déjà exposées dans /api/state via
   * `all_member_allocations` et `collaborator_absences`.
   *
   * Fetché à la demande quand l'utilisateur bascule sur la « vue globale »
   * de l'onglet Plan de charge.
   */
  app.get(
    '/api/workload/global',
    safeRoute((_req, res) => {
      // v2.3 (2026-05-28) — Délègue à `listGlobalWorkloadTasks` qui joint
      // `task_assignments` et expose `collaborators[]`. Avant, l'endpoint
      // renvoyait uniquement le legacy `collaborator_id`, ce qui rendait
      // invisible la charge multi-collab dans le plan de charge global
      // (par ex. : tâche affectée à Alice + Benoît → seule Alice était peinte).
      res.json({ tasks: listGlobalWorkloadTasks(db) })
    }),
  )

  // -------------------------------------------------------------------------
  // PROJETS (v1.8)
  // -------------------------------------------------------------------------

  app.get(
    '/api/projects',
    safeRoute((_req, res) => {
      res.json({ projects: listProjects(db) })
    }),
  )

  app.post(
    '/api/projects',
    validate({ body: CreateProjectBody }),
    safeRoute((req, res) => {
      try {
        res.json(createProject(db, req.body))
      } catch (err) {
        res.status(400).json({ error: `Création impossible : ${err.message}` })
      }
    }),
  )

  app.patch(
    '/api/projects/:id',
    validate({ params: ProjectIdParams, body: UpdateProjectBody }),
    safeRoute((req, res) => {
      const result = updateProject(db, req.params.id, req.body)
      // v2.3 / RG-GANTT-2110 — Violation de la règle de validation date.
      if (result.code === 'PROJECT_START_AFTER_TASK') {
        return res.status(400).json({
          error: result.message,
          code: result.code,
          conflictingTask: result.conflictingTask,
          version: result.version,
        })
      }
      if (!result.changed) {
        return res.status(404).json({
          error: 'projet introuvable',
          version: result.version,
        })
      }
      res.json(result)
    }),
  )

  app.delete(
    '/api/projects/:id',
    validate({ params: ProjectIdParams }),
    safeRoute((req, res) => {
      // v1.24 — RG-GANTT-1106 : la suppression du dernier projet est
      // désormais autorisée. Le DAL ne lève plus aucune exception métier ;
      // la base peut se retrouver vide, ce qui est un état valide.
      const result = deleteProject(db, req.params.id)
      if (!result.changed) {
        return res.status(404).json({
          error: 'projet introuvable',
          version: result.version,
        })
      }
      res.json(result)
    }),
  )

  // -------------------------------------------------------------------------
  // MEMBERSHIPS (v2.0 / F1) — projet ↔ collaborateur
  // -------------------------------------------------------------------------

  /**
   * v2.0 / F1 — Liste les ids des collaborateurs membres d'un projet.
   * 404 si le projet n'existe pas.
   */
  app.get(
    '/api/projects/:id/members',
    validate({ params: ProjectIdParams }),
    safeRoute((req, res) => {
      // Vérifie l'existence du projet pour différencier « projet vide d'équipe »
      // (200, []) de « projet inconnu » (404).
      const exists = listProjects(db).some((p) => p.id === req.params.id)
      if (!exists) {
        return res.status(404).json({ error: 'projet introuvable' })
      }
      res.json({ members: listProjectMembers(db, req.params.id) })
    }),
  )

  /**
   * v2.0 / F1 — Ajoute un collaborateur à l'équipe d'un projet. Idempotent
   * (un POST en double n'incrémente la version qu'une fois).
   * 400 si le projet ou le collaborateur sont introuvables.
   */
  app.post(
    '/api/projects/:id/members',
    validate({ params: ProjectIdParams, body: AddProjectMemberBody }),
    safeRoute((req, res) => {
      try {
        const result = addProjectMember(
          db,
          req.params.id,
          req.body.collaborator_id,
        )
        res.json(result)
      } catch (err) {
        // Mapping code d'erreur DAL → message lisible. Switch plutôt que
        // ternaire imbriqué pour rester lint-friendly (sonarjs).
        let msg
        if (err.code === 'PROJECT_NOT_FOUND') msg = 'projet introuvable'
        else if (err.code === 'COLLABORATOR_NOT_FOUND')
          msg = 'collaborateur introuvable'
        else msg = `Ajout impossible : ${err.message}`
        res.status(400).json({ error: msg })
      }
    }),
  )

  // -------------------------------------------------------------------------
  // ALLOCATIONS (v2.0 / F2) — périodes %
  // -------------------------------------------------------------------------

  /**
   * v2.0 / F2 — Liste les allocations d'un membre dans un projet, triées par
   * date. 404 si le projet ou la membership n'existent pas.
   */
  app.get(
    '/api/projects/:id/members/:collabId/allocations',
    validate({ params: ProjectCollabParams }),
    safeRoute((req, res) => {
      const { id, collabId } = req.params
      const projectExists = listProjects(db).some((p) => p.id === id)
      if (!projectExists) {
        return res.status(404).json({ error: 'projet introuvable' })
      }
      const isMember = listProjectMembers(db, id).includes(collabId)
      if (!isMember) {
        return res
          .status(404)
          .json({ error: 'collaborateur non membre du projet' })
      }
      res.json({ allocations: listMemberAllocations(db, id, collabId) })
    }),
  )

  /**
   * v2.0 / F2 — Ajoute une période d'allocation pour un membre. Le DAL valide :
   *   • % ∈ {25,50,75,100}
   *   • pas de chevauchement (RG-GANTT-1301)
   *   • membership existante
   * En cas d'erreur typée → 400 avec un message clair, sinon 200 avec le row.
   */
  app.post(
    '/api/projects/:id/members/:collabId/allocations',
    validate({ params: ProjectCollabParams, body: AddMemberAllocationBody }),
    safeRoute((req, res) => {
      try {
        const result = addMemberAllocation(db, {
          project_id: req.params.id,
          collaborator_id: req.params.collabId,
          start_date: req.body.start_date,
          end_date: req.body.end_date,
          allocation_pct: req.body.allocation_pct,
        })
        res.json(result)
      } catch (err) {
        let msg
        if (err.code === 'NOT_PROJECT_MEMBER')
          msg = 'collaborateur non membre du projet'
        else if (err.code === 'ALLOCATION_OVERLAP')
          msg = 'La période chevauche une période existante du membre.'
        else if (err.code === 'INVALID_ALLOCATION_PCT')
          msg = 'Pourcentage invalide (valeurs autorisées : 25, 50, 75, 100).'
        else if (err.code === 'INVALID_DATE_RANGE')
          msg = 'La date de fin doit être supérieure ou égale au début.'
        else msg = `Ajout impossible : ${err.message}`
        res.status(400).json({ error: msg })
      }
    }),
  )

  /**
   * v2.0 / F2 — Supprime une période d'allocation par son id. 404 si l'id
   * n'existe pas.
   */
  app.delete(
    '/api/allocations/:id',
    validate({ params: AllocationIdParams }),
    safeRoute((req, res) => {
      const result = deleteMemberAllocation(db, req.params.id)
      if (!result.changed) {
        return res
          .status(404)
          .json({ error: 'allocation introuvable', version: result.version })
      }
      res.json(result)
    }),
  )

  /**
   * v2.1 / F2.9 — Met à jour une période d'allocation (extension de end_date
   * notamment). Body partiel : tout champ omis reste inchangé. Validations
   * dupliquées côté DAL (pct ∈ {25,50,75,100}, dates cohérentes, pas de
   * chevauchement avec une AUTRE période). 404 si l'id n'existe pas, 400 si
   * l'invariant chevauchement / pct / dates est violé.
   */
  app.patch(
    '/api/allocations/:id',
    validate({
      params: AllocationIdParams,
      body: UpdateMemberAllocationBody,
    }),
    safeRoute((req, res) => {
      try {
        const result = updateMemberAllocation(db, req.params.id, req.body)
        if (!result.changed) {
          return res
            .status(404)
            .json({ error: 'allocation introuvable', version: result.version })
        }
        res.json(result)
      } catch (e) {
        // Codes d'erreur DAL → 400 lisibles (cf. addMemberAllocation pour le
        // pattern miroir). On expose le code applicatif via le payload pour
        // permettre au client de réagir (afficher un message ciblé).
        const knownCodes = new Set([
          'INVALID_ALLOCATION_PCT',
          'INVALID_DATE_RANGE',
          'ALLOCATION_OVERLAP',
        ])
        if (e && knownCodes.has(e.code)) {
          return res.status(400).json({ error: e.message, code: e.code })
        }
        throw e
      }
    }),
  )

  // -------------------------------------------------------------------------
  // ABSENCES (v2.0 / F3) — congés cross-projet
  // -------------------------------------------------------------------------

  /**
   * v2.0 / F3 — Liste les absences d'un collaborateur, triées par date.
   * 404 si le collaborateur n'existe pas.
   */
  app.get(
    '/api/collaborators/:id/absences',
    validate({ params: CollaboratorIdParams }),
    safeRoute((req, res) => {
      const exists = db
        .prepare(`SELECT 1 AS x FROM collaborators WHERE id = ?`)
        .get(req.params.id)
      if (!exists) {
        return res.status(404).json({ error: 'collaborateur introuvable' })
      }
      res.json({ absences: listAbsences(db, req.params.id) })
    }),
  )

  /**
   * v2.0 / F3 — Ajoute (ou remplace via UPSERT) une absence pour un collab.
   * 400 si le collab est inconnu ou la fraction invalide.
   */
  app.post(
    '/api/collaborators/:id/absences',
    validate({ params: CollaboratorIdParams, body: AddAbsenceBody }),
    safeRoute((req, res) => {
      try {
        const result = addAbsence(db, {
          collaborator_id: req.params.id,
          date: req.body.date,
          fraction: req.body.fraction,
        })
        res.json(result)
      } catch (err) {
        let msg
        if (err.code === 'COLLABORATOR_NOT_FOUND')
          msg = 'collaborateur introuvable'
        else if (err.code === 'INVALID_ABSENCE_FRACTION')
          msg = 'Fraction invalide (valeurs : 0.25, 0.5, 0.75, 1).'
        else msg = `Ajout impossible : ${err.message}`
        res.status(400).json({ error: msg })
      }
    }),
  )

  /**
   * v2.0 / F3 — Supprime une absence par (collab, date). 404 si la ligne
   * n'existe pas (cohérent avec les autres DELETE de l'API).
   */
  app.delete(
    '/api/collaborators/:id/absences/:date',
    validate({ params: CollabAbsenceParams }),
    safeRoute((req, res) => {
      const result = deleteAbsence(db, req.params.id, req.params.date)
      if (!result.changed) {
        return res
          .status(404)
          .json({ error: 'absence introuvable', version: result.version })
      }
      res.json(result)
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
