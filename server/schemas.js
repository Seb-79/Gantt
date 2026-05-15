// =============================================================================
// SCHÉMAS DE VALIDATION (Zod) — API Gantt v1
// =============================================================================
// Centralise toutes les règles de validation des payloads HTTP entrants.
// Avantages :
//   • Messages d'erreur précis ({ where, path, message })
//   • Une source unique de vérité par endpoint
//   • Validation params + body en une passe (middleware `validate`)
//
// Convention pour les erreurs :
//   400 + { error: 'Validation échouée', details: [{ where, path, message }] }
// =============================================================================

import { z } from 'zod'

/** Identifiant non vide (utilisé pour les IDs de collab et de tâche). */
const NonEmptyId = z
  .string({ message: 'doit être une chaîne' })
  .min(1, 'ne peut pas être vide')
  .max(64, 'maximum 64 caractères')

/** Texte libre (nom de tâche, nom de collab) — non vide. */
const NonEmptyText = z
  .string({ message: 'doit être une chaîne' })
  .min(1, 'ne peut pas être vide')
  .max(200, 'maximum 200 caractères')

/** Couleur hexadécimale type "#RRGGBB" ou "#RGB". */
const HexColor = z
  .string({ message: 'doit être une chaîne' })
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'doit être au format #RRGGBB')

/** Date au format ISO `YYYY-MM-DD`. */
const IsoDate = z
  .string({ message: 'doit être une chaîne' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'doit être au format YYYY-MM-DD')

/** Type de tâche : tâche normale ou jalon. */
const TaskKind = z.enum(['task', 'milestone'], {
  message: "doit valoir 'task' ou 'milestone'",
})

/** Pourcentage d'avancement, 0..100. */
const Progress = z
  .number({ message: 'doit être un nombre' })
  .int('doit être entier')
  .min(0, 'doit être ≥ 0')
  .max(100, 'doit être ≤ 100')

// -----------------------------------------------------------------------------
// COLLABORATEURS
// -----------------------------------------------------------------------------

export const CreateCollaboratorBody = z.object({
  id: NonEmptyId,
  name: NonEmptyText,
  color: HexColor.optional(),
})

export const UpdateCollaboratorBody = z
  .object({
    name: NonEmptyText.optional(),
    color: HexColor.optional(),
  })
  .refine((v) => v.name !== undefined || v.color !== undefined, {
    message: 'au moins un champ requis (name ou color)',
  })

export const CollaboratorIdParams = z.object({ id: NonEmptyId })

// -----------------------------------------------------------------------------
// TÂCHES & JALONS
// -----------------------------------------------------------------------------

/**
 * Pour la création, on impose start_date. end_date est optionnel : pour une
 * tâche, il vaut start_date par défaut ; pour un jalon, on l'ignore et on
 * force end_date = start_date côté DAL.
 */
export const CreateTaskBody = z
  .object({
    id: NonEmptyId,
    name: NonEmptyText,
    kind: TaskKind.optional(),
    start_date: IsoDate,
    end_date: IsoDate.optional(),
    progress: Progress.optional(),
    collaborator_id: NonEmptyId.nullable().optional(),
    color: HexColor.nullable().optional(),
    parent_id: NonEmptyId.nullable().optional(),
    // v1.2 — Tâche prédécesseur. Si renseignée, le DAL force la start_date
    // sur la end_date du prédécesseur (cf. db/index.js).
    predecessor_id: NonEmptyId.nullable().optional(),
  })
  .refine((v) => !v.end_date || v.end_date >= v.start_date, {
    message: 'end_date doit être ≥ start_date',
    path: ['end_date'],
  })

export const UpdateTaskBody = z
  .object({
    name: NonEmptyText.optional(),
    kind: TaskKind.optional(),
    start_date: IsoDate.optional(),
    end_date: IsoDate.optional(),
    progress: Progress.optional(),
    collaborator_id: NonEmptyId.nullable().optional(),
    color: HexColor.nullable().optional(),
    parent_id: NonEmptyId.nullable().optional(),
    predecessor_id: NonEmptyId.nullable().optional(), // v1.2
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'au moins un champ doit être fourni',
  })

export const TaskIdParams = z.object({ id: NonEmptyId })

// -----------------------------------------------------------------------------
// MIDDLEWARE de validation
// -----------------------------------------------------------------------------

/**
 * Construit un middleware Express qui valide req.params, req.body et/ou
 * req.query selon les schémas passés. Si la validation passe, req.params
 * et req.body sont **remplacés** par leurs versions parsées (typées et
 * coercées). Sinon, on répond 400 avec un détail structuré.
 *
 * @param {{params?: import('zod').ZodTypeAny, body?: import('zod').ZodTypeAny, query?: import('zod').ZodTypeAny}} schemas
 * @returns {import('express').RequestHandler}
 */
export function validate(schemas) {
  return (req, res, next) => {
    const details = []

    if (schemas.params) {
      const r = schemas.params.safeParse(req.params)
      if (!r.success) {
        for (const issue of r.error.issues) {
          details.push({
            where: 'params',
            path: issue.path,
            message: issue.message,
          })
        }
      } else {
        req.params = r.data
      }
    }

    if (schemas.body) {
      const r = schemas.body.safeParse(req.body)
      if (!r.success) {
        for (const issue of r.error.issues) {
          details.push({
            where: 'body',
            path: issue.path,
            message: issue.message,
          })
        }
      } else {
        req.body = r.data
      }
    }

    if (schemas.query) {
      const r = schemas.query.safeParse(req.query)
      if (!r.success) {
        for (const issue of r.error.issues) {
          details.push({
            where: 'query',
            path: issue.path,
            message: issue.message,
          })
        }
      } else {
        // req.query est read-only en Express 5 — on annexe le résultat
        // sur un attribut séparé pour les routes qui en ont besoin.
        req.validQuery = r.data
      }
    }

    if (details.length > 0) {
      return res.status(400).json({ error: 'Validation échouée', details })
    }
    next()
  }
}
