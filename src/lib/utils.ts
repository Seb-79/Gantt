// =============================================================================
// FONCTIONS UTILITAIRES — Gantt v1
// =============================================================================
// Toutes les fonctions ici sont **pures** (pas d'effet de bord, dépendent
// uniquement de leurs paramètres) et donc 100 % testables avec Vitest.
// =============================================================================

import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  format,
  getISOWeek,
  isWeekend,
  parseISO,
  startOfDay,
  startOfWeek,
  startOfMonth,
} from 'date-fns'
// v2.0 / Refacto (b) — Helpers ISO partagés avec le serveur. Source de vérité
// unique pour les fériés FR, l'arithmétique de date et les jours ouvrés.
import {
  addDaysIso as sharedAddDaysIso,
  addWorkingDaysIso,
  computeSuccessorStartIso,
  isFrenchHolidayIso,
  isNonWorkingDayIso,
  snapBackwardToWorkingDayIso,
  snapForwardToWorkingDayIso,
  workingDaysBetweenIso,
} from '../../shared/working-days.js'
import type { Collaborator, Task } from './types'

/** Couleur de barre par défaut quand ni la tâche ni son collab n'en ont. */
export const DEFAULT_TASK_COLOR = '#64748b' // slate-500

/** Largeur d'un jour en pixels — bornes du zoom. */
export const MIN_DAY_WIDTH = 6
export const MAX_DAY_WIDTH = 60
export const DEFAULT_DAY_WIDTH = 14

/**
 * Convertit une date ISO 'YYYY-MM-DD' en objet Date local (minuit).
 *
 * @param iso  Date au format YYYY-MM-DD.
 * @returns    Objet Date à minuit local.
 */
export function isoToDate(iso: string): Date {
  return startOfDay(parseISO(iso))
}

/**
 * Formate une Date en chaîne ISO 'YYYY-MM-DD'.
 *
 * @param d  Objet Date.
 * @returns  Chaîne au format YYYY-MM-DD.
 */
export function dateToIso(d: Date): string {
  return format(d, 'yyyy-MM-dd')
}

/**
 * Construit la liste de toutes les dates entre deux bornes (incluses).
 *
 * @param startIso  Date de début YYYY-MM-DD.
 * @param endIso    Date de fin YYYY-MM-DD.
 * @returns         Tableau de Date (1 entrée par jour).
 */
export function buildDateRange(startIso: string, endIso: string): Date[] {
  const start = isoToDate(startIso)
  const end = isoToDate(endIso)
  const n = differenceInCalendarDays(end, start) + 1
  const out: Date[] = []
  for (let i = 0; i < n; i++) out.push(addDays(start, i))
  return out
}

/**
 * Calcule la fenêtre temporelle par défaut à afficher : N mois à partir
 * d'une date de référence (par défaut aujourd'hui), alignée sur le 1er du mois.
 *
 * @param refIso     Date de référence YYYY-MM-DD (défaut : aujourd'hui).
 * @param months     Nombre de mois à afficher (défaut : 4).
 * @returns          { startIso, endIso } bornes du calendrier (incluses).
 */
export function defaultWindow(
  refIso: string = dateToIso(new Date()),
  months: number = 4,
): { startIso: string; endIso: string } {
  const start = startOfMonth(isoToDate(refIso))
  // Dernier jour du dernier mois inclus = veille du 1er du mois suivant
  const end = addDays(addMonths(start, months), -1)
  return { startIso: dateToIso(start), endIso: dateToIso(end) }
}

/**
 * Position en pixels (depuis le bord gauche du calendrier) d'une date donnée.
 *
 * @param dateIso       Date à positionner (YYYY-MM-DD).
 * @param windowStart   Début du calendrier (YYYY-MM-DD).
 * @param dayWidth      Largeur d'un jour en pixels.
 * @returns             Offset gauche en pixels.
 */
export function dateToX(
  dateIso: string,
  windowStart: string,
  dayWidth: number,
): number {
  return (
    differenceInCalendarDays(isoToDate(dateIso), isoToDate(windowStart)) *
    dayWidth
  )
}

/**
 * Largeur en pixels d'une barre couvrant [startIso, endIso] inclusifs.
 * Une tâche d'1 jour fait `dayWidth` px de large (pas 0).
 *
 * @param startIso   Date de début YYYY-MM-DD.
 * @param endIso     Date de fin YYYY-MM-DD (incluse).
 * @param dayWidth   Largeur d'un jour en pixels.
 * @returns          Largeur de la barre en pixels.
 */
export function rangeToWidth(
  startIso: string,
  endIso: string,
  dayWidth: number,
): number {
  const days =
    differenceInCalendarDays(isoToDate(endIso), isoToDate(startIso)) + 1
  return Math.max(days, 1) * dayWidth
}

/**
 * Borne une largeur de jour entre MIN_DAY_WIDTH et MAX_DAY_WIDTH.
 *
 * @param value   Valeur souhaitée.
 * @returns       Valeur clampée.
 */
export function clampDayWidth(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_DAY_WIDTH
  return Math.max(MIN_DAY_WIDTH, Math.min(MAX_DAY_WIDTH, value))
}

/**
 * Couleur effective d'une tâche : couleur custom > couleur du collab > défaut.
 *
 * v1.24 — Règle J3 : un jalon (et une phase) n'a pas de collaborateur. On
 * ignore donc toute valeur résiduelle de `collaborator_id` qui aurait pu
 * traîner pour ne pas surprendre l'utilisateur avec une couleur héritée
 * d'un collab fantôme. Seule la couleur custom (si présente) est respectée.
 *
 * @param task           La tâche.
 * @param collaborators  Liste des collaborateurs disponibles.
 * @returns              Couleur hex à utiliser pour la barre.
 */
export function effectiveTaskColor(
  task: Task,
  collaborators: Collaborator[],
): string {
  if (task.color) return task.color
  if (task.kind === 'task' && task.collaborator_id) {
    const c = collaborators.find((x) => x.id === task.collaborator_id)
    if (c) return c.color
  }
  return DEFAULT_TASK_COLOR
}

/**
 * Génère un identifiant court et lisible (préfixe + base36 du timestamp).
 * Suffisant pour un usage local mono-utilisateur ; pas un UUID v4.
 *
 * @param prefix  Préfixe à ajouter (ex. 't' pour task, 'c' pour collab).
 * @returns       Identifiant unique.
 */
export function makeId(prefix: string): string {
  // sonarjs/pseudo-random désactivé : `makeId` ne génère pas un secret
  // cryptographique. C'est un id local lisible (préfixe + timestamp + random
  // base36) — suffisant pour un usage mono-utilisateur LAN, et déjà signalé
  // dans la JSDoc ci-dessus.
  // eslint-disable-next-line sonarjs/pseudo-random
  const rnd = Math.floor(Math.random() * 1e6).toString(36)
  return `${prefix}_${Date.now().toString(36)}_${rnd}`
}

/**
 * Indique si une date est un week-end (samedi ou dimanche).
 * Réexport simple pour découpler les imports.
 *
 * @param d  Objet Date.
 * @returns  true si samedi ou dimanche.
 */
export function isWeekendDay(d: Date): boolean {
  return isWeekend(d)
}

// -----------------------------------------------------------------------------
// JOURS FÉRIÉS FRANÇAIS (v1.23)
// -----------------------------------------------------------------------------
// Liste calculée à la demande, mise en cache par année. Couvre :
//   • Les 8 jours fériés FIXES : 01/01, 01/05, 08/05, 14/07, 15/08, 01/11,
//     11/11, 25/12.
//   • Les 3 jours fériés MOBILES dérivés de Pâques (calcul Anonymous
//     Gregorian / Meeus-Jones-Butcher) :
//       - Lundi de Pâques     = Pâques + 1
//       - Jeudi de l'Ascension = Pâques + 39
//       - Lundi de Pentecôte  = Pâques + 50
//
// La fonction `isFrenchHoliday` accepte une `Date` (cohérent avec
// `isWeekendDay`). `isNonWorkingDay = isWeekendDay || isFrenchHoliday` est le
// prédicat utilisé partout pour les calculs de jours ouvrés.
//
// Côté serveur, le même algorithme est dupliqué dans `db/index.js` pour
// rester self-contained sans dépendance partagée.
// -----------------------------------------------------------------------------

/**
 * v1.23 — Indique si une date tombe un jour férié du calendrier français
 * (national, hors Alsace-Moselle). Couvre toutes les années (algorithmique,
 * pas une liste figée à 2026).
 *
 * v2.0 / Refacto (b) — Délègue à `isFrenchHolidayIso` (module shared/) pour
 * une source de vérité unique avec le serveur.
 *
 * @param d  Objet Date.
 * @returns  true si la date est un jour férié français.
 */
export function isFrenchHoliday(d: Date): boolean {
  return isFrenchHolidayIso(dateToIso(d))
}

/**
 * v1.23 — Prédicat unifié « jour non ouvré » = week-end OU jour férié français.
 * Utilisé par toutes les fonctions d'arithmétique en jours ouvrés
 * (`addWorkingDays`, `workingDaysBetween`, `snapForwardToWorkingDay`,
 * `snapBackwardToWorkingDay`, `computeWorkload`).
 *
 * v2.0 / Refacto (b) — Délègue à `isNonWorkingDayIso` (module shared/).
 *
 * @param d  Objet Date.
 * @returns  true si jour non ouvré.
 */
export function isNonWorkingDay(d: Date): boolean {
  return isNonWorkingDayIso(dateToIso(d))
}

/**
 * v1.9 — Ajoute `charge` jours OUVRÉS à partir de startIso et renvoie la
 * date de fin (incluse). Saute week-ends ET jours fériés français.
 *
 * Exemples (start = lundi 18 mai 2026) :
 *   • charge=1 → 18 mai (un seul jour ouvré : le lundi)
 *   • charge=3 → 20 mai (lundi, mardi, mercredi)
 *   • charge=5 → 22 mai (lundi → vendredi)
 *   • charge=6 → 25 mai (lun→ven puis sauté sam/dim, lundi suivant)
 *
 * v2.0 / Refacto (b) — Délègue à `addWorkingDaysIso` (module shared/).
 *
 * @param startIso  Date de début YYYY-MM-DD.
 * @param charge    Nombre de jours ouvrés (≥ 1 ; toute valeur ≤ 1 vaut 1).
 * @returns         Date de fin YYYY-MM-DD (incluse).
 */
export function addWorkingDays(startIso: string, charge: number): string {
  return addWorkingDaysIso(startIso, charge)
}

/**
 * v2.0 / F2 — Structure d'une période d'allocation côté client (miroir
 * exact de la ligne SQL `member_allocations`). Le moteur de calcul de fin
 * et le plan de charge la consomment pour pondérer la capacité quotidienne.
 */
export interface MemberAllocation {
  id: string
  project_id: string
  collaborator_id: string
  start_date: string
  end_date: string
  allocation_pct: number
}

/**
 * v2.0 / F3 — Absence (congé) d'un collaborateur sur une journée donnée.
 * Cross-projet : la même absence diminue la capacité du collab sur tous
 * ses projets simultanément (lecture multiplicative Q8b).
 *   • `fraction = 0.25` → un quart de journée non travaillé
 *   • `fraction = 0.5`  → demi-journée
 *   • `fraction = 0.75` → trois-quarts
 *   • `fraction = 1`    → journée complète (= jour férié personnel)
 */
export interface CollaboratorAbsence {
  collaborator_id: string
  date: string
  fraction: number
}

/**
 * v2.0 / F6 — Helper unifié : extrait la liste des ids de collaborateurs
 * affectés à une tâche, en priorisant le tableau `collaborators[]` (source
 * de vérité F6) et en retombant sur l'alias legacy `collaborator_id` quand
 * il n'est pas présent (tâches d'avant F6 ou tests).
 *
 * Factorisé pour éviter la duplication du ternaire imbriqué dans `replanTasks`,
 * `computeWorkload`, `prefillLockedIntervals`, etc. (sonarjs/no-nested-conditional).
 *
 * @param t  Tâche à inspecter (Task ou objet partiel avec `collaborators?` /
 *           `collaborator_id?`).
 * @returns  Ids des collabs affectés (tableau jamais null, peut être vide).
 */
export function taskCollabIds(t: {
  collaborators?: { id: string }[]
  collaborator_id?: string | null
}): string[] {
  if (t.collaborators && t.collaborators.length > 0) {
    return t.collaborators.map((c) => c.id)
  }
  if (t.collaborator_id) return [t.collaborator_id]
  return []
}

