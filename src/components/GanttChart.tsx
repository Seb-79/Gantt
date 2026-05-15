// =============================================================================
// COMPOSANT GanttChart — Gantt v1
// =============================================================================
// Affiche le calendrier (header avec mois + jours) et les barres de tâches /
// jalons positionnées en pixels selon `dayWidth` (zoom).
//
// Architecture :
//   • Colonne gauche fixe : libellé des tâches + collaborateur affecté
//   • Colonne droite scrollable : grille du calendrier + barres
//
// Les positions/largeurs sont calculées via les helpers purs de utils.ts
// (testables séparément).
// =============================================================================

import { useMemo } from 'react'
import {
  buildDateRange,
  dateToX,
  effectiveTaskColor,
  groupByMonth,
  isWeekendDay,
  rangeToWidth,
} from '../lib/utils'
import type { Collaborator, Task } from '../lib/types'

/** Hauteur fixe d'une ligne (px) — synchronisée colonne gauche / barres. */
const ROW_HEIGHT = 32

interface Props {
  /** Bornes du calendrier (incluses), au format YYYY-MM-DD. */
  windowStart: string
  windowEnd: string
  /** Largeur d'un jour en pixels (zoom). */
  dayWidth: number
  /** Tâches à afficher (déjà ordonnées). */
  tasks: Task[]
  /** Collaborateurs (pour résoudre les couleurs et noms). */
  collaborators: Collaborator[]
  /** Callback lors du clic sur une ligne (édition). */
  onTaskClick?: (task: Task) => void
}

/**
 * Composant principal du Gantt. N'effectue aucun appel réseau : prend tout
 * en props et délègue les actions au parent via `onTaskClick`.
 */
