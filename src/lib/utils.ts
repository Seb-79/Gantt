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