/**
 * v2.0 / F2 — Capacité quotidienne d'un collaborateur sur un projet à une
 * date donnée, sous forme de fraction (0..1).
 *
 *   • Jour non ouvré (week-end OU férié FR) → 0 (jamais de travail).
 *   • Aucune allocation couvrant la date → 0 (le collab n'est pas dispo).
 *   • Sinon → `allocation_pct / 100` de la période en vigueur.
 *
 * Hypothèse : aucune période ne se chevauche pour un même (projet, collab)
 * — invariant garanti par le DAL (RG-GANTT-1301). En cas anormal de
 * chevauchement, on prend la 1ʳᵉ période qui couvre la date.
 *
 * @param dateIso    Date à évaluer (YYYY-MM-DD).
 * @param allocations Liste des allocations du projet (toutes paires confondues).
 * @param projectId  Projet de la tâche.
 * @param collabId   Collaborateur affecté.
 * @returns          Fraction de capacité dans [0, 1].
 */
export function getDailyAllocation(
  dateIso: string,
  allocations: MemberAllocation[],
  projectId: string,
  collabId: string,
  absences: CollaboratorAbsence[] = [],
): number {
  const d = isoToDate(dateIso)
  if (isNonWorkingDay(d)) return 0
  // v2.0 / F2 — Trouve l'allocation en vigueur ce jour-là (max 1 par invariant
  // RG-GANTT-1301). Hors période → 0 % de capacité.
  let pct = 0
  for (const a of allocations) {
    if (a.project_id !== projectId) continue
    if (a.collaborator_id !== collabId) continue
    if (dateIso >= a.start_date && dateIso <= a.end_date) {
      pct = a.allocation_pct / 100
      break
    }
  }
  if (pct === 0) return 0
  // v2.0 / F3 — Pondération multiplicative par l'absence du jour (Q8b) :
  // capacité = pct × (1 − fraction). 1 absence par (collab, date) max
  // (PRIMARY KEY composite). Cas concrets :
  //   • Paul 50 % + congé 0,5 j → 0,5 × (1 − 0,5) = 0,25 (25 % effectif)
  //   • Paul 100 % + congé 1 j  → 1 × (1 − 1)    = 0 (jour complet en congé)
  //   • Paul 100 % + congé 0,25 → 1 × (1 − 0,25) = 0,75
  for (const ab of absences) {
    if (ab.collaborator_id !== collabId) continue
    if (ab.date !== dateIso) continue
    const f = Math.max(0, Math.min(1, ab.fraction))
    return pct * (1 - f)
  }
  return pct
}

/**
 * v2.0 / F0 puis F2 — Calcule la date de fin d'une activité à partir de sa
 * date de début et de sa charge en jours ouvrés.
 *
 * Politique v2.0 :
 *   • Sans contexte d'allocation (pas de `ctx` fourni OU pas de collab affecté
 *     OU pas d'allocations) → comportement F0 : `addWorkingDays` simple
 *     (chaque jour ouvré contribue 1 jour de charge, fériés sautés).
 *   • Avec contexte d'allocation → itération jour par jour : on consomme
 *     `getDailyAllocation(date)` de la charge à chaque jour calendaire jusqu'à
 *     atteindre la charge cible. La fin est le DERNIER jour où une fraction
 *     a été consommée (cohérent avec l'invariant « fin = dernier jour de
 *     travail »).
 *
 * Garde-fou : on borne le scan à `max(charge * 30, 10000)` jours pour ne
 * jamais boucler en cas d'allocations toutes à 0 % (la fonction renvoie alors
 * la date du dernier jour scanné — l'UI affichera une alerte de cohérence).
 *
 * @param startIso  Date de début YYYY-MM-DD.
 * @param charge    Charge en jours ouvrés (≥ 1).
 * @param ctx       Optionnel : { projectId, collaboratorId, allocations }.
 * @returns         Date de fin YYYY-MM-DD (incluse).
 */
export function computeEndFromCharge(
  startIso: string,
  charge: number,
  ctx?: {
    projectId: string | null
    /** v2.0 / F6 — Soit un id unique (mono-collab, rétro-compat), soit un
     *  tableau d'ids (multi-collab). Sémantique multi-collab : ADDITIVE
     *  uniforme — chaque jour, chaque collab affecté contribue son pct ×
     *  (1−absence). Capacité du jour = Σ contributions. */
    collaboratorId: string | null
    collaboratorIds?: string[]
    allocations: MemberAllocation[]
    /** v2.0 / F3 — Absences cross-projet du collab (toutes celles connues
     *  côté state suffisent : `getDailyAllocation` filtre par collab+date). */
    absences?: CollaboratorAbsence[]
  },
): string {
  // v2.0 / F6 — Construit la liste finale des collabs à consommer : priorité
  // au tableau, fallback sur l'id unique (rétro-compat F2-F5).
  let collabList: string[] = []
  if (ctx?.collaboratorIds?.length) {
    collabList = ctx.collaboratorIds
  } else if (ctx?.collaboratorId) {
    collabList = [ctx.collaboratorId]
  }
  // F0 path : sans allocations explicites OU sans collab, on reste sur la
  // sémantique « charge = N jours ouvrés contigus » (rétrocompat tests v1.x).
  if (
    !ctx ||
    !ctx.projectId ||
    collabList.length === 0 ||
    !ctx.allocations ||
    ctx.allocations.length === 0
  ) {
    return addWorkingDays(startIso, charge)
  }
  // F2/F3/F6 path : itération jour calendaire par jour calendaire,
  // consommation pondérée par allocation × (1 − absence), SOMMÉE sur tous
  // les collabs affectés (additif uniforme, Q12a validé).
  const absences = ctx.absences || []
  const needed = Math.max(1, charge)
  let consumed = 0
  let cur = startIso
  let lastWorked = startIso
  // Garde-fou : 10 000 jours = ~27 ans, largement suffisant.
  const maxScan = Math.max(needed * 30, 10000)
  for (let i = 0; i < maxScan; i++) {
    // Σ contributions de tous les collabs affectés pour le jour `cur`.
    let a = 0
    for (const cId of collabList) {
      a += getDailyAllocation(
        cur,
        ctx.allocations,
        ctx.projectId,
        cId,
        absences,
      )
    }
    if (a > 0) {
      consumed += a
      lastWorked = cur
      // Atteint la cible : on s'arrête sur le dernier jour qui a contribué.
      // Tolérance numérique (cumul de fractions 0.25/0.5/0.75/1.0).
      if (consumed >= needed - 1e-9) return lastWorked
    }
    cur = addDaysIso(cur, 1)
  }
  // Boucle de sécurité atteinte sans avoir consommé la charge complète :
  // on renvoie le dernier jour effectivement travaillé (ou start si aucun).
  return lastWorked
}

/**
 * v2.1 / F2.9 — Résultat du check d'absorption de charge par les allocations.
 *
 *   • `absorbed`        : nombre de jours-ouvrés-équivalents que les allocations
 *                          existantes peuvent absorber pour cette tâche
 *                          (somme additive des contributions de tous les
 *                          collaborateurs affectés, jour par jour, week-ends/
 *                          fériés sautés). Dans [0, charge].
 *   • `missing`         : charge − absorbed. > 0 ⇒ blocage à la sauvegarde.
 *   • `lastCoveredDay`  : dernier jour (entre startDate et horizon) ayant une
 *                          capacité > 0. `null` si jamais aucune capacité.
 *   • `horizon`         : max(allocation.end_date) pour les allocations
 *                          (projet, collab) pertinentes. `null` si aucune
 *                          allocation pertinente.
 */
export interface AllocationShortfall {
  absorbed: number
  missing: number
  lastCoveredDay: string | null
  horizon: string | null
}

/**
 * v2.1 / F2.9 — Vérifie si la charge d'une activité peut être absorbée par
 * les allocations courantes de ses collaborateurs sur le projet courant.
 *
 * Pure (testable). Pas d'IO. Mêmes hypothèses que `computeEndFromCharge` :
 * la capacité d'un jour est `Σ_collab (pct_collab × (1 − absence_collab))`,
 * sauf week-ends/fériés où elle vaut 0.
 *
 * Algorithme :
 *   1. Filtre les allocations (project_id, collaborator_id) pertinentes.
 *   2. Si rien → la charge entière manque, horizon = null.
 *   3. Sinon scanne jour par jour de `startDate` à `horizon = max(end_date)`,
 *      accumule la capacité jusqu'à atteindre la charge cible.
 *   4. Si scrap atteint avant horizon → `missing = 0`. Sinon, ce qui reste.
 *
 * Note : si `startDate > horizon`, on ne scanne rien et `absorbed = 0`. C'est
 * exactement le cas « Tournage extérieur commence après la fin de l'allocation
 * Camille » qui retournait 1 jour à tort avant ce check.
 *
 * @param args.startDate         Date de début de la tâche (YYYY-MM-DD).
 * @param args.charge            Charge en jours ouvrés (≥ 1).
 * @param args.collaboratorIds   Ids des collabs affectés.
 * @param args.projectId         Projet de la tâche.
 * @param args.allocations       Allocations connues (toutes paires confondues).
 * @param args.absences          Absences cross-projet (optionnel, défaut []).
 * @returns                      Bilan d'absorption (cf. `AllocationShortfall`).
 */
export function computeAllocationShortfall(args: {
  startDate: string
  charge: number
  collaboratorIds: string[]
  projectId: string
  allocations: MemberAllocation[]
  absences?: CollaboratorAbsence[]
}): AllocationShortfall {
  const { startDate, charge, collaboratorIds, projectId, allocations } = args
  const absences = args.absences || []
  // Charge ≤ 0 (cas dégénéré) → rien à absorber, OK.
  if (charge <= 0) {
    return { absorbed: 0, missing: 0, lastCoveredDay: null, horizon: null }
  }
  // Aucun collab affecté → aucune capacité possible.
  if (collaboratorIds.length === 0) {
    return {
      absorbed: 0,
      missing: charge,
      lastCoveredDay: null,
      horizon: null,
    }
  }
  // Filtre des allocations (projet courant, collabs affectés).
  const relevant = allocations.filter(
    (a) =>
      a.project_id === projectId && collaboratorIds.includes(a.collaborator_id),
  )
  if (relevant.length === 0) {
    return {
      absorbed: 0,
      missing: charge,
      lastCoveredDay: null,
      horizon: null,
    }
  }
  // Horizon = dernier jour couvert par AU MOINS une allocation pertinente.
  let horizon = relevant[0].end_date
  for (const a of relevant) if (a.end_date > horizon) horizon = a.end_date
  // Scan jour calendaire par jour calendaire jusqu'à horizon (inclus).
  let cur = startDate
  let absorbed = 0
  let lastCoveredDay: string | null = null
  while (cur <= horizon) {
    let cap = 0
    for (const cId of collaboratorIds) {
      cap += getDailyAllocation(cur, allocations, projectId, cId, absences)
    }
    if (cap > 0) {
      absorbed += cap
      lastCoveredDay = cur
      // Tolérance numérique (cumul de fractions 0.25/0.5/0.75/1).
      if (absorbed >= charge - 1e-9) {
        return {
          absorbed: charge,
          missing: 0,
          lastCoveredDay,
          horizon,
        }
      }
    }
    cur = addDaysIso(cur, 1)
  }
  return {
    absorbed,
    missing: Math.max(0, charge - absorbed),
    lastCoveredDay,
    horizon,
  }
}

/**
 * v2.1 / F2.9 — Opération atomique à exécuter pour étendre la couverture
 * d'allocation d'un collaborateur sur un projet :
 *
 *   • `kind = 'patch'` : prolonger une allocation existante en mettant à jour
 *                        sa `end_date`. Garde l'allocation_pct et le start_date.
 *                        Q5=C : utilisé quand le pct cible == pct actuel.
 *   • `kind = 'create'` : créer une nouvelle allocation `[start..end]` au pct
 *                        cible. Q5=C : utilisé quand on change de pct OU quand
 *                        le collab n'a aucune allocation antérieure pertinente.
 */
export interface ExtensionOperation {
  collaboratorId: string
  kind: 'patch' | 'create'
  /** Allocation à patcher (kind='patch') ; ignoré pour 'create'. */
  allocationId?: string
  /** Date de début pour 'create' (lendemain de la dernière allocation, ou
   *  start de la tâche si aucune). Ignoré pour 'patch' (on garde l'existant). */
  startDate?: string
  /** Date de fin cible (cible commune calculée par `computeExtensionPlan`). */
  endDate: string
  /** Taux d'allocation appliqué (25/50/75/100). */
  pct: number
}

