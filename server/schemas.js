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

/** Type de tâche : tâche normale, jalon ou phase (v1.6). */
const TaskKind = z.enum(['task', 'milestone', 'phase'], {
  message: "doit valoir 'task', 'milestone' ou 'phase'",
})

/** Pourcentage d'avancement, 0..100. */
const Progress = z
  .number({ message: 'doit être un nombre' })
  .int('doit être entier')
  .min(0, 'doit être ≥ 0')
  .max(100, 'doit être ≤ 100')

/** v1.10 — Délai (jours ouvrés) entre prédécesseur et successeur (≥ 0). */
const Lag = z
  .number({ message: 'doit être un nombre' })
  .int('doit être entier')
  .min(0, 'doit être ≥ 0')
  .max(3650, 'doit être ≤ 3650')

/**
 * v2.0 — Charge en jours ouvrés (≥ 1) d'une activité. Source de vérité
 * désormais : la date de fin est dérivée de `start_date + charge_jours`.
 * Plafonné à 3650 (≈ 10 ans) pour éviter les saisies aberrantes.
 */
const ChargeJours = z
  .number({ message: 'doit être un nombre' })
  .int('doit être entier')
  .min(1, 'doit être ≥ 1')
  .max(3650, 'doit être ≤ 3650')

/**
 * v1.18 — Priorité facultative pour le « Replan » : entier 1..5 ; 1 = la plus
 * prioritaire, 5 = la moins. `null` = « pas de priorité saisie ».
 */
const Priority = z
  .number({ message: 'doit être un nombre' })
  .int('doit être entier')
  .min(1, 'doit être entre 1 et 5')
  .max(5, 'doit être entre 1 et 5')

// -----------------------------------------------------------------------------
// PROJETS (v1.8)
// -----------------------------------------------------------------------------

// v2.3 / RG-GANTT-2000 — `project_start_date` optionnelle au POST (défaut
// applicatif = today côté DAL). Réutilise le `IsoDate` défini plus haut.
// La validation RG-2010 ne s'applique qu'au PATCH (à la création, le projet
// n'a pas encore de tâches).
export const CreateProjectBody = z.object({
  id: NonEmptyId,
  name: NonEmptyText,
  project_start_date: IsoDate.optional(),
})

export const UpdateProjectBody = z
  .object({
    name: NonEmptyText.optional(),
  })
  .refine((v) => v.name !== undefined, {
    message: 'au moins un champ requis (name)',
  })

export const ProjectIdParams = z.object({ id: NonEmptyId })

/** Query param ?project_id=... pour GET /api/state. */
export const StateQuery = z.object({
  project_id: NonEmptyId.optional(),
})

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
// MEMBERSHIPS (v2.0 / F1) — body de POST /api/projects/:id/members
// -----------------------------------------------------------------------------

/**
 * v2.0 / F1 — Ajout d'un collab à l'équipe d'un projet. Le `project_id` est
 * dans l'URL (params), seul `collaborator_id` est dans le body.
 */
export const AddProjectMemberBody = z.object({
  collaborator_id: NonEmptyId,
})

// -----------------------------------------------------------------------------
// ALLOCATIONS (v2.0 / F2) — périodes %
// -----------------------------------------------------------------------------

/**
 * v2.0 / F2 — Pourcentage d'allocation. Restreint aux 4 paliers validés avec
 * l'utilisateur. La validation est ici (rejette en Zod avant le DAL) et
 * répétée côté DAL (double filet pour la cohérence du modèle).
 */
const AllocationPct = z
  .number({ message: 'doit être un nombre' })
  .int('doit être entier')
  .refine((v) => v === 25 || v === 50 || v === 75 || v === 100, {
    message: 'doit valoir 25, 50, 75 ou 100',
  })

/**
 * v2.0 / F2 — Body de POST /api/projects/:id/members/:collabId/allocations.
 * Le triplet (project_id, collaborator_id) est dans l'URL ; le body porte
 * la période et le %.
 */
export const AddMemberAllocationBody = z
  .object({
    start_date: IsoDate,
    end_date: IsoDate,
    allocation_pct: AllocationPct,
  })
  .refine((v) => v.end_date >= v.start_date, {
    message: 'end_date doit être ≥ start_date',
    path: ['end_date'],
  })

