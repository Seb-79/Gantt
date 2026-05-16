// =============================================================================
// COMPOSANT WorkloadChart — Gantt v1.16
// =============================================================================
// Vue "Plan de charge" : pour chaque collaborateur (1 ligne) et chaque jour
// de la fenêtre temporelle (1 colonne), affiche la charge cumulée du jour
// avec un code couleur calqué sur le projet plan-de-charge :
//
//   • > 1   → rouge   (SURCHARGE — 2 tâches le même jour ou +)
//   • = 1   → vert    (journée pleine)
//   • > 0   → bleu plus ou moins marqué (sous-charge)
//   • = 0   → neutre  (pas de tâche)
//
// La structure visuelle (colonne gauche fixe + calendrier scrollable +
// header mois/jours-ou-semaines) reproduit celle de GanttChart, pour que
// l'utilisateur retrouve les mêmes repères en switchant d'onglet.
//
// Hypothèse de charge (v1.16) : un collaborateur affecté à une tâche est
// occupé à 100 % chaque jour ouvré que dure cette tâche.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addDaysIso,
  buildDateRange,
  computeWorkload,
  daysBetweenIso,
  groupByMonth,
  groupByWeek,
  isWeekendDay,
  workloadCellStyle,
} from '../lib/utils'
import { useHorizontalPan } from '../lib/useHorizontalPan'
import type { Collaborator, Task } from '../lib/types'

/** Hauteur d'une ligne (px) — alignée sur la vue Gantt pour la cohérence. */
const ROW_HEIGHT = 26

/**
 * Seuil de zoom (px par jour) sous lequel la 2e ligne du header passe en
 * numéros de semaine ISO (cf. GanttChart) — synchronisé pour cohérence.
 */
const WEEK_HEADER_THRESHOLD = 12

interface Props {
  /** Bornes du calendrier (incluses), au format YYYY-MM-DD. */
  windowStart: string
  windowEnd: string
  /** Largeur d'un jour en pixels (zoom). */
  dayWidth: number
  /** Tâches du projet courant (tous kinds confondus). */
  tasks: Task[]
  /** Collaborateurs visibles (1 ligne par collab, même sans tâche). */
  collaborators: Collaborator[]
  /**
   * v1.17 — Si `true`, met en évidence les sous-charges (`sum < 1` sur les
   * jours ouvrés) avec une palette jaune (cellule libre = jaune pâle,
   * charge partielle = jaune appuyé). Par défaut `false` (palette bleue).
   */
  highlightUnderload?: boolean
  /**
   * v1.19 — Callback de décalage de la fenêtre temporelle (jours signés),
   * activé quand l'utilisateur drag-glisse à la souris sur le panneau du
   * plan de charge. Même sémantique que dans GanttChart.
   */
  onShiftWindow?: (days: number) => void
}

/**
 * Composant de visualisation du plan de charge. N'effectue aucun appel
 * réseau : prend tout en props (mêmes que GanttChart, sans les callbacks
 * d'édition).
 */