/**
 * v2.1 / F2.9 — Plan d'extension complet calculé pour résoudre un shortfall :
 *
 *   • `operations`     : les ops à exécuter en série (1 par collab à étendre).
 *   • `targetEndDate`  : la date jusqu'à laquelle on étend (commune à tous).
 *   • `feasible`       : true si la simulation a réussi à absorber `missing`
 *                        dans un horizon raisonnable. False = la date proposée
 *                        existe mais le user devra peut-être ajuster (cas
 *                        absences denses, etc.).
 */
export interface ExtensionPlan {
  operations: ExtensionOperation[]
  targetEndDate: string
  pct: number
  feasible: boolean
}

/**
 * v2.1 / F2.9 — Calcule un plan d'extension pour résoudre `missing` jours de
 * charge non absorbés, en étendant l'allocation des `collaboratorIds` au taux
 * `pct`. La date cible est la 1ʳᵉ date où, en simulant les allocations
 * étendues, la charge manquante est absorbée.
 *
 * Stratégie de simulation :
 *   1. Pour chaque collab, on identifie sa dernière allocation existante sur
 *      le projet (= celle au `end_date` max).
 *   2. On scanne jour ouvré par jour ouvré depuis `startScan`, en simulant
 *      qu'au-delà du `end_date` de la dernière alloc, le collab contribue
 *      `pct/100 × (1 − absence)` (= comme s'il était étendu).
 *   3. Tant que la charge manquante n'est pas absorbée, on continue. Quand
 *      atteinte → la date du dernier jour scanné devient `targetEndDate`.
 *
 * Stratégie d'opérations (Q5=C) :
 *   • Pour chaque collab à étendre, si sa dernière allocation a déjà le
 *     `pct` cible → on PATCH son `end_date` à `targetEndDate` (fusion).
 *   • Sinon → on CREATE une nouvelle allocation `[lendemain_de_l_existante,
 *     targetEndDate]` au `pct` cible.
 *   • Si aucune allocation existante → CREATE depuis `startDate` (ou la 1ʳᵉ
 *     date utile) jusqu'à `targetEndDate`.
 *
 * Pour la v1 : on étend TOUS les collabs affectés (pas seulement le « limitant »).
 * Le user peut ajuster manuellement après si nécessaire (onglet Affectation).
 *
 * Garde-fou : scan limité à 5 ans (1825 jours) pour éviter une boucle infinie
 * si pct = 0 par erreur (`feasible = false` retournée dans ce cas).
 *
 * @param args.startDate         Date de début de la tâche.
 * @param args.missing           Jours de charge non absorbés à combler.
 * @param args.collaboratorIds   Collabs affectés à la tâche.
 * @param args.projectId         Projet courant.
 * @param args.allocations       Allocations existantes (toutes paires).
 * @param args.absences          Absences cross-projet.
 * @param args.pct               Taux d'extension cible (25/50/75/100).
 * @returns                      Plan d'extension exécutable.
 */
export function computeExtensionPlan(args: {
  startDate: string
  missing: number
  collaboratorIds: string[]
  projectId: string
  allocations: MemberAllocation[]
  absences?: CollaboratorAbsence[]
  pct: number
}): ExtensionPlan {
  const { startDate, missing, collaboratorIds, projectId, allocations, pct } =
    args
  const absences = args.absences || []
  const lastByCollab = lastAllocationByCollab(
    collaboratorIds,
    allocations,
    projectId,
  )
  const startScan = pickStartScan(startDate, lastByCollab)
  const { targetEndDate, feasible } = simulateExtensionDate({
    startScan,
    missing,
    collaboratorIds,
    absences,
    pct,
  })
  const operations = buildExtensionOperations({
    collaboratorIds,
    lastByCollab,
    pct,
    targetEndDate,
    startDate,
  })
  return { operations, targetEndDate, pct, feasible }
}

/**
 * v2.1 / F2.9 — Pour chaque collab, retourne sa dernière allocation existante
 * sur le projet (celle au `end_date` max), ou null si aucune.
 */
function lastAllocationByCollab(
  collaboratorIds: string[],
  allocations: MemberAllocation[],
  projectId: string,
): Map<string, MemberAllocation | null> {
  const m = new Map<string, MemberAllocation | null>()
  for (const cId of collaboratorIds) {
    let last: MemberAllocation | null = null
    for (const a of allocations) {
      if (a.project_id !== projectId) continue
      if (a.collaborator_id !== cId) continue
      if (!last || a.end_date > last.end_date) last = a
    }
    m.set(cId, last)
  }
  return m
}

/**
 * v2.1 / F2.9 — Date à partir de laquelle scanner la simulation d'extension :
 * la plus tardive entre `startDate` (début de tâche) et le lendemain de la
 * dernière allocation existante (pour ne pas double-compter la capacité déjà
 * comptée par `computeAllocationShortfall`).
 */
function pickStartScan(
  startDate: string,
  lastByCollab: Map<string, MemberAllocation | null>,
): string {
  let startScan = startDate
  for (const last of lastByCollab.values()) {
    if (last && addDaysIso(last.end_date, 1) > startScan) {
      startScan = addDaysIso(last.end_date, 1)
    }
  }
  return startScan
}

/**
 * v2.1 / F2.9 — Trouve la fraction d'absence d'un collab pour une date donnée.
 * Retourne 0 si aucune absence connue (vue cross-projet — `absences` peut
 * contenir des entrées de plusieurs projets, filtrage par collab+date suffit).
 */
function absenceFractionFor(
  collabId: string,
  dateIso: string,
  absences: CollaboratorAbsence[],
): number {
  for (const a of absences) {
    if (a.collaborator_id === collabId && a.date === dateIso) return a.fraction
  }
  return 0
}

/**
 * v2.1 / F2.9 — Simule l'absorption jour par jour de `missing` jours de charge
 * en supposant que TOUS les `collaboratorIds` contribuent `pct/100 × (1 − absence)`
 * à partir de `startScan`. Retourne la date du dernier jour scanné et un
 * booléen `feasible` (false si la simulation n'a pas convergé ou pct=0).
 *
 * Garde-fou : 1825 jours = 5 ans.
 */
function simulateExtensionDate(args: {
  startScan: string
  missing: number
  collaboratorIds: string[]
  absences: CollaboratorAbsence[]
  pct: number
}): { targetEndDate: string; feasible: boolean } {
  const { startScan, missing, collaboratorIds, absences, pct } = args
  const fraction = Math.max(0, pct) / 100
  // Cas dégénérés : pas d'extension nécessaire OU taux nul.
  if (missing <= 0) return { targetEndDate: startScan, feasible: true }
  if (fraction === 0) return { targetEndDate: startScan, feasible: false }
  let cur = startScan
  let absorbed = 0
  let targetEndDate = startScan
  const MAX_SCAN = 1825
  for (let i = 0; i < MAX_SCAN; i++) {
    if (!isNonWorkingDay(isoToDate(cur))) {
      let cap = 0
      for (const cId of collaboratorIds) {
        cap += fraction * (1 - absenceFractionFor(cId, cur, absences))
      }
      absorbed += cap
      targetEndDate = cur
      if (absorbed >= missing - 1e-9) {
        return { targetEndDate, feasible: true }
      }
    }
    cur = addDaysIso(cur, 1)
  }
  return { targetEndDate, feasible: false }
}

/**
 * v2.1 / F2.9 — Construit la liste d'opérations à exécuter. Q5=C :
 *   • PATCH si une allocation existe ET son pct == cible (fusion par
 *     prolongation de `end_date`) ;
 *   • CREATE sinon (nouvelle allocation au lendemain de l'existante OU dès
 *     `startDate` si aucune allocation antérieure).
 */
function buildExtensionOperations(args: {
  collaboratorIds: string[]
  lastByCollab: Map<string, MemberAllocation | null>
  pct: number
  targetEndDate: string
  startDate: string
}): ExtensionOperation[] {
  const { collaboratorIds, lastByCollab, pct, targetEndDate, startDate } = args
  const operations: ExtensionOperation[] = []
  for (const cId of collaboratorIds) {
    const last = lastByCollab.get(cId) ?? null
    if (last && last.allocation_pct === pct) {
      operations.push({
        collaboratorId: cId,
        kind: 'patch',
        allocationId: last.id,
        endDate: targetEndDate,
        pct,
      })
    } else {
      const start = last ? addDaysIso(last.end_date, 1) : startDate
      operations.push({
        collaboratorId: cId,
        kind: 'create',
        startDate: start,
        endDate: targetEndDate,
        pct,
      })
    }
  }
  return operations
}

/**
 * v2.1 / F4 — Plan de réécriture des allocations d'un (projet, collab) après
 * édition jour-par-jour dans la grille « Affectation ».
 *
 *   • `toDelete` : ids des allocations existantes à supprimer (toutes celles
 *                   du couple project+collab — on rebuild from scratch).
 *   • `toCreate` : périodes contiguës compactées à insérer (mêmes invariants
 *                   que `addMemberAllocation` côté DAL : pas de chevauchement,
 *                   start ≤ end, pct ∈ {25,50,75,100}).
 */
export interface AllocationRebuildPlan {
  toDelete: string[]
  toCreate: { start_date: string; end_date: string; allocation_pct: number }[]
}

/**
 * v2.1 / F4 — Reconstruit les allocations d'un couple (project, collab)
 * après application d'une série de modifications jour-par-jour (issues du
 * clic ou drag-paint dans la grille).
 *
 * Stratégie "rebuild from scratch" :
 *   1. Indexe les pct effectifs jour par jour à partir des allocations
 *      existantes (limité à l'enveloppe [min(start), max(end)] pour la
 *      perf — on ne déplie pas 80 ans calendaires).
 *   2. Applique les `changes` (overwrite — un pct = 0 = jour libre).
 *   3. Compacte en runs contigus de même pct (jours calendaires, pas
 *      seulement ouvrés — l'invariant DAL exige des périodes continues).
 *   4. Retourne `{toDelete: tous les anciens ids, toCreate: runs}`.
 *
 * Note d'optimisation : pour un cas où aucun jour ne change réellement
 * (clic accidentel sans modification), `toCreate` retombe sur les mêmes
 * périodes que `toDelete` → l'appelant peut détecter et no-op. Mais c'est
 * facultatif : le DAL peut absorber un DELETE+POST identique.
 *
 * @param args.projectId       Projet courant.
 * @param args.collaboratorId  Collaborateur ciblé.
 * @param args.existing        Toutes les allocations connues (toutes paires).
 * @param args.changes         Map<dateIso, pct> à appliquer (pct=0 → vide).
 * @returns                    Plan de réécriture (DELETE + CREATE).
 */
export function rebuildAllocationsForCollab(args: {
  projectId: string
  collaboratorId: string
  existing: MemberAllocation[]
  changes: Map<string, number>
}): AllocationRebuildPlan {
  const { projectId, collaboratorId, existing, changes } = args
  const own = existing.filter(
    (a) => a.project_id === projectId && a.collaborator_id === collaboratorId,
  )
  const dayPct = indexAllocationsByDay(own, changes)
  const runs = compactDayPctRuns(dayPct)
  return {
    toDelete: own.map((a) => a.id),
    toCreate: runs,
  }
}

/**
 * v2.1 / F4 — Indexe les allocations en `Map<dateIso, pct>` puis applique les
 * changements (pct=0 → supprime). Extrait pour réduire la complexité de
 * `rebuildAllocationsForCollab` (sonarjs/cognitive-complexity ≤ 15).
 */
function indexAllocationsByDay(
  own: MemberAllocation[],
  changes: Map<string, number>,
): Map<string, number> {
  const dayPct = new Map<string, number>()
  for (const a of own) {
    let cur = a.start_date
    while (cur <= a.end_date) {
      dayPct.set(cur, a.allocation_pct)
      cur = addDaysIso(cur, 1)
    }
  }
  for (const [date, pct] of changes) {
    if (pct <= 0) dayPct.delete(date)
    else dayPct.set(date, pct)
  }
  return dayPct
}

/**
 * v2.1 / F4 — Compacte une `Map<dateIso, pct>` en runs contigus de même pct
 * (jours calendaires). Sortie triée par date croissante.
 */