/**
 * v2.0 / F2 — Params combinés pour les routes d'allocation : id du projet
 * et id du collaborateur dans l'URL.
 */
export const ProjectCollabParams = z.object({
  id: NonEmptyId,
  collabId: NonEmptyId,
})

/** v2.0 / F2 — Params pour DELETE /api/allocations/:id. */
export const AllocationIdParams = z.object({ id: NonEmptyId })

/**
 * v2.1 / F2.9 — Body de PATCH /api/allocations/:id. Tous les champs sont
 * optionnels (mise à jour partielle) ; la cohérence (start ≤ end) est
 * validée si les DEUX dates sont fournies (sinon on laisse le DAL faire le
 * check final avec la valeur courante).
 */
export const UpdateMemberAllocationBody = z
  .object({
    start_date: IsoDate.optional(),
    end_date: IsoDate.optional(),
    allocation_pct: AllocationPct.optional(),
  })
  .refine(
    (v) =>
      v.start_date === undefined ||
      v.end_date === undefined ||
      v.end_date >= v.start_date,
    {
      message: 'end_date doit être ≥ start_date',
      path: ['end_date'],
    },
  )

// -----------------------------------------------------------------------------
// ABSENCES (v2.0 / F3) — congés cross-projet
// -----------------------------------------------------------------------------

/**
 * v2.0 / F3 — Fraction de jour non-travaillée. Restreinte aux 4 paliers
 * validés avec l'utilisateur (quart / demi / trois-quarts / journée).
 */
const AbsenceFraction = z
  .number({ message: 'doit être un nombre' })
  .refine((v) => v === 0.25 || v === 0.5 || v === 0.75 || v === 1, {
    message: 'doit valoir 0.25, 0.5, 0.75 ou 1',
  })

/**
 * v2.0 / F3 — Body de POST /api/collaborators/:id/absences. Le collab est
 * dans l'URL (params), le body porte la date et la fraction.
 */
export const AddAbsenceBody = z.object({
  date: IsoDate,
  fraction: AbsenceFraction,
})

/**
 * v2.0 / F3 — Params pour DELETE /api/collaborators/:id/absences/:date.
 * Le collab et la date sont dans l'URL.
 */
export const CollabAbsenceParams = z.object({
  id: NonEmptyId,
  date: IsoDate,
})

// -----------------------------------------------------------------------------
// TÂCHES & JALONS
// -----------------------------------------------------------------------------

/**
 * Pour la création, on impose start_date. end_date est optionnel : pour une
 * tâche, il vaut start_date par défaut ; pour un jalon, on l'ignore et on
 * force end_date = start_date côté DAL.
 */
/**
 * v1.21 — Une entrée de la liste `predecessors` : l'id du prédécesseur et
 * son délai (lag) en jours ouvrés (≥ 0). Le tableau complet remplace
 * atomiquement la liste de liaisons de la tâche.
 */
