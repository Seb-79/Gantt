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

import { useMemo, useState } from 'react'
import {
  buildDateRange,
  dateToX,
  descendantIds,
  effectiveTaskColor,
  groupByMonth,
  isWeekendDay,
  rangeToWidth,
} from '../lib/utils'
import type { Collaborator, Task } from '../lib/types'

/**
 * Zone de drop calculée selon la position verticale du curseur dans la
 * ligne cible (3 zones successives). Détermine la sémantique du déplacement.
 */
type DropZone = 'before' | 'inside' | 'after'

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
  /**
   * v1.5 — Callback de déplacement par drag & drop dans la colonne gauche.
   * @param draggedId    Id de la tâche déplacée.
   * @param parentId     Nouveau parent (null = racine).
   * @param beforeId     Id du sibling avant lequel insérer (null = en fin).
   */
  onMoveTask?: (
    draggedId: string,
    parentId: string | null,
    beforeId: string | null,
  ) => void
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
  onMoveTask,
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

  // -------------------------------------------------------------------------
  // v1.5 — État du drag & drop
  // -------------------------------------------------------------------------
  /** Id de la tâche actuellement en cours de drag (null = pas de drag). */
  const [draggedId, setDraggedId] = useState<string | null>(null)
  /** Indicateur visuel : { taskId, zone } ou null. */
  const [hoverDrop, setHoverDrop] = useState<{
    taskId: string
    zone: DropZone
  } | null>(null)

  /**
   * Calcule la zone de drop selon la position Y du curseur dans la ligne :
   * tiers haut → before, tiers milieu → inside, tiers bas → after.
   *
   * @param e        Événement React DragEvent.
   * @param el       Élément DOM de la ligne cible.
   * @returns        La zone détectée.
   */
  function computeDropZone(
    e: React.DragEvent<HTMLDivElement>,
    el: HTMLDivElement,
  ): DropZone {
    const rect = el.getBoundingClientRect()
    const ratio = (e.clientY - rect.top) / rect.height
    if (ratio < 0.33) return 'before'
    if (ratio > 0.66) return 'after'
    return 'inside'
  }

  /**
   * Gère le drop sur une ligne cible : calcule (parent_id, before_id)
   * selon la zone détectée et appelle onMoveTask.
   *
   * @param e        Événement React DragEvent.
   * @param target   Tâche cible sur laquelle on a déposé.
   * @param zone     Zone de drop ('before' | 'inside' | 'after').
   */
  function handleDrop(
    e: React.DragEvent<HTMLDivElement>,
    target: Task,
    zone: DropZone,
  ) {
    e.preventDefault()
    setHoverDrop(null)
    const id = e.dataTransfer.getData('text/plain')
    setDraggedId(null)
    if (!id || id === target.id || !onMoveTask) return
    // Anti-cycle côté UI : on ne pose pas dans ses propres descendants.
    if (descendantIds(id, tasks).has(target.id)) return

    if (zone === 'inside') {
      // Devenir enfant de la cible, en dernière position.
      onMoveTask(id, target.id, null)
      return
    }

    const newParent = target.parent_id
    if (zone === 'before') {
      onMoveTask(id, newParent, target.id)
    } else {
      // 'after' = juste après la cible = avant le sibling suivant.
      const idxInSiblings = tasks
        .filter((t) => t.parent_id === newParent && t.id !== id)
        .sort((a, b) => a.position - b.position)
        .findIndex((t) => t.id === target.id)
      const siblings = tasks
        .filter((t) => t.parent_id === newParent && t.id !== id)
        .sort((a, b) => a.position - b.position)
      const next = siblings[idxInSiblings + 1]
      onMoveTask(id, newParent, next ? next.id : null)
    }
  }

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
          const isDragged = draggedId === t.id
          const hover = hoverDrop?.taskId === t.id ? hoverDrop.zone : null
          // Une tâche ne peut pas accueillir un drop venant d'elle-même
          // ou de l'un de ses ancêtres ; on vérifie ici en utilisant la
          // tâche en cours de drag pour désactiver visuellement.
          const acceptsDrop =
            !!draggedId &&
            draggedId !== t.id &&
            !descendantIds(draggedId, tasks).has(t.id)
          return (
            <div
              key={t.id}
              draggable
              className={[
                'relative flex items-center border-b border-slate-200 px-3 text-sm cursor-pointer',
                isDragged ? 'opacity-40' : 'hover:bg-slate-100',
                hover === 'inside' ? 'bg-blue-50' : '',
              ].join(' ')}
              style={{ height: ROW_HEIGHT, paddingLeft: 12 + indent }}
              onClick={() => {
                // Ne pas ouvrir l'éditeur si on relâche un drag sur la même ligne.
                if (draggedId) return
                onTaskClick?.(t)
              }}
              title={t.name}
              onDragStart={(e) => {
                // dataTransfer = canal officiel pour transmettre l'id.
                // setData est obligatoire pour que Firefox accepte le drag.
                e.dataTransfer.setData('text/plain', t.id)
                e.dataTransfer.effectAllowed = 'move'
                setDraggedId(t.id)
              }}
              onDragEnd={() => {
                setDraggedId(null)
                setHoverDrop(null)
              }}
              onDragOver={(e) => {
                if (!acceptsDrop) return
                // Sans preventDefault, onDrop ne se déclenche pas.
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const zone = computeDropZone(e, e.currentTarget)
                setHoverDrop((h) =>
                  h?.taskId === t.id && h.zone === zone
                    ? h
                    : { taskId: t.id, zone },
                )
              }}
              onDragLeave={() => {
                setHoverDrop((h) => (h?.taskId === t.id ? null : h))
              }}
              onDrop={(e) => {
                if (!acceptsDrop) return
                const zone = computeDropZone(e, e.currentTarget)
                handleDrop(e, t, zone)
              }}
            >
              {/* Indicateurs visuels de drop (lignes bleues haut/bas) */}
              {hover === 'before' && (
                <span className="absolute inset-x-0 top-0 h-0.5 bg-blue-500 pointer-events-none" />
              )}
              {hover === 'after' && (
                <span className="absolute inset-x-0 bottom-0 h-0.5 bg-blue-500 pointer-events-none" />
              )}

              {/* Poignée de drag (visible au hover) */}
              <span
                className="text-slate-300 mr-1 select-none"
                aria-hidden="true"
                title="Glisser pour déplacer"
              >
                ⋮⋮
              </span>

              {t.kind === 'milestone' && (
                <span className="text-amber-500 mr-1">◆</span>
              )}
              {t.kind === 'phase' && (
                <span className="text-slate-700 mr-1" title="Phase">
                  🗂️
                </span>
              )}
              <span
                className={[
                  'truncate flex-1',
                  t.kind === 'phase' ? 'font-semibold text-slate-800' : '',
                ].join(' ')}
              >
                {t.name}
              </span>
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

                {/* Barre de tâche OU jalon OU phase */}
                {renderBar(t, windowStart, dayWidth, collabById)}
              </div>
            ))}

            {/* v1.6 — Calque SVG superposé pour tracer les flèches
                prédécesseur → successeur. pointer-events-none pour ne pas
                gêner le clic / drag sur les barres. */}
            <PredecessorArrows
              tasks={tasks}
              windowStart={windowStart}
              dayWidth={dayWidth}
              totalWidth={totalWidth}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * v1.6 — Calque SVG des flèches prédécesseur → successeur.
 *
 * Pour chaque tâche `T` ayant un prédécesseur `P`, trace une flèche
 * en forme de "L renversé" :
 *   • part de la fin de la barre de P (à droite)
 *   • descend / remonte verticalement jusqu'à la ligne de T
 *   • aboutit au début de la barre de T (à gauche), avec une tête de flèche
 *
 * Les indices y des tâches sont calculés à partir de leur ordre dans
 * `tasks` (qui doit être l'ordre d'affichage = ordre hiérarchique trié).
 */