function compactDayPctRuns(
  dayPct: Map<string, number>,
): { start_date: string; end_date: string; allocation_pct: number }[] {
  const dates = Array.from(dayPct.keys()).sort()
  const runs: {
    start_date: string
    end_date: string
    allocation_pct: number
  }[] = []
  let cur: {
    start_date: string
    end_date: string
    allocation_pct: number
  } | null = null
  for (const d of dates) {
    const pct = dayPct.get(d)!
    if (
      cur &&
      cur.allocation_pct === pct &&
      addDaysIso(cur.end_date, 1) === d
    ) {
      cur.end_date = d
    } else {
      if (cur) runs.push(cur)
      cur = { start_date: d, end_date: d, allocation_pct: pct }
    }
  }
  if (cur) runs.push(cur)
  return runs
}

/**
 * v2.1 / F2.9.C — Scanne la liste des tâches d'un projet et retourne pour
 * chaque activité (kind='task') ayant des collaborateurs affectés et une
 * charge non nulle, son `AllocationShortfall` calculé. Les entrées avec
 * `missing = 0` sont FILTRÉES : la liste retournée ne contient que les
 * tâches problématiques à présenter au user (cf. `ReplanAllocationFixDialog`).
 *
 * Fonction pure (testable). Utilisée par `handleOpenReplan` dans `App.tsx`
 * avant de lancer le calcul de déplacements via `replanTasks` : si la liste
 * n'est pas vide, on bloque le replan tant que les allocations manquantes
 * n'ont pas été étendues.
 *
 * @param tasks       Liste ordonnée des tâches du projet (incl. phases/jalons).
 * @param projectId   Id du projet courant.
 * @param allocations Allocations connues (toutes paires).
 * @param absences    Absences cross-projet.
 * @returns           Un objet par tâche en problème : `{ taskId, taskName,
 *                    startDate, charge, collaboratorIds, shortfall }`.
 */
export function scanReplanShortfalls(
  tasks: Task[],
  projectId: string,
  allocations: MemberAllocation[],
  absences: CollaboratorAbsence[],
): {
  taskId: string
  taskName: string
  startDate: string
  charge: number
  collaboratorIds: string[]
  shortfall: AllocationShortfall
}[] {
  const out: {
    taskId: string
    taskName: string
    startDate: string
    charge: number
    collaboratorIds: string[]
    shortfall: AllocationShortfall
  }[] = []
  for (const t of tasks) {
    if (t.kind !== 'task') continue
    const cids = taskCollabIds(t)
    if (cids.length === 0) continue
    const charge = typeof t.charge_jours === 'number' ? t.charge_jours : 0
    if (charge <= 0) continue
    const sh = computeAllocationShortfall({
      startDate: t.start_date,
      charge,
      collaboratorIds: cids,
      projectId,
      allocations,
      absences,
    })
    if (sh.missing > 1e-9) {
      out.push({
        taskId: t.id,
        taskName: t.name,
        startDate: t.start_date,
        charge,
        collaboratorIds: cids,
        shortfall: sh,
      })
    }
  }
  return out
}

/**
 * v1.9 — Ajoute N jours calendaires (peu importe le type) à une date ISO.
 * Helper pour le drag des barres dans le Gantt (où on raisonne en pixels
 * → jours calendaires, puis on snape en jours ouvrés via les helpers ci-dessus).
 *
 * @param iso   Date ISO YYYY-MM-DD.
 * @param days  Nombre de jours à ajouter (peut être négatif).
 * @returns     Date ISO décalée.
 */
export function addDaysIso(iso: string, days: number): string {
  return sharedAddDaysIso(iso, days)
}

/**
 * v1.9 — Si la date ISO tombe un week-end, la pousse au LUNDI suivant ;
 * sinon la renvoie inchangée. Utilisé pour aligner les dates issues d'un
 * drag à la souris sur des jours ouvrés (cohérent avec la notion de charge).
 *
 * @param iso  Date ISO YYYY-MM-DD.
 * @returns    Date ISO d'un jour ouvré (= iso ou décalée au lundi suivant).
 */
export function snapForwardToWorkingDay(iso: string): string {
  return snapForwardToWorkingDayIso(iso)
}

/**
 * v1.9 — Si la date ISO tombe un week-end, la recule au VENDREDI précédent ;
 * sinon la renvoie inchangée. Utilisé quand on RÉDUIT la durée d'une tâche
 * par drag : on préfère qu'elle se termine un vendredi plutôt qu'un samedi.
 *
 * @param iso  Date ISO YYYY-MM-DD.
 * @returns    Date ISO d'un jour ouvré (= iso ou reculée au vendredi précédent).
 */
export function snapBackwardToWorkingDay(iso: string): string {
  return snapBackwardToWorkingDayIso(iso)
}

/**
 * v1.9 — Nombre de jours CALENDAIRES entre deux dates ISO (peut être négatif).
 *   daysBetweenIso('2026-05-18', '2026-05-20') === 2
 *   daysBetweenIso('2026-05-20', '2026-05-18') === -2
 *
 * Utile pour borner un drag (ex. ne pas réduire une barre en-deçà de 1 jour).
 *
 * @param startIso  Date de référence YYYY-MM-DD.
 * @param endIso    Date à comparer YYYY-MM-DD.
 * @returns         endIso - startIso en jours calendaires.
 */
export function daysBetweenIso(startIso: string, endIso: string): number {
  return differenceInCalendarDays(isoToDate(endIso), isoToDate(startIso))
}

/**
 * v1.10 / v1.23 — Calcule la date de début d'un successeur Y à partir de la fin
 * de son prédécesseur X et d'un délai (jours ouvrés).
 *
 * Sémantique : `lag = N` impose **N jours ouvrés strictement entre `predEnd`
 * et `start`** (ces deux bornes exclues). Autrement dit, le délai est le
 * nombre minimal de jours ouvrés d'attente entre la fin du prédécesseur et
 * le début du successeur.
 *
 *   • lag = 0 → Y.start = X.end (ou jour ouvré suivant si X.end tombe un
 *     week-end / férié) — enchaînement immédiat, pas d'attente.
 *   • lag = N ≥ 1 → Y.start = (N+1)-ième jour ouvré STRICTEMENT après X.end.
 *
 * Correctif v1.23 : auparavant la formule `addWorkingDays(base, lag + 1)`
 * comptait `base` comme jour 1, donnant un délai d'un jour ouvré trop court
 * (cf. bug remonté avec lag=6 / Storyboard 03/07 → start 13/07 au lieu de
 * 14/07). On utilise désormais `lag + 2` pour atteindre le bon jour ouvré.
 *
 * Miroir exact de `computeSuccessorStart` côté serveur (db/index.js).
 *
 * @param predEnd  Date de fin du prédécesseur YYYY-MM-DD.
 * @param lag      Délai en jours ouvrés (≥ 0).
 * @returns        Date de début du successeur YYYY-MM-DD.
 */
export function computeSuccessorStart(predEnd: string, lag: number): string {
  return computeSuccessorStartIso(predEnd, lag)
}

/**
 * v1.21 — Calcule la borne basse de la date de début d'une tâche à partir de
 * sa liste de prédécesseurs : `MAX(pred.end + lag)` (règle PERT). Miroir
 * exact du `computeMinStartFromPredecessors` serveur (db/index.js).
 *
 * Renvoie `''` (chaîne vide) si la liste est vide ou si aucun prédécesseur
 * ne correspond à une tâche connue (cas pathologique : id orphelin).
 *
 * @param predecessors  Liste { id, lag } des prédécesseurs.
 * @param allTasks      Toutes les tâches du projet (pour résoudre les end_date).
 * @returns             Date de borne basse YYYY-MM-DD, ou '' si pas de borne.
 */
export function computeMaxStartFromPredecessors(
  predecessors: { id: string; lag: number }[],
  allTasks: { id: string; end_date: string }[],
): string {
  if (!predecessors || predecessors.length === 0) return ''
  const endById = new Map(allTasks.map((t) => [t.id, t.end_date]))
  let maxStart = ''
  for (const p of predecessors) {
    const predEnd = endById.get(p.id)
    if (!predEnd) continue
    const cand = computeSuccessorStart(predEnd, p.lag)
    if (cand > maxStart) maxStart = cand
  }
  return maxStart
}

/**
 * v1.22 — Renvoie une liste hiérarchique aplatie des tâches : chaque entrée
 * porte la tâche et sa profondeur dans l'arbre des phases (parent_id). L'ordre
 * de parcours respecte `position` à chaque niveau, et les enfants viennent
 * juste après leur parent (parcours préfixe). Une tâche dont le `parent_id`
 * pointe vers un parent inconnu est considérée comme racine.
 *
 * Utilisé par `PredecessorPicker` pour rendre l'arbre des tâches avec les
 * phases comme groupes non-sélectionnables.
 *
 * @param tasks  Toutes les tâches du projet.
 * @returns      Liste plate ordonnée avec la profondeur de chaque entrée.
 */
