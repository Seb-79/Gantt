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
 * @param task           La tâche.
 * @param collaborators  Liste des collaborateurs disponibles.
 * @returns              Couleur hex à utiliser pour la barre.
 */
export function effectiveTaskColor(
  task: Task,
  collaborators: Collaborator[],
): string {
  if (task.color) return task.color
  if (task.collaborator_id) {
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

/**
 * v1.9 — Ajoute `charge` jours OUVRÉS à partir de startIso et renvoie la
 * date de fin (incluse). La date de début est comptée comme le 1er jour
 * ouvré si elle en est un ; les week-ends sont sautés.
 *
 * Exemples (start = lundi 18 mai 2026) :
 *   • charge=1 → 18 mai (un seul jour ouvré : le lundi)
 *   • charge=3 → 20 mai (lundi, mardi, mercredi)
 *   • charge=5 → 22 mai (lundi → vendredi)
 *   • charge=6 → 25 mai (lun→ven puis sauté sam/dim, lundi suivant)
 *
 * Si la date de début est elle-même un week-end, le décompte ne commence
 * qu'au 1er jour ouvré rencontré (la fin se retrouve alors décalée).
 *
 * @param startIso  Date de début YYYY-MM-DD.
 * @param charge    Nombre de jours ouvrés (≥ 1 ; toute valeur ≤ 1 vaut 1).
 * @returns         Date de fin YYYY-MM-DD (incluse).
 */
export function addWorkingDays(startIso: string, charge: number): string {
  // Charge ≤ 1 → 1 seul jour ouvré → fin = début (convention : 1 jour de
  // présence, même si start tombe un week-end on garde la date saisie pour
  // ne pas surprendre l'utilisateur).
  if (charge <= 1) return startIso
  let cur = isoToDate(startIso)
  // Si on démarre un jour ouvré, il compte pour 1 ; sinon 0.
  let count = isWeekendDay(cur) ? 0 : 1
  while (count < charge) {
    cur = addDays(cur, 1)
    if (!isWeekendDay(cur)) count++
  }
  return dateToIso(cur)
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
  return dateToIso(addDays(isoToDate(iso), days))
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
  let cur = isoToDate(iso)
  while (isWeekendDay(cur)) cur = addDays(cur, 1)
  return dateToIso(cur)
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
  let cur = isoToDate(iso)
  while (isWeekendDay(cur)) cur = addDays(cur, -1)
  return dateToIso(cur)
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
 * v1.10 — Calcule la date de début d'un successeur Y à partir de la fin
 * de son prédécesseur X et d'un délai (jours ouvrés).
 *   • lag = 0 → Y.start = X.end (ou jour ouvré suivant si X.end est un week-end)
 *   • lag = N → Y démarre N jours ouvrés APRÈS X.end
 *
 * Miroir exact de `computeSuccessorStart` côté serveur (db/index.js).
 *
 * @param predEnd  Date de fin du prédécesseur YYYY-MM-DD.
 * @param lag      Délai en jours ouvrés (≥ 0).
 * @returns        Date de début du successeur YYYY-MM-DD.
 */
export function computeSuccessorStart(predEnd: string, lag: number): string {
  const base = snapForwardToWorkingDay(predEnd)
  if (lag <= 0) return base
  return addWorkingDays(base, lag + 1)
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
  if (!startIso || !endIso || endIso < startIso) return 0
  const start = isoToDate(startIso)
  const n = differenceInCalendarDays(isoToDate(endIso), start) + 1
  let count = 0
  for (let i = 0; i < n; i++) {
    if (!isWeekendDay(addDays(start, i))) count++
  }
  return count
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
export function computeWorkload(
  tasks: Task[],
  collaborators: Collaborator[],
  dates: Date[],
): Map<string, number[]> {
  const result = new Map<string, number[]>()
  for (const c of collaborators) {
    result.set(c.id, new Array(dates.length).fill(0))
  }
  for (const t of tasks) {
    if (t.kind !== 'task' || !t.collaborator_id) continue
    const arr = result.get(t.collaborator_id)
    if (!arr) continue
    const start = isoToDate(t.start_date).getTime()
    const end = isoToDate(t.end_date).getTime()
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i]
      const ts = d.getTime()
      if (ts < start || ts > end) continue
      if (isWeekend(d)) continue
      arr[i] += 1
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

  /** Comparateur stable (priorité asc, puis position asc). */
  const cmp = (a: Task, b: Task) => {
    const pa = a.priority ?? 6
    const pb = b.priority ?? 6
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
): void {
  const charge = Math.max(1, workingDaysBetween(t.start_date, t.end_date))
  const earliest = computeReplanEarliestStart(t, tasksById, proposed)
  const intervals = t.collaborator_id
    ? timeline.get(t.collaborator_id) || []
    : []
  const newStart = t.collaborator_id
    ? findFreeSlot(intervals, earliest, charge)
    : earliest
  const newEnd = addWorkingDays(newStart, charge)
  proposed.set(t.id, { start: newStart, end: newEnd })
  if (t.collaborator_id) {
    pushTimelineInterval(timeline, t.collaborator_id, newStart, newEnd)
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
    if (t.kind !== 'task' || !t.collaborator_id) continue
    if (concernedIds.has(t.id)) continue
    pushTimelineInterval(timeline, t.collaborator_id, t.start_date, t.end_date)
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
    })
  }
  return moves
}

export function replanTasks(
  tasks: Task[],
  concernedIds?: Set<string>,
): ReplanMove[] {
  // v1.21 — `concernedIds` actif → replan PARTIEL : seules les tâches
  // listées peuvent voir leurs dates modifiées. Les autres sont LOCKÉES à
  // leurs dates actuelles ET ajoutées au timeline du collaborateur (=
  // obstacles à contourner). Si `concernedIds` est `undefined`, le replan
  // est COMPLET (comportement historique : toutes les tâches `task` sont
  // candidates au déplacement).
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
    placeTaskInTimeline(t, tasksById, proposed, timeline)
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

/** v1.21 — Catégorie d'incohérence détectée par `checkCoherence`. */
export type CoherenceIssueKind = 'overload' | 'predecessor' | 'priority'

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
export function checkCoherence(tasks: Task[]): CoherenceIssue[] {
  return [
    ...detectOverloads(tasks),
    ...detectPredecessorViolations(tasks),
    ...detectPriorityViolations(tasks),
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