const PredecessorEntry = z.object({
  id: NonEmptyId,
  lag: Lag.optional(),
})

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
    // v1.21 — Liste de prédécesseurs (nouveau format). Si fournie, prend le
    // pas sur `predecessor_id` / `predecessor_lag` (alias legacy).
    predecessors: z.array(PredecessorEntry).optional(),
    // v1.2 — Tâche prédécesseur (alias mono-pred). Si renseignée, le DAL
    // force la start_date sur la end_date du prédécesseur.
    predecessor_id: NonEmptyId.nullable().optional(),
    // v1.10 — Délai en jours ouvrés entre le prédécesseur et cette tâche.
    predecessor_lag: Lag.optional(),
    // v1.18 / v1.24 — Priorité (1..5). Obligatoire sur les activités (défaut
    // 3 si non fourni, géré par le DAL) ; null pour jalons et phases.
    priority: Priority.nullable().optional(),
    // v1.24 — SNET « Ne doit pas démarrer avant le ». Date facultative
    // (null = pas de contrainte). Forcée à null pour les phases côté DAL.
    not_before_date: IsoDate.nullable().optional(),
    // v2.0 / F4 — FNLT « Fin au plus tard » : deadline souhaitée mais
    // NON BLOQUANTE. Si la date de fin calculée dépasse la FNLT, c'est
    // signalé visuellement (bandeau + barre rouge) — pas rejeté.
    // Forcée à null pour les phases côté DAL.
    not_later_than_date: IsoDate.nullable().optional(),
    // v2.0 / F6 — Multi-collab : liste d'ids de collaborateurs affectés.
    // Si fourni, prend le pas sur `collaborator_id` (legacy mono-collab).
    // Tableau vide = aucune affectation. Forcé à [] pour jalons et phases
    // côté DAL.
    collaborator_ids: z.array(NonEmptyId).optional(),
    // v2.0 — Charge en jours ouvrés (≥ 1). Source de vérité pour les activités.
    // Si fournie, prend le pas sur `end_date` (qui est dérivée). Forcée à null
    // pour les jalons et phases côté DAL.
    charge_jours: ChargeJours.optional(),
    // v1.8 — Projet de rattachement (optionnel : si absent, le DAL utilise
    // le premier projet existant).
    project_id: NonEmptyId.optional(),
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
    // v1.21 — Liste de prédécesseurs (nouveau format).
    predecessors: z.array(PredecessorEntry).optional(),
    predecessor_id: NonEmptyId.nullable().optional(), // v1.2 (alias legacy)
    predecessor_lag: Lag.optional(), // v1.10 (alias legacy)
    priority: Priority.nullable().optional(), // v1.18
    not_before_date: IsoDate.nullable().optional(), // v1.24 — SNET
    not_later_than_date: IsoDate.nullable().optional(), // v2.0 / F4 — FNLT (deadline non-bloquante)
    charge_jours: ChargeJours.optional(), // v2.0 — charge stockée (source de vérité)
    collaborator_ids: z.array(NonEmptyId).optional(), // v2.0 / F6 — multi-collab
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'au moins un champ doit être fourni',
  })

export const TaskIdParams = z.object({ id: NonEmptyId })

/**
 * v1.5 — Body de POST /api/tasks/:id/move (drag & drop dans la liste).
 * - parent_id : nouveau parent (null = racine)
 * - before_id : id du sibling avant lequel insérer (null = en fin de liste)
 */
export const MoveTaskBody = z.object({
  parent_id: NonEmptyId.nullable(),
  before_id: NonEmptyId.nullable(),
})

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
/**
 * Valide une section (params, body ou query) avec son schéma Zod.
 * En cas d'échec, accumule les erreurs dans `details`.
 * En cas de succès, applique la valeur parsée via `assign(req, parsed)` —
 * Express 5 interdit la réécriture de `req.query`, d'où le callback.
 *
 * @param {import('zod').ZodTypeAny|undefined} schema  Schéma ou undefined (no-op).
 * @param {unknown} input                              Source à valider.
 * @param {string} where                               'params' | 'body' | 'query'.
 * @param {(parsed:any)=>void} assign                  Callback en cas de succès.
 * @param {Array<{where:string,path:any,message:string}>} details  Accumulateur.
 */
function validateSection(schema, input, where, assign, details) {
  if (!schema) return
  const r = schema.safeParse(input)
  if (r.success) {
    assign(r.data)
    return
  }
  for (const issue of r.error.issues) {
    details.push({ where, path: issue.path, message: issue.message })
  }
}

export function validate(schemas) {
  return (req, res, next) => {
    const details = []
    validateSection(
      schemas.params,
      req.params,
      'params',
      (d) => (req.params = d),
      details,
    )
    validateSection(
      schemas.body,
      req.body,
      'body',
      (d) => (req.body = d),
      details,
    )
    // req.query est read-only en Express 5 — on annexe le résultat sur
    // un attribut séparé pour les routes qui en ont besoin.
    validateSection(
      schemas.query,
      req.query,
      'query',
      (d) => (req.validQuery = d),
      details,
    )
    if (details.length > 0) {
      return res.status(400).json({ error: 'Validation échouée', details })
    }
    next()
  }
}