export function flattenTaskTree(
  tasks: { id: string; parent_id: string | null; position: number }[],
): { id: string; depth: number }[] {
  // Index par parent (incl. null pour les racines).
  const childrenByParent = new Map<string | null, typeof tasks>()
  const ids = new Set(tasks.map((t) => t.id))
  for (const t of tasks) {
    const key = t.parent_id && ids.has(t.parent_id) ? t.parent_id : null
    if (!childrenByParent.has(key)) childrenByParent.set(key, [])
    childrenByParent.get(key)!.push(t)
  }
  // Tri stable par position pour chaque niveau.
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => a.position - b.position)
  }
  const out: { id: string; depth: number }[] = []
  const walk = (parentId: string | null, depth: number) => {
    const arr = childrenByParent.get(parentId) || []
    for (const t of arr) {
      out.push({ id: t.id, depth })
      walk(t.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/**
 * v1.9 — Compte les jours OUVRÉS (lundi-vendredi) inclus dans l'intervalle
 * [startIso, endIso]. Inverse de `addWorkingDays` :
 *   workingDaysBetween(s, addWorkingDays(s, n)) === n   (pour s jour ouvré)
 *
 * @param startIso  Date de début YYYY-MM-DD.
 * @param endIso    Date de fin YYYY-MM-DD (incluse).
 * @returns         Nombre de jours ouvrés (≥ 0).
 */
export function workingDaysBetween(startIso: string, endIso: string): number {
  return workingDaysBetweenIso(startIso, endIso)
}

/**
 * Renvoie la date du jour au format ISO 'YYYY-MM-DD' (fuseau local).
 * Utile pour pré-remplir les dates par défaut à la création d'une tâche.
 *
 * @returns Date ISO du jour.
 */
export function todayIso(): string {
  return dateToIso(new Date())
}

/**
 * Renvoie la date la plus tardive entre deux dates ISO.
 * Si l'une des deux est vide, renvoie l'autre. Si les deux sont vides,
 * renvoie chaîne vide.
 *
 * @param a  Date ISO ou ''.
 * @param b  Date ISO ou ''.
 * @returns  La plus tardive (comparaison lexicographique = correcte pour ISO).
 */
export function maxIso(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

/**
 * Retourne le LUNDI de la semaine de la date passée.
 * Si la date est déjà un lundi, la renvoie inchangée ; sinon recule
 * jusqu'au lundi précédent.
 *
 * @param iso  Date ISO YYYY-MM-DD.
 * @returns    Date ISO du lundi de la même semaine.
 */
export function mondayOnOrBefore(iso: string): string {
  // weekStartsOn: 1 = lundi (l'ISO 8601 standard).
  return dateToIso(startOfWeek(isoToDate(iso), { weekStartsOn: 1 }))
}

/**
 * Calcule la fenêtre temporelle d'affichage par défaut à partir des tâches :
 * démarre au LUNDI de la semaine de la tâche démarrant le plus tôt et
 * couvre N mois.
 *
 * Si la liste de tâches est vide, retombe sur `defaultWindow()` (4 mois
 * autour d'aujourd'hui, aligné sur le 1er du mois).
 *
 * @param tasks   Liste de tâches (au moins `start_date` requis sur chacune).
 * @param months  Nombre de mois à afficher (défaut : 4).
 * @returns       { startIso, endIso } bornes du calendrier (incluses).
 */
export function windowFromTasks(
  tasks: Array<{ start_date: string }>,
  months: number = 4,
): { startIso: string; endIso: string } {
  if (tasks.length === 0) return defaultWindow(undefined, months)
  // La comparaison lexicographique fonctionne sur YYYY-MM-DD.
  let earliest = tasks[0].start_date
  for (const t of tasks) {
    if (t.start_date && t.start_date < earliest) earliest = t.start_date
  }
  const startIso = mondayOnOrBefore(earliest)
  // Fin = start + N mois - 1 jour (cohérent avec defaultWindow).
  const end = addDays(addMonths(isoToDate(startIso), months), -1)
  return { startIso, endIso: dateToIso(end) }
}

/**
 * Découpe une plage de dates en groupes par mois (pour le header du calendrier).
 *
 * @param dates  Liste continue de Date (1 par jour, ordonnée).
 * @returns      Tableau de { label, span } où span = nombre de jours du mois
 *               présents dans la plage.
 */
export function groupByMonth(
  dates: Date[],
): Array<{ label: string; span: number }> {
  const out: Array<{ label: string; span: number }> = []
  for (const d of dates) {
    const label = format(d, 'MMMM yyyy')
    const last = out[out.length - 1]
    if (last && last.label === label) last.span++
    else out.push({ label, span: 1 })
  }
  return out
}

/**
 * v1.14 — Regroupe une liste de dates par semaine ISO (lundi → dimanche).
 * Utilisé pour la ligne d'en-tête du calendrier quand on est très dézoomé :
 * on remplace les numéros de jour (illisibles à `dayWidth < 12`) par les
 * numéros de semaine (`S20`, `S21`, …). La 1re et la dernière semaine
 * peuvent être partielles si la fenêtre ne commence/finit pas un lundi
 * — le `span` reflète alors le nombre exact de jours présents.
 *
 * @param dates  Liste continue de Date (1 par jour, ordonnée).
 * @returns      Tableau de { label, span } où label = 'S' + numéro ISO,
 *               span = nombre de jours de la semaine présents dans la plage.
 */
export function groupByWeek(
  dates: Date[],
): Array<{ label: string; span: number }> {
  const out: Array<{ label: string; span: number }> = []
  let currentWeek = -1
  for (const d of dates) {
    const w = getISOWeek(d)
    if (w !== currentWeek) {
      currentWeek = w
      out.push({ label: `S${w}`, span: 1 })
    } else {
      out[out.length - 1].span++
    }
  }
  return out
}

// -----------------------------------------------------------------------------
// PLAN DE CHARGE (v1.16) — calcul de la charge par collaborateur et par jour
// -----------------------------------------------------------------------------

/**
 * v1.16 — Calcule la charge journalière (en jours-personne) de chaque
 * collaborateur, pour chaque date de la plage fournie. Règle :
 *   • seules les tâches `kind === 'task'` comptent (les jalons et phases
 *     n'engendrent aucune charge),
 *   • la tâche n'est imputée qu'aux **jours ouvrés** présents dans
 *     `[start_date, end_date]` (les week-ends restent à 0),
 *   • on considère pour l'instant qu'un collaborateur est affecté à 100 %
 *     (1 jour) sur chaque tâche qui lui est assignée ; donc 2 tâches qui
 *     se chevauchent un même jour produisent une charge de 2 = surcharge.
 *
 * Le résultat est indexé par `collaborator_id`, avec un tableau parallèle
 * à `dates` (un float par jour, dans le même ordre). Les collaborateurs
 * sans tâche apparaissent quand même avec un tableau plein de 0.
 *
 * @param tasks         Toutes les tâches du projet courant.
 * @param collaborators Tous les collaborateurs visibles.
 * @param dates         Plage continue de Date (typiquement
 *                      `buildDateRange(windowStart, windowEnd)`).
 * @returns             Map id → tableau de longueur `dates.length`.
 */
/**
 * v2.0 / F2 — Cumule la contribution d'une tâche sur la timeline du
 * collaborateur. Extrait pour limiter la complexité cognitive de
 * `computeWorkload` (cf. sonarjs/cognitive-complexity).
 *
 *   • 1 jour ouvré couvert + 100 % alloué → +1
 *   • 1 jour ouvré couvert + 50 % alloué  → +0.5
 *   • férié / week-end / hors période     → +0
 *   • sans allocations passées            → +1 par jour ouvré (fallback F1)
 */
function accumulateTaskWorkload(
  t: Task,
  arr: number[],
  collabId: string,
  dates: Date[],
  allocations: MemberAllocation[],
  absences: CollaboratorAbsence[],
): void {
  const start = isoToDate(t.start_date).getTime()
  const end = isoToDate(t.end_date).getTime()
  const useAllocations = allocations.length > 0
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i]
    const ts = d.getTime()
    if (ts < start || ts > end) continue
    if (isNonWorkingDay(d)) continue
    if (useAllocations) {
      arr[i] += getDailyAllocation(
        dateToIso(d),
        allocations,
        t.project_id,
        collabId,
        absences,
      )
    } else {
      arr[i] += 1
    }
  }
}

export function computeWorkload(
  tasks: Task[],
  collaborators: Collaborator[],
  dates: Date[],
  allocations: MemberAllocation[] = [],
  absences: CollaboratorAbsence[] = [],
): Map<string, number[]> {
  const result = new Map<string, number[]>()
  for (const c of collaborators) {
    result.set(c.id, new Array(dates.length).fill(0))
  }
  // v2.0 / F2 — La contribution d'une tâche à un jour donné est désormais
  // pondérée par l'allocation effective du collab ce jour-là sur ce projet.
  // v2.0 / F3 — Multiplicativement réduite par l'éventuelle absence du collab
  // ce jour-là (cross-projet). Sans allocations → fallback F0/F1 : contribution
  // = 1 par jour ouvré (les absences ne s'appliquent pas dans ce mode).
  // v2.0 / F6 — Multi-collab : la tâche contribue à la timeline de CHAQUE
  // collab affecté (pas seulement le 1er). Chacun voit donc sa propre part
  // de la charge dans son plan de charge personnel.
  for (const t of tasks) {
    if (t.kind !== 'task') continue
    // Source de vérité : `collaborators[]` (F6) ; fallback `collaborator_id` (legacy).
    const collabIds = taskCollabIds(t)
    if (collabIds.length === 0) continue
    for (const cId of collabIds) {
      const arr = result.get(cId)
      if (!arr) continue
      accumulateTaskWorkload(t, arr, cId, dates, allocations, absences)
    }
  }
  return result
}

/**
 * v1.16 — Classes Tailwind à appliquer à une cellule de plan de charge
 * selon la charge cumulée du jour. Code couleur calqué sur le projet
 * « plan-de-charge » pour cohérence visuelle :
 *
 *   • `> 1`              → rouge   (SURCHARGE)
 *   • `= 1`              → vert    (journée pleine)
 *   • `[0.75 ; 1[`       → bleu marqué
 *   • `[0.5  ; 0.75[`    → bleu moyen
 *   • `]0    ; 0.5[`     → bleu pâle  (sous-charge)
 *   • `0`                → cellule neutre (vide)
 *
 * v1.17 — Option `highlightUnderload` : quand `true`, toutes les charges
 * strictement inférieures à 1 (y compris `0`) basculent sur une palette
 * jaune pour mettre en évidence les disponibilités, dans le même esprit
 * que le rouge pour les surcharges :
 *
 *   • `]0 ; 1[`          → jaune appuyé    (charge partielle)
 *   • `0`                → jaune pâle      (totalement libre)
 *
 * Les états `= 1` (vert) et `> 1` (rouge) restent inchangés — l'option ne
 * concerne que la zone « sous-charge ».
 *
 * @param sum                Charge cumulée du jour (peut dépasser 1).
 * @param highlightUnderload v1.17 — Si true, palette jaune pour sum < 1.
 * @returns                  Classes Tailwind concaténables.
 */
export function workloadCellStyle(
  sum: number,
  highlightUnderload = false,
): string {
  if (sum > 1) return 'bg-red-500 text-white'
  if (sum === 1) return 'bg-emerald-300 text-emerald-900'
  if (highlightUnderload) {
    if (sum > 0) return 'bg-yellow-400 text-yellow-900'
    return 'bg-yellow-200 text-yellow-800'
  }
  if (sum >= 0.75) return 'bg-blue-400 text-white'
  if (sum >= 0.5) return 'bg-blue-200 text-blue-900'
  if (sum > 0) return 'bg-blue-100 text-blue-900'
  return 'text-slate-300'
}

/**
 * v2.0 / F5 — Capacité totale d'un collaborateur pour un jour donné, en
 * agrégeant ses allocations sur TOUS LES PROJETS et en appliquant
 * l'absence éventuelle (multiplicative).
 *
 * Sémantique :
 *   capacité_totale(c, d) = (Σ pct(p, c, d) sur tous projets p) × (1 − absence(c, d))
 *
 * Cas concrets (validés avec l'utilisateur, Q3) :
 *   • Léa 50 % sur A seul, pas d'absence → 0,5
 *   • Léa 50 % sur A + 50 % sur B, pas d'absence → 1,0
 *   • Léa 100 % sur A + congé 1 j → 0
 *   • Léa 100 % sur A + 100 % sur B + congé 0,5 j → 2 × 0,5 = 1,0
 *
 * Sert de **dénominateur** au plan de charge pour positionner les seuils de
 * coloration (surcharge ssi workload > capacité, sous-charge si workload <
 * capacité). Sans cette normalisation, un collab à 50 % apparaîtrait toujours
 * en sous-charge même quand il est pleinement chargé sur sa capacité réelle.
 *
 * @param dateIso     Jour à évaluer.
 * @param allocations TOUTES les allocations connues (cross-projet).
 * @param collabId    Collab à évaluer.
 * @param absences    Absences cross-projet (utilisées pour la pondération).
 * @returns           Capacité dans [0, +∞[ (théoriquement plafonnée à 1 ou Σ
 *                    si plusieurs projets temps plein, mais on ne plafonne
 *                    pas — c'est le total réel des engagements).
 */
export function getTotalCapacity(
  dateIso: string,
  allocations: MemberAllocation[],
  collabId: string,
  absences: CollaboratorAbsence[] = [],
): number {
  const d = isoToDate(dateIso)
  if (isNonWorkingDay(d)) return 0
  // Somme des pct sur tous projets couvrant la date.
  let sumPct = 0
  for (const a of allocations) {
    if (a.collaborator_id !== collabId) continue
    if (dateIso >= a.start_date && dateIso <= a.end_date) {
      sumPct += a.allocation_pct / 100
    }
  }
  if (sumPct === 0) return 0
  // Pondération multiplicative par l'absence du jour (cross-projet aussi).
  let presence = 1
  for (const ab of absences) {
    if (ab.collaborator_id !== collabId) continue
    if (ab.date !== dateIso) continue
    presence = Math.max(0, 1 - Math.max(0, Math.min(1, ab.fraction)))
    break
  }
  return sumPct * presence
}

/**
 * v2.0 / F5 — Variante de `workloadCellStyle` qui positionne les seuils de
 * coloration par rapport à la **capacité totale** du jour plutôt qu'à un
 * plafond fixe de 1. Cohérent avec la décision utilisateur (Q3) :
 *
 *   • workload > capacité       → rouge (SURCHARGE)
 *   • workload === capacité     → vert  (journée pleinement chargée)
 *   • workload [0.75c ; capac[  → bleu marqué
 *   • workload [0.5c  ; 0.75c[  → bleu moyen
 *   • workload ]0     ; 0.5c[   → bleu pâle (sous-charge)
 *   • workload === 0            → cellule neutre
 *
 * Cas `capacity === 0` (collab non dispo ce jour) :
 *   • workload === 0 → neutre (cohérent, aucun travail prévu et impossible).
 *   • workload > 0   → rouge (surcharge théorique : on a planifié alors que
 *     le collab n'a aucune capacité — anomalie).
 *
 * @param workload           Charge cumulée du jour (déjà pondérée par alloc × absence).
 * @param capacity           Capacité totale du jour (cf. `getTotalCapacity`).
 * @param highlightUnderload v1.17 — palette jaune pour sous-charge si true.
 * @returns                  Classes Tailwind concaténables.
 */
export function workloadCellStyleNormalized(
  workload: number,
  capacity: number,
  highlightUnderload = false,
): string {
  // Tolérance numérique pour les comparaisons sur fractions 0.25/0.5/0.75/1.
  const EPS = 1e-9
  // Cellule « totalement libre » (workload nul) :
  //   • highlightUnderload → jaune pâle pour matérialiser la dispo,
  //   • sinon → neutre (slate).
  if (workload === 0) {
    return highlightUnderload
      ? 'bg-yellow-200 text-yellow-800'
      : 'text-slate-300'
  }
  // Capacité 0 + workload > 0 = anomalie pure → surcharge brute.
  if (capacity <= EPS) return 'bg-red-500 text-white'
  const ratio = workload / capacity
  if (ratio > 1 + EPS) return 'bg-red-500 text-white'
  if (Math.abs(ratio - 1) <= EPS) return 'bg-emerald-300 text-emerald-900'
  if (highlightUnderload) return 'bg-yellow-400 text-yellow-900'
  if (ratio >= 0.75) return 'bg-blue-400 text-white'
  if (ratio >= 0.5) return 'bg-blue-200 text-blue-900'
  return 'bg-blue-100 text-blue-900'
}

/**
 * Trie les tâches hiérarchiquement : chaque tâche enfant est placée
 * immédiatement après son parent (en respectant `position` au sein de
 * chaque niveau). Les enfants orphelins (parent_id pointe sur un id absent)
 * sont remontés à la racine pour ne pas être perdus.
 *
 * @param tasks  Liste plate de tâches (ordre d'origine quelconque).
 * @returns      Nouvelle liste ordonnée parent → enfants → petits-enfants…
 */
export function sortTasksHierarchically(tasks: Task[]): Task[] {
  // Index id → tâche pour résoudre les orphelins.
  const byId = new Map<string, Task>()
  for (const t of tasks) byId.set(t.id, t)

  // Pour chaque parent (ou racine = ''), liste de ses enfants triés par position.
  const childrenOf = new Map<string, Task[]>()
  for (const t of tasks) {
    // Parent ignoré s'il est inconnu → on rattache à la racine.
    const parentKey = t.parent_id && byId.has(t.parent_id) ? t.parent_id : ''
    const arr = childrenOf.get(parentKey) || []
    arr.push(t)
    childrenOf.set(parentKey, arr)
  }
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => a.position - b.position)
  }

  // Parcours profondeur d'abord en partant des racines.
  const out: Task[] = []
  function walk(parentKey: string) {
    const list = childrenOf.get(parentKey) || []
    for (const t of list) {
      out.push(t)
      walk(t.id)
    }
  }
  walk('')
  return out
}