export default function WorkloadChart({
  windowStart,
  windowEnd,
  dayWidth,
  tasks,
  collaborators,
  highlightUnderload = false,
  onShiftWindow,
}: Props) {
  // v1.19 — Pan horizontal à la souris (cf. useHorizontalPan).
  const { onMouseDown: handlePanMouseDown, isPanning } = useHorizontalPan(
    dayWidth,
    onShiftWindow,
  )
  // v1.19 — Curseur du panneau scrollable. Extrait pour éviter un ternaire
  // imbriqué dans le JSX (cf. sonarjs/no-nested-conditional).
  let panCursorClass = ''
  if (onShiftWindow)
    panCursorClass = isPanning ? 'cursor-grabbing' : 'cursor-grab'
  // -------------------------------------------------------------------------
  // Mesure de la largeur visible (cf. GanttChart v1.12) pour étendre la
  // grille au dézoom max et combler la zone droite.
  // -------------------------------------------------------------------------
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [panelWidth, setPanelWidth] = useState(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setPanelWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setPanelWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const effectiveEndIso = useMemo(() => {
    const naturalDays = daysBetweenIso(windowStart, windowEnd) + 1
    if (panelWidth === 0 || dayWidth === 0) return windowEnd
    const minDaysToFill = Math.ceil(panelWidth / dayWidth)
    if (minDaysToFill <= naturalDays) return windowEnd
    return addDaysIso(windowStart, minDaysToFill - 1)
  }, [windowStart, windowEnd, panelWidth, dayWidth])

  const dates = useMemo(
    () => buildDateRange(windowStart, effectiveEndIso),
    [windowStart, effectiveEndIso],
  )
  const months = useMemo(() => groupByMonth(dates), [dates])
  const showWeekHeader = dayWidth < WEEK_HEADER_THRESHOLD
  const weeks = useMemo(
    () => (showWeekHeader ? groupByWeek(dates) : []),
    [dates, showWeekHeader],
  )

  /** Largeur totale du calendrier en pixels. */
  const totalWidth = dates.length * dayWidth

  /**
   * Charge par collaborateur (Map id → tableau aligné sur `dates`).
   * Recalcul seulement quand `tasks`, `collaborators` ou `dates` changent.
   */
  const workload = useMemo(
    () => computeWorkload(tasks, collaborators, dates),
    [tasks, collaborators, dates],
  )

  /**
   * Collaborateurs triés par `position` (cohérent avec la liste partout
   * ailleurs). On garde même ceux sans charge pour visualiser les
   * disponibilités.
   */
  const orderedCollabs = useMemo(
    () => [...collaborators].sort((a, b) => a.position - b.position),
    [collaborators],
  )

  return (
    <div
      className="gantt-no-select flex border border-slate-300 bg-white rounded-lg overflow-hidden shadow-sm"
      data-testid="workload-chart"
    >
      {/* ------------------------------------------------------------------ */}
      {/* COLONNE GAUCHE — pastilles collaborateurs                           */}
      {/* ------------------------------------------------------------------ */}
      <div className="shrink-0 w-52 border-r border-slate-300 bg-slate-50">
        <div className="h-14 border-b border-slate-300 flex items-center px-2 font-semibold text-slate-700 text-xs">
          Collaborateurs
        </div>
        {orderedCollabs.length === 0 ? (
          <div className="text-xs text-slate-500 italic px-2 py-2">
            Aucun collaborateur défini.
          </div>
        ) : (
          orderedCollabs.map((c) => (
            <div
              key={c.id}
              className="flex items-center border-b border-slate-200 px-2 text-xs"
              style={{ height: ROW_HEIGHT }}
              title={c.name}
            >
              {/* Pastille de couleur du collaborateur (cohérente avec la
                  pastille affichée à droite du libellé des tâches). */}
              <span
                className="inline-block w-2.5 h-2.5 rounded-full mr-2 shrink-0"
                style={{ backgroundColor: c.color }}
                aria-hidden="true"
              />
              <span className="truncate flex-1">{c.name}</span>
            </div>
          ))
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* COLONNE DROITE — calendrier scrollable + grille de charge           */}
      {/* ------------------------------------------------------------------ */}
      {/* v1.19 — onMouseDown : pan horizontal de la fenêtre temporelle. */}
      <div
        ref={scrollRef}
        onMouseDown={handlePanMouseDown}
        className={['flex-1 overflow-x-auto', panCursorClass].join(' ')}
      >
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

          {/* HEADER ligne 2 — jours OU semaines (selon zoom) */}
          {showWeekHeader ? (
            <div className="flex h-7 border-b border-slate-300 bg-slate-50">
              {weeks.map((w, i) => (
                <div
                  key={i}
                  className="flex items-center justify-center text-[10px] text-slate-600 border-r border-slate-300"
                  style={{ width: w.span * dayWidth }}
                  title={`Semaine ${w.label.slice(1)}`}
                >
                  {w.label}
                </div>
              ))}
            </div>
          ) : (
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
          )}

          {/* CORPS — grille des charges (1 ligne par collab × 1 cellule/jour) */}
          <div className="relative">
            {orderedCollabs.map((c) => {
              const loads = workload.get(c.id) ?? []
              return (
                <div
                  key={c.id}
                  className="flex border-b border-slate-100"
                  style={{ height: ROW_HEIGHT }}
                >
                  {dates.map((d, i) => {
                    const sum = loads[i] ?? 0
                    const weekend = isWeekendDay(d)
                    // Le week-end est non-travaillé : on grise sans afficher
                    // de chiffre, même si une tâche couvre ce jour-là.
                    const cellClasses = weekend
                      ? 'bg-slate-50 text-slate-300'
                      : workloadCellStyle(sum, highlightUnderload)
                    // Format affiché : entier "1", "2" ; sinon on n'écrit
                    // rien (les 0 restent visuellement neutres). On évite
                    // un ternaire imbriqué pour rester sonar-friendly.
                    const sumLabel = Number.isInteger(sum)
                      ? String(sum)
                      : sum.toFixed(2)
                    const label = weekend || sum === 0 ? '' : sumLabel
                    return (
                      <div
                        key={i}
                        className={[
                          'flex items-center justify-center text-[10px] font-medium border-r border-slate-100',
                          cellClasses,
                        ].join(' ')}
                        style={{ width: dayWidth }}
                        title={
                          weekend
                            ? `${c.name} — ${d.toLocaleDateString('fr-FR')} (week-end)`
                            : `${c.name} — ${d.toLocaleDateString('fr-FR')} : ${sum} j`
                        }
                      >
                        {label}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
