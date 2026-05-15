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
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
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
