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

import { useEffect, useMemo, useState } from 'react'
import {
  addDaysIso,
  addWorkingDays,
  buildDateRange,
  dateToX,
  daysBetweenIso,
  descendantIds,
  effectiveTaskColor,
  groupByMonth,
  isWeekendDay,
  rangeToWidth,
  snapBackwardToWorkingDay,
  snapForwardToWorkingDay,
  workingDaysBetween,
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
  /**
   * v1.9 — Callback de redimensionnement / déplacement d'une barre dans
   * le planning (drag sur la barre, kind='task' uniquement).
   * Reçoit un patch contenant `start_date` et/ou `end_date` ; toutes les
   * dates renvoyées tombent sur un jour ouvré (week-ends sautés).
   *
   * @param taskId  Id de la tâche déplacée.
   * @param patch   { start_date?, end_date? } à appliquer.
   */
  onResizeTask?: (
    taskId: string,
    patch: { start_date?: string; end_date?: string },
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
  onResizeTask,
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

  // Profondeur hiérarchique de chaque tâche (racine = 0). Utilisée pour
  // indenter visuellement les sous-phases / activités sur plusieurs niveaux.
  const depthById = useMemo(() => {
    const byId = new Map<string, Task>()
    for (const t of tasks) byId.set(t.id, t)
    const cache = new Map<string, number>()
    function depth(id: string): number {
      const cached = cache.get(id)
      if (cached !== undefined) return cached
      const t = byId.get(id)
      if (!t || !t.parent_id || !byId.has(t.parent_id)) {
        cache.set(id, 0)
        return 0
      }
      const d = depth(t.parent_id) + 1
      cache.set(id, d)
      return d
    }
    for (const t of tasks) depth(t.id)
    return cache
  }, [tasks])

  /** Largeur totale du calendrier en pixels. */
  const totalWidth = dates.length * dayWidth

  // -------------------------------------------------------------------------
  // v1.9 — État du drag des barres dans le planning
  // -------------------------------------------------------------------------
  /**
   * Drag d'une barre dans la zone calendrier : soit déplace la tâche vers
   * la droite (mode 'move' : start_date avance, durée constante en jours
   * ouvrés), soit étend sa fin (mode 'resize-end' : end_date avance).
   * Le drag est contraint à aller vers la droite (deltaDays ≥ 0).
   */
  const [resizing, setResizing] = useState<null | {
    taskId: string
    mode: 'move' | 'resize-end'
    startX: number
    origStart: string
    origEnd: string
    deltaDays: number
  }>(null)

  // Écoute mousemove / mouseup au niveau document tant qu'un drag est actif.
  // Sortie via useEffect pour pouvoir détacher proprement (et éviter les
  // fuites d'event listeners). Ne se déclenche pas si onResizeTask est absent.
  useEffect(() => {
    if (!resizing) return
    /** Met à jour deltaDays au fil du mouvement de la souris. */
    function onMove(e: MouseEvent) {
      if (!resizing) return
      const rawDelta = (e.clientX - resizing.startX) / dayWidth
      let delta = Math.round(rawDelta)
      if (resizing.mode === 'move') {
        // Spec : le DÉPLACEMENT par le corps de la barre se fait uniquement
        // vers la droite (impossible de remonter dans le passé par geste).
        delta = Math.max(0, delta)
      } else {
        // Spec v1.9 — Le redimensionnement de la fin peut aller dans les
        // DEUX sens : à droite pour allonger, à gauche pour raccourcir.
        // Borne inférieure : new_end >= start_date (au moins 1 jour de barre).
        const minDelta = -daysBetweenIso(resizing.origStart, resizing.origEnd)
        delta = Math.max(minDelta, delta)
      }
      if (delta !== resizing.deltaDays) {
        setResizing({ ...resizing, deltaDays: delta })
      }
    }
    /** Au relâchement, applique la modification si delta != 0. */
    function onUp() {
      if (!resizing) return
      const r = resizing
      if (r.deltaDays !== 0 && onResizeTask) {
        if (r.mode === 'move') {
          // Conserve la charge (durée en jours ouvrés) : on recalcule end_date
          // à partir du nouveau start aligné sur un jour ouvré.
          const charge = Math.max(1, workingDaysBetween(r.origStart, r.origEnd))
          const newStart = snapForwardToWorkingDay(
            addDaysIso(r.origStart, r.deltaDays),
          )
          const newEnd = addWorkingDays(newStart, charge)
          onResizeTask(r.taskId, {
            start_date: newStart,
            end_date: newEnd,
          })
        } else {
          // resize-end : seule la fin bouge. Snap selon le sens du drag :
          //   • delta > 0 (allongement) → jour ouvré suivant
          //   • delta < 0 (raccourcissement) → jour ouvré précédent
          // (sinon, raccourcir et tomber sur un samedi rallongerait au lundi
          //  d'après, ce qui contrarie le geste de l'utilisateur).
          const target = addDaysIso(r.origEnd, r.deltaDays)
          let newEnd =
            r.deltaDays < 0
              ? snapBackwardToWorkingDay(target)
              : snapForwardToWorkingDay(target)
          // Clamp final : new_end ne peut pas descendre sous start_date.
          if (newEnd < r.origStart) newEnd = r.origStart
          if (newEnd !== r.origEnd) {
            onResizeTask(r.taskId, { end_date: newEnd })
          }
        }
      }
      setResizing(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [resizing, dayWidth, onResizeTask])

  /**
   * v1.9 — Démarre un drag sur une barre de tâche. Détecte le mode
   * (déplacement vs redimensionnement de la fin) selon que la souris est
   * proche du bord droit (zone de poignée ≈ 8 px).
   *
   * @param e     Événement souris (mousedown sur la barre).
   * @param task  Tâche concernée (déjà filtrée sur kind='task').
   */
  function handleBarMouseDown(e: React.MouseEvent<HTMLDivElement>, task: Task) {
    if (!onResizeTask) return
    const rect = e.currentTarget.getBoundingClientRect()
    const distFromRight = rect.right - e.clientX
    const mode: 'move' | 'resize-end' =
      distFromRight <= 8 ? 'resize-end' : 'move'
    setResizing({
      taskId: task.id,
      mode,
      startX: e.clientX,
      origStart: task.start_date,
      origEnd: task.end_date,
      deltaDays: 0,
    })
    e.preventDefault()
    e.stopPropagation()
  }

  // -------------------------------------------------------------------------
  // v1.5 — État du drag & drop hiérarchique (colonne gauche)
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
          const indent = (depthById.get(t.id) ?? 0) * 16
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

                {/* Barre de tâche OU jalon OU phase.
                    v1.9 — Pour kind='task', on rend une barre interactive
                    (drag = move ou resize-end) ; les autres types restent
                    statiques via `renderBar`. */}
                {t.kind === 'task'
                  ? renderInteractiveTaskBar(
                      t,
                      windowStart,
                      dayWidth,
                      collabById,
                      resizing,
                      handleBarMouseDown,
                      !!onResizeTask,
                    )
                  : renderBar(t, windowStart, dayWidth, collabById)}
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
        if (x2 >= x1 + offset) {
          // Cas normal : le successeur démarre suffisamment à droite.
          // Forme en escalier : droite → vertical → droite (arrive par la gauche).
          if (Math.abs(y1 - y2) < 1) {
            d = `M ${x1} ${y1} L ${x2} ${y2}`
          } else {
            d = `M ${x1} ${y1} L ${x1 + offset} ${y1} L ${x1 + offset} ${y2} L ${x2} ${y2}`
          }
        } else {
          // Le successeur commence AVANT ou JUSTE après la fin du prédécesseur
          // (typiquement quand les activités s'enchaînent end-to-start). On
          // contourne par-dessus/dessous pour arriver par la gauche du
          // successeur, sinon la flèche se replierait sur elle-même.
          const backOffset = Math.max(offset, dayWidth)
          if (Math.abs(y1 - y2) < 1) {
            // Même ligne mais successeur "derrière" : petit détour vertical.
            const midY = y1 + ROW_HEIGHT / 2
            d =
              `M ${x1} ${y1} L ${x1 + offset} ${y1} L ${x1 + offset} ${midY} ` +
              `L ${x2 - backOffset} ${midY} L ${x2 - backOffset} ${y2} L ${x2} ${y2}`
          } else {
            // Forme en U/Z : on remonte/descend à mi-chemin entre les deux
            // lignes, puis on revient sur la gauche du successeur.
            const midY = (y1 + y2) / 2
            d =
              `M ${x1} ${y1} L ${x1 + offset} ${y1} L ${x1 + offset} ${midY} ` +
              `L ${x2 - backOffset} ${midY} L ${x2 - backOffset} ${y2} L ${x2} ${y2}`
          }
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

/**
 * v1.9 — Rend une barre de tâche INTERACTIVE :
 *   • Clic-glisser sur le corps → déplace la tâche vers la droite
 *     (start_date avance, durée constante en jours ouvrés).
 *   • Clic-glisser sur le bord droit (poignée 8 px) → étend la tâche
 *     (end_date avance, charge augmente).
 *   • Drag uniquement vers la DROITE (cohérent avec la spec : on n'avance
 *     pas dans le passé par geste).
 *   • Preview visuel pendant le drag : la barre se décale / s'allonge
 *     en temps réel (snap au jour), et l'opacité diminue.
 *
 * Le calcul des nouvelles dates et l'appel API sont délégués au composant
 * parent via `onResizeTask` (capturé dans le state `resizing`).
 *
 * @param task           La tâche (kind='task' garanti par le caller).
 * @param windowStart    Borne gauche du calendrier (YYYY-MM-DD).
 * @param dayWidth       Largeur d'un jour en pixels.
 * @param collabById     Map id → collaborateur (pour résoudre les couleurs).
 * @param resizing       État courant du drag (null = pas de drag).
 * @param onMouseDown    Handler à appeler au mousedown sur la barre.
 * @param enabled        true si le drag est actif (onResizeTask fourni).
 */
function renderInteractiveTaskBar(
  task: Task,
  windowStart: string,
  dayWidth: number,
  collabById: Map<string, Collaborator>,
  resizing: {
    taskId: string
    mode: 'move' | 'resize-end'
    deltaDays: number
  } | null,
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>, task: Task) => void,
  enabled: boolean,
) {
  const color = effectiveTaskColor(task, Array.from(collabById.values()))
  const baseLeft = dateToX(task.start_date, windowStart, dayWidth)
  const baseWidth = rangeToWidth(task.start_date, task.end_date, dayWidth)

  // Offset visuel pendant un drag actif sur CETTE tâche : décale la barre
  // (mode='move') ou allonge sa fin (mode='resize-end'). Ne touche pas les
  // autres tâches.
  const active = resizing && resizing.taskId === task.id ? resizing : null
  const previewOffset =
    active && active.mode === 'move' ? active.deltaDays * dayWidth : 0
  const previewExtraWidth =
    active && active.mode === 'resize-end' ? active.deltaDays * dayWidth : 0

  // Curseur adapté : indique la sémantique du drag selon la zone.
  // (Le mousemove avec un curseur custom n'est pas trivial sans listener
  //  global ; on se contente d'un curseur unique sur la barre.)
  const cursor = enabled ? 'grab' : 'pointer'

  return (
    <div
      className="absolute rounded shadow-sm overflow-hidden flex items-center"
      style={{
        left: baseLeft + previewOffset,
        top: 4,
        width: baseWidth + previewExtraWidth,
        height: ROW_HEIGHT - 8,
        backgroundColor: color + '33', // 20% d'opacité — fond clair
        border: `1px solid ${color}`,
        cursor,
        opacity: active ? 0.6 : 1,
        // Empêche la sélection de texte / drag natif HTML5 pendant le drag.
        userSelect: 'none',
      }}
      title={
        enabled
          ? `${task.name} — ${task.start_date} → ${task.end_date} (${task.progress}%)\nGlisser : décaler ; glisser le bord droit : allonger.`
          : `${task.name} — ${task.start_date} → ${task.end_date} (${task.progress}%)`
      }
      onMouseDown={enabled ? (e) => onMouseDown(e, task) : undefined}
    >
      {/* Barre de progression */}
      <div
        className="absolute inset-y-0 left-0 pointer-events-none"
        style={{
          width: `${task.progress}%`,
          backgroundColor: color,
          opacity: 0.7,
        }}
      />
      {/* Libellé interne (visible si la barre est assez large) */}
      {baseWidth + previewExtraWidth > 60 && (
        <span className="relative px-2 text-[11px] font-medium text-slate-800 truncate pointer-events-none">
          {task.name}
        </span>
      )}
      {/* Poignée de redimensionnement (bord droit, 6 px) — visible uniquement
          si le drag est activé. Curseur dédié pour signaler la zone. */}
      {enabled && (
        <div
          className="absolute top-0 right-0 h-full"
          style={{
            width: 6,
            cursor: 'ew-resize',
            // Léger fond au survol pour rendre la poignée découvrable.
            background:
              'linear-gradient(to right, transparent, rgba(0,0,0,0.08))',
          }}
          aria-hidden="true"
        />
      )}
    </div>
  )
}