function PredecessorArrows({
  tasks,
  windowStart,
  dayWidth,
  totalWidth,
}: {
  tasks: Task[]
  windowStart: string
  dayWidth: number
  totalWidth: number
}) {
  /** Renvoie la coordonnée X "fin" d'une tâche (côté droit de sa barre). */
  function endX(task: Task): number {
    if (task.kind === 'milestone') {
      // Jalon : centre du jour + demi-taille du losange.
      return dateToX(task.start_date, windowStart, dayWidth) + dayWidth / 2 + 8
    }
    return dateToX(task.end_date, windowStart, dayWidth) + dayWidth
  }

  /** Renvoie la coordonnée X "début" d'une tâche (côté gauche de sa barre). */
  function startX(task: Task): number {
    if (task.kind === 'milestone') {
      return dateToX(task.start_date, windowStart, dayWidth) + dayWidth / 2 - 8
    }
    return dateToX(task.start_date, windowStart, dayWidth)
  }

  // Index par id pour lookup O(1).
  const byId = new Map<string, { task: Task; row: number }>()
  tasks.forEach((t, row) => byId.set(t.id, { task: t, row }))

  return (
    <svg
      className="absolute top-0 left-0 pointer-events-none"
      width={totalWidth}
      height={tasks.length * ROW_HEIGHT}
    >
      <defs>
        <marker
          id="gantt-arrow"
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
        >
          <path d="M0,0 L8,4 L0,8 Z" fill="#94a3b8" />
        </marker>
      </defs>
      {tasks.map((t, i) => {
        if (!t.predecessor_id) return null
        const pred = byId.get(t.predecessor_id)
        if (!pred) return null
        const x1 = endX(pred.task)
        const y1 = pred.row * ROW_HEIGHT + ROW_HEIGHT / 2
        const x2 = startX(t)
        const y2 = i * ROW_HEIGHT + ROW_HEIGHT / 2
        // Petit décrochement pour ne pas coller à la barre.
        const offset = Math.max(6, Math.min(14, dayWidth))
        let d: string
        if (Math.abs(y1 - y2) < 1) {
          // Même ligne : ligne droite horizontale.
          d = `M ${x1} ${y1} L ${x2} ${y2}`
        } else {
          // Forme en L : avancer un peu, descendre, avancer jusqu'au successeur.
          d = `M ${x1} ${y1} L ${x1 + offset} ${y1} L ${x1 + offset} ${y2} L ${x2} ${y2}`
        }
        return (
          <path
            key={t.id}
            d={d}
            stroke="#94a3b8"
            strokeWidth="1.5"
            fill="none"
            markerEnd="url(#gantt-arrow)"
          />
        )
      })}
    </svg>
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

  // v1.6 — Phase : barre épaisse foncée avec petits chevrons aux
  // extrémités (style "bracket") pour bien la distinguer des activités.
  if (task.kind === 'phase') {
    const width = rangeToWidth(task.start_date, task.end_date, dayWidth)
    return (
      <div
        className="absolute pointer-events-none"
        style={{
          left,
          top: ROW_HEIGHT / 2 - 5,
          width,
          height: 10,
        }}
        title={`Phase « ${task.name} » — ${task.start_date} → ${task.end_date}`}
      >
        {/* Barre principale */}
        <div className="absolute inset-x-0 top-0 h-1.5 bg-slate-800 rounded-sm" />
        {/* Chevron gauche (triangle pointant vers le bas) */}
        <div
          className="absolute left-0 top-0"
          style={{
            width: 0,
            height: 0,
            borderLeft: '5px solid transparent',
            borderRight: '5px solid transparent',
            borderTop: '8px solid #1e293b', // slate-800
          }}
        />
        {/* Chevron droit */}
        <div
          className="absolute right-0 top-0"
          style={{
            width: 0,
            height: 0,
            borderLeft: '5px solid transparent',
            borderRight: '5px solid transparent',
            borderTop: '8px solid #1e293b',
          }}
        />
      </div>
    )
  }

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