export default function GanttChart({
  windowStart,
  windowEnd,
  dayWidth,
  tasks,
  collaborators,
  onTaskClick,
}: Props) {
  // Précalcul de la liste des jours et des groupes de mois (recalcul uniquement
  // si la fenêtre temporelle change).
  const dates = useMemo(
    () => buildDateRange(windowStart, windowEnd),
    [windowStart, windowEnd],
  )
  const months = useMemo(() => groupByMonth(dates), [dates])

  // Index collaborateurs par id pour lookup O(1).
  const collabById = useMemo(() => {
    const map = new Map<string, Collaborator>()
    for (const c of collaborators) map.set(c.id, c)
    return map
  }, [collaborators])

  /** Largeur totale du calendrier en pixels. */
  const totalWidth = dates.length * dayWidth

  return (
    <div
      className="gantt-no-select flex border border-slate-300 bg-white rounded-lg overflow-hidden shadow-sm"
      data-testid="gantt-chart"
    >
      {/* ------------------------------------------------------------------ */}
      {/* COLONNE GAUCHE — libellés des tâches                                */}
      {/* ------------------------------------------------------------------ */}
      <div className="shrink-0 w-72 border-r border-slate-300 bg-slate-50">
        {/* Header (2 lignes pour matcher la hauteur du header de droite) */}
        <div className="h-14 border-b border-slate-300 flex items-center px-3 font-semibold text-slate-700 text-sm">
          Tâches
        </div>
        {tasks.map((t) => {
          const collab = t.collaborator_id
            ? collabById.get(t.collaborator_id)
            : null
          const indent = t.parent_id ? 16 : 0
          return (
            <div
              key={t.id}
              className="flex items-center border-b border-slate-200 px-3 text-sm hover:bg-slate-100 cursor-pointer"
              style={{ height: ROW_HEIGHT, paddingLeft: 12 + indent }}
              onClick={() => onTaskClick?.(t)}
              title={t.name}
            >
              {t.kind === 'milestone' && (
                <span className="text-amber-500 mr-1">◆</span>
              )}
              <span className="truncate flex-1">{t.name}</span>
              {collab && (
                <span
                  className="ml-2 text-xs px-1.5 py-0.5 rounded text-white shrink-0"
                  style={{ backgroundColor: collab.color }}
                >
                  {collab.name}
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* COLONNE DROITE — calendrier scrollable                              */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 overflow-x-auto">
        <div style={{ width: totalWidth }}>
          {/* HEADER ligne 1 — mois */}
          <div className="flex h-7 border-b border-slate-200 bg-slate-100">
            {months.map((m) => (
              <div
                key={m.label}
                className="flex items-center justify-center text-xs font-semibold text-slate-700 border-r border-slate-300 capitalize"
                style={{ width: m.span * dayWidth }}
              >
                {m.label}
              </div>
            ))}
          </div>

          {/* HEADER ligne 2 — jours */}
          <div className="flex h-7 border-b border-slate-300 bg-slate-50">
            {dates.map((d, i) => (
              <div
                key={i}
                className={[
                  'flex items-center justify-center text-[10px] border-r border-slate-200',
                  isWeekendDay(d)
                    ? 'bg-slate-200 text-slate-500'
                    : 'text-slate-600',
                ].join(' ')}
                style={{ width: dayWidth }}
              >
                {d.getDate()}
              </div>
            ))}
          </div>

          {/* CORPS — grille + barres */}
          <div className="relative">
            {tasks.map((t) => (
              <div
                key={t.id}
                className="relative border-b border-slate-100"
                style={{ height: ROW_HEIGHT }}
              >
                {/* Fond — colonnes weekend grisées */}
                <div className="absolute inset-0 flex pointer-events-none">
                  {dates.map((d, i) => (
                    <div
                      key={i}
                      className={isWeekendDay(d) ? 'bg-slate-50' : ''}
                      style={{ width: dayWidth }}
                    />
                  ))}
                </div>

                {/* Barre de tâche OU jalon */}
                {renderBar(t, windowStart, dayWidth, collabById)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Rend la représentation visuelle d'une tâche : barre rectangulaire avec
 * progress bar interne, ou losange pour un jalon.
 *
 * @param task         La tâche à rendre.
 * @param windowStart  Borne gauche du calendrier (YYYY-MM-DD).
 * @param dayWidth     Largeur d'un jour en pixels.
 * @param collabById   Map id → collaborateur (pour résoudre les couleurs).
 */
function renderBar(
  task: Task,
  windowStart: string,
  dayWidth: number,
  collabById: Map<string, Collaborator>,
) {
  const color = effectiveTaskColor(task, Array.from(collabById.values()))
  const left = dateToX(task.start_date, windowStart, dayWidth)

  if (task.kind === 'milestone') {
    // Losange centré sur la date du jalon.
    const size = Math.max(12, Math.min(20, dayWidth - 2))
    return (
      <div
        className="absolute"
        style={{
          left: left + dayWidth / 2 - size / 2,
          top: (ROW_HEIGHT - size) / 2,
          width: size,
          height: size,
          backgroundColor: color,
          transform: 'rotate(45deg)',
          borderRadius: 2,
        }}
        title={`${task.name} — ${task.start_date}`}
      />
    )
  }

  const width = rangeToWidth(task.start_date, task.end_date, dayWidth)
  return (
    <div
      className="absolute rounded shadow-sm overflow-hidden flex items-center"
      style={{
        left,
        top: 4,
        width,
        height: ROW_HEIGHT - 8,
        backgroundColor: color + '33', // 20% d'opacité — fond clair
        border: `1px solid ${color}`,
      }}
      title={`${task.name} — ${task.start_date} → ${task.end_date} (${task.progress}%)`}
    >
      {/* Barre de progression */}
      <div
        className="absolute inset-y-0 left-0"
        style={{
          width: `${task.progress}%`,
          backgroundColor: color,
          opacity: 0.7,
        }}
      />
      {/* Libellé interne (visible si la barre est assez large) */}
      {width > 60 && (
        <span className="relative px-2 text-[11px] font-medium text-slate-800 truncate">
          {task.name}
        </span>
      )}
    </div>
  )
}
