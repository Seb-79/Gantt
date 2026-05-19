// =============================================================================
// CAPACITÉ ALLOUÉE SERVEUR — moteur de calcul de fin pondéré
// =============================================================================
// Miroir exact de `getDailyAllocation` + `computeEndFromCharge` côté client
// (src/lib/utils.ts), mais en accès BDD direct (better-sqlite3) plutôt qu'en
// lecture de tableaux JS pré-chargés.
//
// Composants :
//   • `listAllocationsServer` / `loadAbsencesMap` — lectures BDD optimisées.
//   • `findAllocationPctForDay` / `effectiveCapacityServer` — fonctions pures
//     qui calculent la contribution quotidienne d'un collab.
//   • `addWorkingDaysWithAllocationServer` — calcule la fin d'une activité à
//     partir de sa charge en consommant la capacité jour par jour (multi-collab
//     additif uniforme, Q12a validé avec l'utilisateur).
//
// Fallback F0 : sans collab affecté ou sans allocation, on retombe sur
// `addWorkingDaysServer` (charge = N jours ouvrés contigus, fériés FR sautés).
// =============================================================================

import {
  addDaysIsoServer,
  addWorkingDaysServer,
  isNonWorkingDayIso,
} from './working-days.js'

/**
 * v2.0 / F2 — Lit toutes les allocations d'un couple (projet, collab) triées
 * par date de début, pour usage dans le moteur de calcul de fin serveur.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {string} collabId
 * @returns {Array<{start_date:string, end_date:string, allocation_pct:number}>}
 */
export function listAllocationsServer(db, projectId, collabId) {
  return db
    .prepare(
      `SELECT start_date, end_date, allocation_pct
         FROM member_allocations
         WHERE project_id = ? AND collaborator_id = ?
         ORDER BY start_date ASC, id ASC`,
    )
    .all(projectId, collabId)
}

/**
 * v2.0 / F2 — Trouve le pourcentage d'allocation couvrant `dateIso` parmi
 * une liste pré-chargée pour un collab. Hypothèse : pas de chevauchement
 * (invariant RG-GANTT-1301), on prend la 1ʳᵉ période qui couvre.
 *
 * @param {Array<{start_date:string, end_date:string, allocation_pct:number}>} allocs
 * @param {string} dateIso
 * @returns {number} 0 si aucune période ne couvre.
 */
export function findAllocationPctForDay(allocs, dateIso) {
  for (const a of allocs) {
    if (dateIso >= a.start_date && dateIso <= a.end_date)
      return a.allocation_pct
  }
  return 0
}

/**
 * v2.0 / F3 — Lit les absences d'un collab sous forme de Map date→fraction
 * pour une lecture O(1) dans la boucle de consommation jour par jour.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} collabId
 * @returns {Map<string, number>}  Map ISO date → fraction non-travaillée (0..1).
 */
export function loadAbsencesMap(db, collabId) {
  const m = new Map()
  if (!collabId) return m
  const rows = db
    .prepare(
      `SELECT date, fraction FROM collaborator_absences WHERE collaborator_id = ?`,
    )
    .all(collabId)
  for (const r of rows)
    m.set(r.date, Math.max(0, Math.min(1, Number(r.fraction))))
  return m
}

/**
 * v2.0 / F2+F3 — Capacité effective du collab pour un jour donné, dans [0,1].
 *   • Jour non-ouvré (week-end/férié)        → 0
 *   • Hors période d'allocation              → 0
 *   • Sinon : allocation_pct/100 × (1 − absence_fraction)
 *
 * @param {string} dateIso
 * @param {Array} allocs   Allocations pré-chargées (cf. listAllocationsServer).
 * @param {Map<string, number>} absences  Absences pré-chargées (cf. loadAbsencesMap).
 * @returns {number}
 */
export function effectiveCapacityServer(dateIso, allocs, absences) {
  if (isNonWorkingDayIso(dateIso)) return 0
  const pct = findAllocationPctForDay(allocs, dateIso)
  if (pct <= 0) return 0
  const absenceFraction = absences.get(dateIso) || 0
  return (pct / 100) * (1 - absenceFraction)
}

/**
 * v2.0 / F2+F3+F6 — Calcule la fin d'une activité à partir de sa charge et du
 * rythme d'allocation des collabs affectés (miroir exact de
 * `computeEndFromCharge` côté client).
 *
 * Politique multi-collab (F6, Q12a validé) : ADDITIVE UNIFORME. Chaque jour,
 * chaque collab affecté contribue `pct/100 × (1−absence)`. Capacité du jour
 * = Σ contributions. La fin est le dernier jour où la charge cumulée atteint
 * la cible.
 *
 * Fallback F0 : sans collab affecté OU sans allocation existante, retombe sur
 * `addWorkingDaysServer` (charge = N jours ouvrés contigus).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} startIso  Date de début YYYY-MM-DD.
 * @param {number} charge    Charge en jours ouvrés (≥ 1).
 * @param {string|null} projectId
 * @param {string|string[]|null} collabIdOrIds Un id unique (legacy) ou un tableau.
 * @returns {string} Date de fin YYYY-MM-DD (incluse).
 */
export function addWorkingDaysWithAllocationServer(
  db,
  startIso,
  charge,
  projectId,
  collabIdOrIds,
) {
  // v2.0 / F6 — Normalise l'entrée en tableau (rétro-compat : un string seul
  // est accepté). Tableau vide ou projet absent → fallback F0.
  let collabIds = []
  if (Array.isArray(collabIdOrIds)) collabIds = collabIdOrIds.filter(Boolean)
  else if (collabIdOrIds) collabIds = [collabIdOrIds]
  if (collabIds.length === 0 || !projectId)
    return addWorkingDaysServer(startIso, charge)
  // Charge tous les contextes : allocations par collab + absences par collab.
  // (Évite N+1 dans la boucle principale.)
  const collabContexts = []
  for (const cId of collabIds) {
    const allocs = listAllocationsServer(db, projectId, cId)
    if (allocs.length === 0) continue // collab sans allocation : ignoré
    collabContexts.push({
      cId,
      allocs,
      absences: loadAbsencesMap(db, cId),
    })
  }
  if (collabContexts.length === 0) return addWorkingDaysServer(startIso, charge)
  const needed = Math.max(1, charge)
  let consumed = 0
  let cur = startIso
  let lastWorked = startIso
  const maxScan = Math.max(needed * 30, 10000)
  for (let i = 0; i < maxScan; i++) {
    // Σ contributions de tous les collabs affectés pour le jour `cur`.
    let dayCapacity = 0
    for (const ctx of collabContexts) {
      dayCapacity += effectiveCapacityServer(cur, ctx.allocs, ctx.absences)
    }
    if (dayCapacity > 0) {
      consumed += dayCapacity
      lastWorked = cur
      if (consumed >= needed - 1e-9) return lastWorked
    }
    cur = addDaysIsoServer(cur, 1)
  }
  return lastWorked
}