// -----------------------------------------------------------------------------
// REPLAN (v1.18) — replanification des tâches pour résoudre les surcharges
// -----------------------------------------------------------------------------

/**
 * v1.18 — Une « proposition de déplacement » renvoyée par `replanTasks` :
 * pour une tâche donnée, ses dates actuelles et les dates proposées par
 * l'algorithme. La modal d'aperçu se contente de mapper ce tableau en lignes.
 */
export interface ReplanMove {
  /** Id de la tâche concernée. */
  id: string
  /** Libellé (recopié pour faciliter l'affichage). */
  name: string
  /** Collaborateur affecté (peut être null). */
  collaborator_id: string | null
  /** Date de début actuelle. */
  oldStart: string
  /** Date de fin actuelle. */
  oldEnd: string
  /** Date de début proposée par la replanification. */
  newStart: string
  /** Date de fin proposée par la replanification. */
  newEnd: string
  /**
   * v1.23 — Délai prédécesseur ACTUEL de la tâche, recopié tel quel pour que
   * le caller puisse l'inclure dans le PATCH `{start_date, end_date,
   * predecessor_lag}` et ainsi PRÉSERVER l'intention utilisateur. Sans ça,
   * le serveur infère un nouveau lag depuis le gap (new_start - pred.end)
   * et écrase la valeur saisie (cf. bug v1.22 / Test délai → lag remis à 6).
   * Vaut 0 quand la tâche n'a pas de prédécesseur.
   */
  predecessor_lag: number
}

/**
 * v1.18 — Cherche la première date de début ≥ `earliestStart` telle que
 * l'intervalle de travail `[start ; addWorkingDays(start, charge)]` ne
 * chevauche AUCUN intervalle déjà occupé par le collaborateur.
 *
 * Les intervalles sont fournis sous la forme `[start_iso, end_iso]` (bornes
 * INCLUSIVES). On considère qu'il y a chevauchement dès que les deux
 * intervalles ont au moins un jour en commun.
 *
 * @param intervals     Intervalles déjà fixés pour le collaborateur.
 * @param earliestStart Borne basse (souvent : `current_start` ou contrainte
 *                      de prédécesseur), déjà snappée jour ouvré.
 * @param charge        Durée en jours OUVRÉS de la tâche à placer.
 * @returns             1er jour ouvré disponible (ISO YYYY-MM-DD).
 */
function findFreeSlot(
  intervals: Array<[string, string]>,
  earliestStart: string,
  charge: number,
): string {
  let candidate = snapForwardToWorkingDay(earliestStart)
  // On ré-itère tant qu'on déplace : pousser au-delà d'un intervalle peut
  // tomber sur un autre intervalle plus loin (intervalles non triés ici,
  // mais le caller les tient triés ; la boucle est bornée par leur nombre).
  let moved = true
  while (moved) {
    moved = false
    const candidateEnd = addWorkingDays(candidate, charge)
    for (const [iStart, iEnd] of intervals) {
      // Chevauchement = NON (candidateEnd < iStart OU candidate > iEnd).
      if (candidateEnd >= iStart && candidate <= iEnd) {
        // Pousse au 1er jour ouvré APRÈS la fin de l'intervalle bloquant.
        candidate = snapForwardToWorkingDay(addDaysIso(iEnd, 1))
        moved = true
        break
      }
    }
  }
  return candidate
}

/**
 * v1.18 — Construit l'ordre de traitement des tâches pour la replanification :
 * tri TOPOLOGIQUE (un prédécesseur de type 'task' est traité avant ses
 * successeurs) avec, à chaque étape, choix de la « ready » la plus prioritaire.
 *
 * Critère de priorité quand plusieurs tâches sont prêtes en même temps :
 *   1. Champ `priority` : 1 = plus prioritaire, 5 = moins ; `null` est traité
 *      comme `6` (= passe APRÈS toute valeur saisie).
 *   2. Position dans la liste (haut en premier) — déterminée par l'ordre
 *      d'entrée dans `tasks` (le caller passe `sortTasksHierarchically(...)`).
 *
 * Les jalons et phases sont ignorés : seuls les `kind === 'task'` peuvent
 * être déplacés (un jalon suit son prédécesseur via la cascade serveur,
 * une phase est auto-calculée depuis ses enfants).
 *
 * @param tasks  Liste complète des tâches du projet (déjà ordonnée
 *               hiérarchiquement par le caller).
 * @returns      Tâches `kind='task'` dans l'ordre où la replanification
 *               doit les traiter.
 */
/**
 * v1.18 — Construit le graphe de dépendances entre tâches `kind='task'` :
 *   • `inDeg[id]`     = nombre de prédécesseurs de type 'task' encore à traiter
 *   • `successors[id]` = ids des tâches qui ont cette tâche comme prédécesseur
 *
 * Les prédécesseurs de type 'milestone' sont ignorés (ils sont fixes : leur
 * date ne change pas pendant la replanification). Extrait de `buildReplanOrder`
 * pour limiter la complexité cyclomatique.
 *
 * @param taskKindTasks  Tâches de type 'task' à ordonner.
 * @param tasksById      Index id → tâche (toutes kinds confondues).
 * @returns              `{ inDeg, successors }`.
 */
function buildPredecessorGraph(
  taskKindTasks: Task[],
  tasksById: Map<string, Task>,
): {
  inDeg: Map<string, number>
  successors: Map<string, string[]>
} {
  const inDeg = new Map<string, number>()
  const successors = new Map<string, string[]>()
  for (const t of taskKindTasks) inDeg.set(t.id, 0)
  for (const t of taskKindTasks) {
    if (!t.predecessor_id) continue
    const pred = tasksById.get(t.predecessor_id)
    if (!pred || pred.kind !== 'task') continue
    inDeg.set(t.id, (inDeg.get(t.id) || 0) + 1)
    const arr = successors.get(pred.id) || []
    arr.push(t.id)
    successors.set(pred.id, arr)
  }
  return { inDeg, successors }
}

function buildReplanOrder(tasks: Task[]): Task[] {
  const taskKindTasks = tasks.filter((t) => t.kind === 'task')
  const tasksById = new Map(tasks.map((t) => [t.id, t]))
  // Position dans la liste = ordre d'entrée parmi les `task` (le hiérarchique
  // est déjà appliqué côté caller).
  const listPos = new Map<string, number>()
  taskKindTasks.forEach((t, i) => listPos.set(t.id, i))

  const { inDeg, successors } = buildPredecessorGraph(taskKindTasks, tasksById)

  /** Comparateur stable (priorité asc, puis position asc).
   *  v1.24 — La priorité d'une activité est maintenant toujours définie (1..5)
   *  grâce à la règle Pr2 ; on garde toutefois le fallback `?? 3` pour rester
   *  robuste face à d'éventuelles données héritées d'une version antérieure. */
  const cmp = (a: Task, b: Task) => {
    const pa = a.priority ?? 3
    const pb = b.priority ?? 3
    if (pa !== pb) return pa - pb
    return (listPos.get(a.id) ?? 0) - (listPos.get(b.id) ?? 0)
  }

  const ready: Task[] = taskKindTasks.filter(
    (t) => (inDeg.get(t.id) || 0) === 0,
  )
  const out: Task[] = []
  while (ready.length > 0) {
    ready.sort(cmp)
    const chosen = ready.shift() as Task
    out.push(chosen)
    for (const succId of successors.get(chosen.id) || []) {
      const nd = (inDeg.get(succId) || 0) - 1
      inDeg.set(succId, nd)
      const succ = nd === 0 ? tasksById.get(succId) : null
      if (succ) ready.push(succ)
    }
  }

  // Garde-fou anti-cycle : si l'UI a laissé passer un cycle (ne devrait pas
  // arriver — cf. `descendantIds`), on ajoute les tâches restantes en queue
  // pour ne pas perdre silencieusement leur replan.
  if (out.length < taskKindTasks.length) {
    const seen = new Set(out.map((t) => t.id))
    for (const t of taskKindTasks) {
      if (!seen.has(t.id)) out.push(t)
    }
  }
  return out
}

/**
 * v1.18 — Replanifie les tâches d'un projet pour résoudre toute surcharge
 * collaborateur. Fonction PURE : ne mute rien, retourne la liste des
 * déplacements à appliquer (à `PATCH /api/tasks/:id` ensuite).
 *
 * Algorithme (greedy par ordre de priorité, déterministe) :
 *   1. Construit un tri topologique respectant les prédécesseurs (cf.
 *      `buildReplanOrder`), avec, à chaque étape, la « ready » la plus
 *      prioritaire choisie en premier.
 *   2. Pour chaque tâche, calcule la borne basse :
 *        max(current_start, prédécesseur.proposed_end + lag).
 *      Une tâche n'est JAMAIS déplacée vers le passé.
 *   3. Cherche le 1er créneau libre du collaborateur ≥ cette borne, capable
 *      d'accueillir la charge (jours ouvrés) de la tâche, sans chevaucher un
 *      créneau déjà fixé d'une tâche plus prioritaire.
 *   4. Fixe la tâche à ce créneau, l'ajoute au planning du collaborateur,
 *      et continue.
 *
 * Les jalons et phases ne sont pas déplacés ici : leur date suivra naturellement
 * via la cascade serveur (`propagateToSuccessors` + `recomputeAncestorPhases`)
 * une fois les `PATCH` envoyés.
 *
 * @param tasks  Liste hiérarchique du projet (cf. `sortTasksHierarchically`).
 * @returns      Tableau (potentiellement vide) des déplacements proposés.
 */
/**
 * v1.18 — Calcule la borne basse de début pour une tâche en replanification :
 * on prend le maximum entre sa date de début actuelle (= on ne recule jamais)
 * et la contrainte de prédécesseur (= fin proposée du prédécesseur + lag).
 *
 * @param t          Tâche à placer.
 * @param tasksById  Index des tâches.
 * @param proposed   Dates déjà proposées (pour récupérer la fin du prédécesseur).
 * @returns          Date ISO YYYY-MM-DD (déjà snappée jour ouvré).
 */
function computeReplanEarliestStart(
  t: Task,
  tasksById: Map<string, Task>,
  proposed: Map<string, { start: string; end: string }>,
): string {
  let earliest = t.start_date
  if (t.predecessor_id) {
    const pred = tasksById.get(t.predecessor_id)
    if (pred) {
      const predEnd = proposed.get(pred.id)?.end ?? pred.end_date
      const lagStart = computeSuccessorStart(predEnd, t.predecessor_lag || 0)
      if (lagStart > earliest) earliest = lagStart
    }
  }
  // v1.24 — Borne basse supplémentaire : la contrainte SNET « Ne doit pas
  // démarrer avant le », snappée au prochain jour ouvré. La règle « plus
  // tardif gagne » est portée par ce max successif (current_start, pred.end
  // + lag, SNET).
  if (t.not_before_date) {
    const snet = snapForwardToWorkingDay(t.not_before_date)
    if (snet > earliest) earliest = snet
  }
  return snapForwardToWorkingDay(earliest)
}

/**
 * v1.18 — Ajoute un intervalle à la timeline d'un collaborateur, en
 * conservant l'ordre croissant des starts. Comparaison lexicographique sur
 * ISO YYYY-MM-DD (équivalent au tri chronologique).
 *
 * @param timeline       Map id-collab → liste d'intervalles `[start, end]`.
 * @param collabId       Collaborateur à mettre à jour.
 * @param start          Début de l'intervalle (jour ouvré).
 * @param end            Fin de l'intervalle (jour ouvré, incluse).
 */
function pushTimelineInterval(
  timeline: Map<string, Array<[string, string]>>,
  collabId: string,
  start: string,
  end: string,
): void {
  const intervals = timeline.get(collabId) || []
  intervals.push([start, end])
  intervals.sort((a, b) => a[0].localeCompare(b[0]))
  timeline.set(collabId, intervals)
}

/**
 * v1.21 — Place UNE tâche dans le timeline en cherchant le 1er créneau libre,
 * met à jour `proposed` et `timeline`. Extrait pour limiter la complexité
 * cognitive de `replanTasks` (cf. sonarjs/cognitive-complexity).
 *
 * @param t          Tâche à placer (kind='task' garanti par le caller).
 * @param tasksById  Index id → tâche du projet.
 * @param proposed   Dates déjà proposées (sera mutée).
 * @param timeline   Map id-collab → intervalles fixés (sera mutée).
 */
function placeTaskInTimeline(
  t: Task,
  tasksById: Map<string, Task>,
  proposed: Map<string, { start: string; end: string }>,
  timeline: Map<string, Array<[string, string]>>,
  allocations: MemberAllocation[],
  absences: CollaboratorAbsence[],
): void {
  // v2.0 — La charge est désormais lue depuis `task.charge_jours` (source de
  // vérité). Pour les tâches issues de bases anciennes ou de tests qui ne
  // l'auraient pas encore peuplée, on retombe sur l'écart courant pour rester
  // rétro-compatible (filet de sécurité ; la migration `ensureChargeColumn`
  // peuple toujours la colonne au boot).
  const charge =
    t.charge_jours && t.charge_jours >= 1
      ? t.charge_jours
      : Math.max(1, workingDaysBetween(t.start_date, t.end_date))
  const earliest = computeReplanEarliestStart(t, tasksById, proposed)
  // v2.0 / F6 — Liste multi-collab : on lit `collaborators[]` (source de
  // vérité depuis F6) avec fallback sur l'alias `collaborator_id`. La timeline
  // de chaque collab impacté est consultée et mise à jour pour bloquer
  // tous les créneaux simultanément.
  const collabIds = taskCollabIds(t)
  // v2.0 / F6 — Recherche d'un créneau libre simultanément pour TOUS les
  // collabs affectés : on prend le MAX des findFreeSlot individuels (chaque
  // collab impose sa propre contrainte).
  let newStart = earliest
  for (const cId of collabIds) {
    const intervals = timeline.get(cId) || []
    const candidate = findFreeSlot(intervals, earliest, charge)
    if (candidate > newStart) newStart = candidate
  }
  // v2.0 / F2 — La fin est calculée en consommant la capacité quotidienne
  // (allocation %) du collab sur le projet.
  // v2.0 / F3 — Les absences personnelles diminuent cette capacité jour par
  // jour (lecture multiplicative).
  // v2.0 / F6 — En multi-collab, la capacité du jour est la SOMME des
  // contributions de tous les affectés (Q12a additif uniforme).
  const newEnd = computeEndFromCharge(newStart, charge, {
    projectId: t.project_id,
    collaboratorId: t.collaborator_id,
    collaboratorIds: collabIds.length > 0 ? collabIds : undefined,
    allocations,
    absences,
  })
  proposed.set(t.id, { start: newStart, end: newEnd })
  // v2.0 / F6 — Bloque le créneau dans la timeline de CHAQUE collab affecté.
  for (const cId of collabIds) {
    pushTimelineInterval(timeline, cId, newStart, newEnd)
  }
}

/**
 * v1.21 — Pré-remplit la timeline des collaborateurs avec les tâches LOCKÉES
 * (= non concernées en mode partiel). Ces tâches gardent leurs dates et
 * bloquent les créneaux correspondants. Extrait de `replanTasks` pour
 * limiter la complexité cognitive.
 */
function prefillLockedIntervals(
  tasks: Task[],
  concernedIds: Set<string>,
  timeline: Map<string, Array<[string, string]>>,
): void {
  for (const t of tasks) {
    if (t.kind !== 'task') continue
    if (concernedIds.has(t.id)) continue
    // v2.0 / F6 — Lit la liste multi-collab (avec fallback legacy).
    const collabIds = taskCollabIds(t)
    for (const cId of collabIds) {
      pushTimelineInterval(timeline, cId, t.start_date, t.end_date)
    }
  }
}

/**
 * v1.21 — Construit la liste finale des `ReplanMove` en ne gardant QUE les
 * tâches dont les dates proposées diffèrent des dates d'origine. Extrait
 * pour limiter la complexité cognitive de `replanTasks`.
 */
function buildReplanMoves(
  order: Task[],
  proposed: Map<string, { start: string; end: string }>,
): ReplanMove[] {
  const moves: ReplanMove[] = []
  for (const t of order) {
    const p = proposed.get(t.id)
    if (!p) continue
    if (p.start === t.start_date && p.end === t.end_date) continue
    moves.push({
      id: t.id,
      name: t.name,
      collaborator_id: t.collaborator_id,
      oldStart: t.start_date,
      oldEnd: t.end_date,
      newStart: p.start,
      newEnd: p.end,
      // v1.23 — Conserve le lag courant pour que le PATCH du replan le
      // renvoie tel quel et que le serveur ne le ré-infère pas depuis le
      // nouveau gap.
      predecessor_lag: t.predecessor_lag || 0,
    })
  }
  return moves
}

export function replanTasks(
  tasks: Task[],
  concernedIds?: Set<string>,
  allocations: MemberAllocation[] = [],
  absences: CollaboratorAbsence[] = [],
): ReplanMove[] {
  // v1.21 — `concernedIds` actif → replan PARTIEL : seules les tâches
  // listées peuvent voir leurs dates modifiées. Les autres sont LOCKÉES à
  // leurs dates actuelles ET ajoutées au timeline du collaborateur (=
  // obstacles à contourner). Si `concernedIds` est `undefined`, le replan
  // est COMPLET (comportement historique : toutes les tâches `task` sont
  // candidates au déplacement).
  // v2.0 / F2 — `allocations` est la liste des périodes d'allocation du
  // projet : le moteur consomme la capacité quotidienne (allocation %) pour
  // calculer la fin de chaque tâche, au lieu de simples jours ouvrés bruts.
  // v2.0 / F3 — `absences` réduit multiplicativement la capacité du collab
  // (lecture cross-projet). Vide → pas d'impact.
  // Tableau vide → comportement F0 (fin = start + charge en jours ouvrés).
  const isPartial = !!concernedIds
  const isConcerned = (id: string) =>
    !isPartial || (concernedIds as Set<string>).has(id)

  const tasksById = new Map(tasks.map((t) => [t.id, t]))
  const order = buildReplanOrder(tasks)

  // Dates proposées par tâche (init = dates actuelles).
  const proposed = new Map<string, { start: string; end: string }>()
  for (const t of tasks) {
    proposed.set(t.id, { start: t.start_date, end: t.end_date })
  }

  // Timeline (intervalles fixés) par collaborateur — bornes INCLUSIVES en
  // jours ouvrés (compatibles avec `findFreeSlot`).
  const timeline = new Map<string, Array<[string, string]>>()
  if (isPartial) {
    prefillLockedIntervals(tasks, concernedIds as Set<string>, timeline)
  }

  for (const t of order) {
    if (!isConcerned(t.id)) continue
    placeTaskInTimeline(t, tasksById, proposed, timeline, allocations, absences)
  }

  return buildReplanMoves(order, proposed)
}

/**
 * v1.20 — Filtre les tâches dont AU MOINS UN ancêtre (transitif) est dans
 * `collapsedPhases`. Les phases elles-mêmes restent toujours visibles ;
 * seuls leurs descendants (directs ou indirects) sont masqués.
 *
 * Utilisé côté GanttChart pour permettre à l'utilisateur de plier/déplier
 * une phase et masquer toute son arborescence d'enfants. La logique est
 * uniquement visuelle : aucune donnée n'est modifiée côté serveur, et
 * `replanTasks` continue de raisonner sur la liste complète.
 *
 * @param tasks            Liste hiérarchique des tâches.
 * @param collapsedPhases  Set d'ids de phases actuellement repliées.
 * @returns                Sous-liste des tâches à afficher (ordre préservé).
 */
export function filterCollapsed(
  tasks: Task[],
  collapsedPhases: Set<string>,
): Task[] {
  if (collapsedPhases.size === 0) return tasks
  const byId = new Map<string, Task>()
  for (const t of tasks) byId.set(t.id, t)
  /** Vrai si un ancêtre `phase` de la tâche est replié. */
  function hasCollapsedAncestor(t: Task): boolean {
    let cur = t.parent_id ? byId.get(t.parent_id) : null
    // Sécurité anti-cycle : on borne le nombre d'itérations à la taille de
    // l'arbre (en pratique, le `parent_id` ne cycle pas dans nos données).
    let safety = tasks.length + 1
    while (cur && safety-- > 0) {
      if (cur.kind === 'phase' && collapsedPhases.has(cur.id)) return true
      cur = cur.parent_id ? byId.get(cur.parent_id) : null
    }
    return false
  }
  return tasks.filter((t) => !hasCollapsedAncestor(t))
}

// -----------------------------------------------------------------------------
// COHÉRENCE (v1.21) — détection d'incohérences après déplacement libre
// -----------------------------------------------------------------------------
// Depuis la v1.21 l'utilisateur peut déplacer une activité dans le passé
// par drag (le geste n'est plus bridé vers la droite). Les règles métier
// ne sont donc plus garanties à tout instant : on les vérifie a posteriori
// via cette fonction PURE et on les remonte dans un bandeau d'alerte au-
// dessus du planning (cf. `CoherenceAlert`). « Replan » (complet ou partiel)
// reste l'outil de remise en cohérence.
// -----------------------------------------------------------------------------

/** v1.21 / v1.24 — Catégorie d'incohérence détectée par `checkCoherence`.
 *  `not_before` (v1.24) signale une activité ou un jalon dont la date de
 *  début est antérieure à sa contrainte SNET (« ne doit pas démarrer avant le »). */
export type CoherenceIssueKind =
  | 'overload'
  | 'predecessor'
  | 'priority'
  | 'not_before'
  /** v2.0 / F4 — La fin calculée d'une activité ou d'un jalon dépasse sa
   *  contrainte FNLT (« Fin au plus tard »). Severity = `warning` :
   *  signalement uniquement, jamais bloquant. */
  | 'fnlt_overrun'

/** v1.21 — Une incohérence remontée pour affichage dans le bandeau. */
export interface CoherenceIssue {
  /** Type de règle violée. */
  kind: CoherenceIssueKind
  /** `error` = bloquant logique (à corriger) ; `warning` = à examiner. */
  severity: 'error' | 'warning'
  /** Ids des tâches impliquées (1 ou 2, dans l'ordre où elles concernent
   *  la règle ; pour les paires : [tâche pivot, tâche en conflit]). */
  taskIds: string[]
  /** Message lisible (français), prêt à afficher dans l'UI. */
  message: string
}

/**
 * v1.21 — Détecte les surcharges entre tâches d'un même collaborateur. Une
 * surcharge = deux tâches `kind='task'` du même collab dont les plages
 * `[start_date, end_date]` se chevauchent d'au moins UN jour. Les tâches sans
 * collaborateur sont ignorées (la charge n'est imputable à personne).
 *
 * Tri par `start_date` puis double boucle bornée (on coupe dès que `b.start >
 * a.end` car les intervalles sont triés). Complexité ≈ O(n²) au pire cas
 * (toutes les tâches sur le même collab et même plage), mais en pratique
 * O(n log n) — largement suffisant à l'échelle d'un projet.
 *
 * @param tasks  Toutes les tâches du projet (kind quelconque).
 * @returns      Une issue par PAIRE en conflit (pas par tâche).
 */
/**
 * v1.21 — Groupe les tâches `kind='task'` par collaborateur. Helper interne
 * utilisé par les détecteurs d'incohérences pour limiter la complexité
 * cognitive et factoriser le filtre commun.
 */
function groupTasksByCollab(tasks: Task[]): Map<string, Task[]> {
  const byCollab = new Map<string, Task[]>()
  for (const t of tasks) {
    if (t.kind !== 'task' || !t.collaborator_id) continue
    const arr = byCollab.get(t.collaborator_id) || []
    arr.push(t)
    byCollab.set(t.collaborator_id, arr)
  }
  return byCollab
}

/**
 * v1.21 — Recherche les surcharges au sein d'une liste de tâches du même
 * collaborateur, déjà triée par `start_date`. Le tri permet de couper la
 * boucle dès que la 2e tâche démarre après la fin de la 1re.
 */
function findOverloadPairs(list: Task[]): CoherenceIssue[] {
  const issues: CoherenceIssue[] = []
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]
      const b = list[j]
      if (b.start_date > a.end_date) break
      issues.push({
        kind: 'overload',
        severity: 'error',
        taskIds: [a.id, b.id],
        message: `Surcharge : « ${a.name} » et « ${b.name} » se chevauchent sur le même collaborateur.`,
      })
    }
  }
  return issues
}

function detectOverloads(tasks: Task[]): CoherenceIssue[] {
  const byCollab = groupTasksByCollab(tasks)
  const issues: CoherenceIssue[] = []
  for (const list of byCollab.values()) {
    list.sort((a, b) => a.start_date.localeCompare(b.start_date))
    issues.push(...findOverloadPairs(list))
  }
  return issues
}

/**
 * v1.21 — Détecte les violations de la contrainte de prédécesseur : une tâche
 * dont la date de début est strictement antérieure à la fin de son prédécesseur
 * (lag stocké ignoré ici — on signale juste l'incohérence brute, charge à
 * « Replan » de la corriger). Le DAL serveur réaligne normalement la start
 * sur pred.end_date lors d'un PATCH avec start_date, mais si la base est dans
 * un état hérité d'une ancienne version (ou modifié hors API) on reste robuste.
 *
 * @param tasks  Toutes les tâches du projet.
 * @returns      Une issue par tâche en violation.
 */
function detectPredecessorViolations(tasks: Task[]): CoherenceIssue[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const issues: CoherenceIssue[] = []
  for (const t of tasks) {
    if (t.kind === 'phase' || !t.predecessor_id) continue
    const pred = byId.get(t.predecessor_id)
    if (!pred) continue
    if (t.start_date < pred.end_date) {
      issues.push({
        kind: 'predecessor',
        severity: 'error',
        taskIds: [t.id, pred.id],
        message: `Prédécesseur : « ${t.name} » commence le ${t.start_date}, avant la fin de « ${pred.name} » (${pred.end_date}).`,
      })
    }
  }
  return issues
}

/**
 * v1.21 — Détecte les violations de PRIORITÉ entre tâches d'un même
 * collaborateur. Règle : si A et B partagent un collaborateur et ont chacune
 * une priorité saisie (1..5), la moins prioritaire (priorité numérique la
 * plus grande) ne doit pas commencer AVANT la plus prioritaire.
 *
 * Hypothèses pour limiter le bruit :
 *   • on ne flague que lorsque les DEUX tâches ont une priorité explicite
 *     (`priority != null`) — pour les couples « priorisé vs non priorisé »,
 *     l'arbitrage est laissé à l'utilisateur (la convention de tri du replan
 *     les considère équivalent à priority=6) ;
 *   • on ne flague que lorsque les priorités diffèrent strictement ;
 *   • les jalons et phases sont ignorés (ils n'ont pas de priorité).
 *
 * @param tasks  Toutes les tâches du projet.
 * @returns      Une issue par paire en violation.
 */
/**
 * v1.21 — Détecte la violation de priorité entre 2 tâches d'un même
 * collaborateur, sous la convention « priorité numérique la plus basse =
 * la plus prioritaire ». Renvoie `null` quand la paire est saine.
 */
function priorityIssueForPair(a: Task, b: Task): CoherenceIssue | null {
  if (a.priority == null || b.priority == null) return null
  if (a.priority === b.priority) return null
  const high = a.priority < b.priority ? a : b
  const low = high === a ? b : a
  if (low.start_date >= high.start_date) return null
  return {
    kind: 'priority',
    severity: 'warning',
    taskIds: [high.id, low.id],
    message: `Priorité : « ${low.name} » (P${low.priority}) commence avant « ${high.name} » (P${high.priority}), plus prioritaire.`,
  }
}

function detectPriorityViolations(tasks: Task[]): CoherenceIssue[] {
  // Filtre dès le départ pour ne garder que les tâches avec priorité saisie.
  const prioritized = tasks.filter(
    (t) => t.kind === 'task' && t.collaborator_id && t.priority != null,
  )
  const byCollab = new Map<string, Task[]>()
  for (const t of prioritized) {
    const arr = byCollab.get(t.collaborator_id as string) || []
    arr.push(t)
    byCollab.set(t.collaborator_id as string, arr)
  }
  const issues: CoherenceIssue[] = []
  for (const list of byCollab.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const issue = priorityIssueForPair(list[i], list[j])
        if (issue) issues.push(issue)
      }
    }
  }
  return issues
}

/**
 * v1.21 — Audit de cohérence du projet : agrège toutes les règles métier en
 * une liste d'incohérences à afficher dans un bandeau au-dessus du planning.
 *
 * Fonction PURE et déterministe : aucune mutation, aucun appel réseau. Conçue
 * pour être appelée à chaque changement de tâches (drag, save, polling) — la
 * complexité reste largement sous la milliseconde sur des projets de quelques
 * centaines de tâches.
 *
 * Règles auditées :
 *   • `overload`    (erreur)    : 2 tâches d'un même collaborateur qui se
 *                                 chevauchent ;
 *   • `predecessor` (erreur)    : tâche démarrant avant la fin de son
 *                                 prédécesseur ;
 *   • `priority`    (warning)   : tâche moins prioritaire devançant une plus
 *                                 prioritaire sur un même collaborateur.
 *
 * @param tasks  Toutes les tâches du projet (kind quelconque).
 * @returns      Liste plate d'incohérences ; vide = projet cohérent.
 */
/**
 * v1.24 — Détecte les violations de la contrainte SNET « Ne doit pas démarrer
 * avant le ». Pour chaque activité ou jalon ayant une date de démarrage au plus tôt saisie, on
 * compare sa date de début à la date de démarrage au plus tôt snappée au jour ouvré suivant.
 * Si `start_date < not_before_date_snapped`, on lève une incohérence rouge
 * (erreur bloquante logique, à corriger via Replan ou édition manuelle).
 *
 * Les phases sont ignorées (leurs dates sont synthétisées depuis les enfants ;
 * la règle SNET ne s'applique pas).
 *
 * @param tasks  Toutes les tâches du projet.
 * @returns      Une issue par tâche en violation.
 */
function detectNotBeforeViolations(tasks: Task[]): CoherenceIssue[] {
  const issues: CoherenceIssue[] = []
  for (const t of tasks) {
    if (t.kind === 'phase' || !t.not_before_date) continue
    const snapped = snapForwardToWorkingDay(t.not_before_date)
    if (t.start_date < snapped) {
      issues.push({
        kind: 'not_before',
        severity: 'error',
        taskIds: [t.id],
        message: `« Ne doit pas démarrer avant le » : « ${t.name} » commence le ${t.start_date}, avant la date de démarrage au plus tôt (${snapped}).`,
      })
    }
  }
  return issues
}

/**
 * v2.0 / F4 — Détecte les tâches dont la date de fin calculée dépasse leur
 * contrainte FNLT (« Fin au plus tard »). Severity = `warning` (non bloquant,
 * cf. décision utilisateur Q5) — l'utilisateur garde la main, l'alerte sert
 * juste à attirer l'attention pour replan ou négociation.
 *
 * Les phases sont ignorées (jamais de FNLT). Les jalons sont inclus :
 * `end_date === start_date`, donc on compare la date du jalon à la FNLT.
 *
 * @param tasks  Toutes les tâches du projet.
 * @returns      Une issue par tâche en dépassement.
 */
function detectFnltOverruns(tasks: Task[]): CoherenceIssue[] {
  const issues: CoherenceIssue[] = []
  for (const t of tasks) {
    if (t.kind === 'phase' || !t.not_later_than_date) continue
    if (t.end_date > t.not_later_than_date) {
      issues.push({
        kind: 'fnlt_overrun',
        severity: 'warning',
        taskIds: [t.id],
        message: `« Fin au plus tard » dépassée : « ${t.name} » se termine le ${t.end_date} (deadline ${t.not_later_than_date}).`,
      })
    }
  }
  return issues
}

export function checkCoherence(tasks: Task[]): CoherenceIssue[] {
  return [
    ...detectOverloads(tasks),
    ...detectPredecessorViolations(tasks),
    ...detectPriorityViolations(tasks),
    ...detectNotBeforeViolations(tasks),
    ...detectFnltOverruns(tasks),
  ]
}

/**
 * v1.21 — Calcule l'ensemble des tâches « concernées » par une liste
 * d'incohérences = tâches directement impliquées + tous leurs descendants
 * (enfants de phases) + tous leurs successeurs transitifs (chaîne
 * `predecessor_id`). Sert au « Replan partiel » : on ne déplace que ces
 * tâches-là, le reste du planning est verrouillé.
 *
 * @param issues  Issues issues de `checkCoherence`.
 * @param tasks   Liste complète des tâches du projet.
 * @returns       Set d'ids à passer à `replanTasks(tasks, concernedIds)`.
 */
/**
 * v1.21 — Indexe les ids des successeurs par prédécesseur. Helper interne
 * pour `concernedTaskIds`.
 */
function indexSuccessorsByPredecessor(tasks: Task[]): Map<string, string[]> {
  const byPred = new Map<string, string[]>()
  for (const t of tasks) {
    if (!t.predecessor_id) continue
    const arr = byPred.get(t.predecessor_id) || []
    arr.push(t.id)
    byPred.set(t.predecessor_id, arr)
  }
  return byPred
}

/**
 * v1.21 — BFS sur le graphe `successors` à partir d'un ensemble initial,
 * en ajoutant chaque successeur visité à `out`. Borné pour éviter toute
 * boucle infinie en cas de cycle (anormal mais on protège).
 */
function expandSuccessors(
  out: Set<string>,
  successors: Map<string, string[]>,
  cap: number,
): void {
  const queue = [...out]
  let safety = cap
  while (queue.length > 0 && safety-- > 0) {
    const id = queue.shift() as string
    for (const succId of successors.get(id) || []) {
      if (out.has(succId)) continue
      out.add(succId)
      queue.push(succId)
    }
  }
}

export function concernedTaskIds(
  issues: CoherenceIssue[],
  tasks: Task[],
): Set<string> {
  const out = new Set<string>()
  for (const i of issues) {
    for (const id of i.taskIds) out.add(id)
  }
  expandSuccessors(
    out,
    indexSuccessorsByPredecessor(tasks),
    tasks.length * tasks.length + 1,
  )
  // Descendants (enfants des phases concernées). Une phase n'est jamais
  // directement déplaçable, mais ses enfants doivent rester libres si la
  // phase elle-même est mentionnée.
  for (const t of tasks) {
    if (t.parent_id && out.has(t.parent_id)) out.add(t.id)
  }
  return out
}

/**
 * Calcule l'ensemble des descendants d'une tâche (enfants + petits-enfants…).
 * Utilisé côté UI pour empêcher de choisir un descendant comme prédécesseur
 * (ce qui créerait un cycle).
 *
 * @param taskId  Id de la tâche racine.
 * @param tasks   Liste complète des tâches.
 * @returns       Set des ids descendants (n'inclut PAS taskId lui-même).
 */
export function descendantIds(taskId: string, tasks: Task[]): Set<string> {
  const out = new Set<string>()
  // Index parent_id → enfants directs.
  const childrenOf = new Map<string, Task[]>()
  for (const t of tasks) {
    if (!t.parent_id) continue
    const arr = childrenOf.get(t.parent_id) || []
    arr.push(t)
    childrenOf.set(t.parent_id, arr)
  }
  function walk(id: string) {
    for (const child of childrenOf.get(id) || []) {
      if (out.has(child.id)) continue
      out.add(child.id)
      walk(child.id)
    }
  }
  walk(taskId)
  return out
}
