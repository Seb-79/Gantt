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

import { useEffect, useMemo, useRef, useState } from 'react'
import { format, parseISO } from 'date-fns'
import {
  addDaysIso,
  addWorkingDays,
  buildDateRange,
  dateToX,
  daysBetweenIso,
  descendantIds,
  effectiveTaskColor,
  groupByMonth,
  groupByWeek,
  isFrenchHoliday,
  isNonWorkingDay,
  rangeToWidth,
  snapBackwardToWorkingDay,
  snapForwardToWorkingDay,
  workingDaysBetween,
} from '../lib/utils'
import { useHorizontalPan } from '../lib/useHorizontalPan'
import type { Collaborator, Task } from '../lib/types'

/**
 * v1.11 — Formatte une date ISO 'YYYY-MM-DD' en libellé court 'dd/MM'
 * (sans l'année), pour l'affichage discret des bornes des barres dans
 * le planning.
 *
 * @param iso  Date ISO YYYY-MM-DD.
 * @returns    Chaîne au format 'dd/MM' (ex. '16/05').
 */
function formatShortDate(iso: string): string {
  return format(parseISO(iso), 'dd/MM')
}

/**
 * Zone de drop calculée selon la position verticale du curseur dans la
 * ligne cible (3 zones successives). Détermine la sémantique du déplacement.
 */
type DropZone = 'before' | 'inside' | 'after'

/**
 * v1.21 — Forme commune d'un drag actif sur une barre. Extrait au module
 * pour pouvoir typer les helpers `applyMoveDrag` / `applyResizeEndDrag` sans
 * les coupler à l'état React du composant.
 */
type ActiveResize = {
  task: Task
  mode: 'move' | 'resize-end'
  startX: number
  origStart: string
  origEnd: string
  deltaDays: number
}

/**
 * v1.21 — Applique un drag en mode `move` : décale start ET end de la même
 * quantité de jours ouvrés (la charge est préservée). Snap selon le sens du
 * geste pour ne pas annuler une fraction du mouvement quand on traverse un
 * week-end.
 *
 * @param r       État actif du drag.
 * @param notify  Callback de remontée vers le parent (PATCH dates).
 */
function applyMoveDrag(
  r: ActiveResize,
  notify: (
    id: string,
    patch: { start_date?: string; end_date?: string },
  ) => void,
) {
  const charge = Math.max(1, workingDaysBetween(r.origStart, r.origEnd))
  const target = addDaysIso(r.origStart, r.deltaDays)
  const newStart =
    r.deltaDays < 0
      ? snapBackwardToWorkingDay(target)
      : snapForwardToWorkingDay(target)
  const newEnd = addWorkingDays(newStart, charge)
  notify(r.task.id, { start_date: newStart, end_date: newEnd })
}

/**
 * v1.21 — Applique un drag en mode `resize-end` : seule la fin bouge. Snap
 * selon le sens du geste, puis clampe à `start_date` pour garantir au moins
 * 1 jour de barre.
 *
 * @param r       État actif du drag.
 * @param notify  Callback de remontée vers le parent (PATCH end_date).
 */
function applyResizeEndDrag(
  r: ActiveResize,
  notify: (
    id: string,
    patch: { start_date?: string; end_date?: string },
  ) => void,
) {
  const target = addDaysIso(r.origEnd, r.deltaDays)
  let newEnd =
    r.deltaDays < 0
      ? snapBackwardToWorkingDay(target)
      : snapForwardToWorkingDay(target)
  if (newEnd < r.origStart) newEnd = r.origStart
  if (newEnd !== r.origEnd) notify(r.task.id, { end_date: newEnd })
}

/**
 * Hauteur fixe d'une ligne (px) — synchronisée colonne gauche / barres.
 * v1.15 — Réduite de 32 → 26 px pour densifier la liste des tâches. La
 * barre interne (top:4, height: ROW_HEIGHT - 8 = 18 px) reste largement
 * suffisante pour le texte text-[11px], et le losange des jalons s'adapte
 * automatiquement (min/max bornés sur dayWidth).
 */
const ROW_HEIGHT = 26

/**
 * v1.14 — Seuil (px par jour) en dessous duquel la ligne 2 du header
 * passe en numéros de semaine au lieu des numéros de jour. À `dayWidth < 12`,
 * les chiffres se chevauchent (cf. captures utilisateur) ; au-dessus, on
 * conserve l'affichage jour-par-jour.
 */
const WEEK_HEADER_THRESHOLD = 12

interface Props {
  /** Bornes du calendrier (incluses), au format YYYY-MM-DD. */
  windowStart: string
  windowEnd: string
  /** Largeur d'un jour en pixels (zoom). */
  dayWidth: number
  /** Tâches à afficher (déjà ordonnées, déjà filtrées des phases repliées). */
  tasks: Task[]
  /**
   * v1.20 — Liste COMPLÈTE des tâches (incl. celles cachées par le repli).
   * Utilisée pour décider si une phase doit afficher un chevron (= a au moins
   * un enfant dans les données, même s'il est actuellement masqué). Si non
   * fournie, on retombe sur `tasks` (les phases sans enfant ne montrent pas
   * de chevron).
   */
  allTasks?: Task[]
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
  /**
   * v1.11 — Si true, affiche discrètement les dates de début et de fin
   * de chaque barre (format 'dd/MM', sans l'année). Pour les jalons,
   * seule la date du jalon est affichée.
   */
  showDates?: boolean
  /**
   * v1.13 — Si true (par défaut), écrit le nom de la tâche à l'intérieur
   * de la barre (quand celle-ci est assez large). Mettre à false pour
   * obtenir un planning purement graphique (barres + couleurs sans texte).
   */
  showBarNames?: boolean
  /**
   * v1.19 — Callback de décalage de la fenêtre temporelle (jours signés).
   * Si fourni, le panneau du planning accepte un drag-pan à la souris
   * (« grab & pull » : drag droite → passé, drag gauche → futur). Si
   * absent, le panneau reste statique (boutons de navigation seuls).
   */
  onShiftWindow?: (days: number) => void
  /**
   * v1.20 — Set d'ids de phases actuellement repliées (info purement
   * visuelle, utilisée par l'App pour filtrer `tasks`). Le composant s'en
   * sert pour afficher le bon glyphe de chevron (▼ déplié / ▶ replié).
   */
  collapsedPhases?: Set<string>
  /**
   * v1.20 — Callback appelé lorsqu'on clique sur le chevron d'une phase.
   * Si non fourni, le chevron est masqué (la fonctionnalité de repli est
   * désactivée).
   */
  onToggleCollapse?: (phaseId: string) => void
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
  allTasks,
  collaborators,
  onTaskClick,
  onMoveTask,
  onResizeTask,
  showDates = false,
  showBarNames = true,
  onShiftWindow,
  collapsedPhases,
  onToggleCollapse,
}: Props) {
  // v1.20 — Set des ids de phases ayant au moins UN enfant (direct ou non).
  // Calculé sur `allTasks` (= liste complète) pour ne pas perdre l'info quand
  // une phase est repliée (ses enfants sont alors absents de `tasks`).
  // Sert à n'afficher le chevron QUE sur les phases vraiment pliables.
  const phasesWithChildren = useMemo(() => {
    const src = allTasks ?? tasks
    const set = new Set<string>()
    for (const t of src) {
      if (t.parent_id) set.add(t.parent_id)
    }
    return set
  }, [allTasks, tasks])
  // v1.19 — Pan horizontal à la souris (cf. useHorizontalPan). Branché sur
  // le panneau scrollable de droite. Mousedown sur une BARRE est intercepté
  // par handleBarMouseDown via stopPropagation → aucune collision avec le
  // drag de redimensionnement existant.
  const { onMouseDown: handlePanMouseDown, isPanning } = useHorizontalPan(
    dayWidth,
    onShiftWindow,
  )
  // v1.19 — Curseur du panneau scrollable selon le contexte du pan :
  // « grab » au repos, « grabbing » pendant un drag actif, vide si l'app
  // n'a pas fourni de callback (pas de pan activé). Extrait pour éviter
  // un ternaire imbriqué dans le JSX (cf. sonarjs/no-nested-conditional).
  let panCursorClass = ''
  if (onShiftWindow)
    panCursorClass = isPanning ? 'cursor-grabbing' : 'cursor-grab'
  // -------------------------------------------------------------------------
  // v1.12 — Mesure de la largeur visible du panneau droit (scroll container)
  // -------------------------------------------------------------------------
  // Quand on dézoome au maximum, `dates.length * dayWidth` peut devenir plus
  // petit que la largeur du panneau (ex. 720 px de chart sur 1700 px
  // disponibles), laissant un grand vide à droite. Pour combler ce vide
  // visuellement, on étend la fenêtre RENDUE jusqu'à atteindre la largeur du
  // panneau — sans modifier l'état du parent : la navigation manuelle (« / »)
  // reste pilotée par windowStart/windowEnd, et le `windowFromTasks` initial
  // n'est pas perturbé.
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

  /**
   * Date de fin "effective" : au moins `windowEnd`, étendue si nécessaire
   * pour que la grille remplisse la largeur visible du panneau.
   */
  const effectiveEndIso = useMemo(() => {
    // +1 car windowEnd est inclus dans la plage rendue (cf. buildDateRange).
    const naturalDays = daysBetweenIso(windowStart, windowEnd) + 1
    if (panelWidth === 0 || dayWidth === 0) return windowEnd
    const minDaysToFill = Math.ceil(panelWidth / dayWidth)
    if (minDaysToFill <= naturalDays) return windowEnd
    return addDaysIso(windowStart, minDaysToFill - 1)
  }, [windowStart, windowEnd, panelWidth, dayWidth])

  // Précalcul de la liste des jours et des groupes de mois (recalcul uniquement
  // si la fenêtre temporelle effective change).
  const dates = useMemo(
    () => buildDateRange(windowStart, effectiveEndIso),
    [windowStart, effectiveEndIso],
  )
  const months = useMemo(() => groupByMonth(dates), [dates])

  // v1.14 — Bascule jours ↔ semaines pour la 2e ligne du header.
  const showWeekHeader = dayWidth < WEEK_HEADER_THRESHOLD
  const weeks = useMemo(
    () => (showWeekHeader ? groupByWeek(dates) : []),
    [dates, showWeekHeader],
  )

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
  // v1.19.2 — Stocke la tâche elle-même (et plus seulement son id) pour
  // pouvoir résoudre le « clic sans drag » (deltaDays === 0) au mouseup
  // et appeler onTaskClick(task) sans avoir à relire `tasks` au moment
  // de l'événement (fiabilise face aux changements concurrents).
  const [resizing, setResizing] = useState<ActiveResize | null>(null)

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
        // v1.21 — Le déplacement par le corps de la barre est désormais BIDIRECTIONNEL :
        // l'utilisateur peut tirer la tâche dans le passé (delta < 0). Les
        // règles métier (prédécesseurs, charge, priorités) ne sont plus
        // verrouillées au moment du geste mais détectées a posteriori par
        // `checkCoherence` et signalées dans le bandeau d'alerte au-dessus
        // du planning. « Replan » (complet ou partiel) permet ensuite de
        // restaurer la cohérence à la demande.
        // Pas de clamp : delta reste signé.
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
    /**
     * v1.19.2 — Au relâchement :
     *   • si la souris n'a pas bougé d'au moins 1 jour (deltaDays === 0)
     *     → c'est un CLIC simple sur la barre → ouvre l'éditeur via
     *       onTaskClick (cohérent avec le clic dans la colonne gauche).
     *   • sinon → applique le déplacement / redimensionnement via onResizeTask.
     */
    function onUp() {
      if (!resizing) return
      const r = resizing
      if (r.deltaDays === 0) {
        onTaskClick?.(r.task)
      } else if (onResizeTask) {
        if (r.mode === 'move') applyMoveDrag(r, onResizeTask)
        else applyResizeEndDrag(r, onResizeTask)
      }
      setResizing(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [resizing, dayWidth, onResizeTask, onTaskClick])

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
      task,
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
      {/* v1.11 — Largeur compactée (w-52 = 208px, contre w-72 = 288px avant)
          pour libérer de l'espace au profit du planning. Les paddings
          internes (px-2 / pl: 8+indent) sont resserrés en cohérence. */}
      <div className="shrink-0 w-52 border-r border-slate-300 bg-slate-50">
        {/* Header (2 lignes pour matcher la hauteur du header de droite) */}
        <div className="h-14 border-b border-slate-300 flex items-center px-2 font-semibold text-slate-700 text-xs">
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
                'relative flex items-center border-b border-slate-200 px-2 text-xs cursor-pointer',
                isDragged ? 'opacity-40' : 'hover:bg-slate-100',
                hover === 'inside' ? 'bg-blue-50' : '',
              ].join(' ')}
              // v1.19.3 — paddingLeft de base réduit de 8 → 2 px pour
              // récupérer de la place à gauche de la colonne Tâches. L'incrément
              // d'indentation (16 px par niveau) reste inchangé pour conserver
              // une hiérarchie visible.
              style={{ height: ROW_HEIGHT, paddingLeft: 2 + indent }}
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
              {/* v1.20 — Pour les phases :
                  - Si elle a au moins un enfant ET que le parent expose
                    `onToggleCollapse` → on remplace 🗂️ par un chevron
                    cliquable (▼ déplié / ▶ replié).
                  - Sinon → on garde le 🗂️ informatif (phase sans enfant
                    ou fonctionnalité de repli désactivée). */}
              {t.kind === 'phase' &&
                (onToggleCollapse && phasesWithChildren.has(t.id) ? (
                  <button
                    type="button"
                    className="text-slate-600 hover:text-slate-900 mr-1 leading-none text-[10px] select-none"
                    title={collapsedPhases?.has(t.id) ? 'Déplier' : 'Replier'}
                    aria-label={
                      collapsedPhases?.has(t.id) ? 'Déplier' : 'Replier'
                    }
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      // Empêche l'ouverture de l'éditeur ET le démarrage
                      // d'un drag-row sur la ligne (poignée ⋮⋮).
                      e.stopPropagation()
                      onToggleCollapse(t.id)
                    }}
                  >
                    {collapsedPhases?.has(t.id) ? '▶' : '▼'}
                  </button>
                ) : (
                  <span className="text-slate-700 mr-1" title="Phase">
                    🗂️
                  </span>
                ))}
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
                  className="ml-1.5 text-[10px] px-1 py-0.5 rounded text-white shrink-0"
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
      {/* v1.12 — ref pour mesurer la largeur visible et combler le vide à
          droite lorsqu'on dézoome au maximum (cf. effectiveEndIso).
          v1.19 — onMouseDown branché sur ce panneau pour le pan souris ;
          les barres consomment leur mousedown via stopPropagation. */}
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

          {/* HEADER ligne 2 — jours OU semaines (v1.14, selon zoom) */}
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
              {dates.map((d, i) => {
                // v1.23 — Les jours fériés français reçoivent un tooltip
                // explicite et le même fond grisé que les week-ends pour
                // rester un signal visuel cohérent (= jour non ouvré).
                const holiday = isFrenchHoliday(d)
                const nonWorking = isNonWorkingDay(d)
                return (
                  <div
                    key={i}
                    className={[
                      'flex items-center justify-center text-[10px] border-r border-slate-200',
                      nonWorking
                        ? 'bg-slate-200 text-slate-500'
                        : 'text-slate-600',
                    ].join(' ')}
                    style={{ width: dayWidth }}
                    title={holiday ? 'Jour férié (France)' : undefined}
                  >
                    {d.getDate()}
                  </div>
                )
              })}
            </div>
          )}

          {/* CORPS — grille + barres.
              v1.19 — Calque SVG des flèches RENDU EN PREMIER → arrière-plan.
              Les barres et étiquettes de dates (rendues ensuite) le couvrent,
              éliminant les chevauchements illisibles entre dates et flèches. */}
          <div className="relative">
            <PredecessorArrows
              tasks={tasks}
              windowStart={windowStart}
              dayWidth={dayWidth}
              totalWidth={totalWidth}
            />
            {tasks.map((t) => (
              <div
                key={t.id}
                className="relative border-b border-slate-100"
                style={{ height: ROW_HEIGHT }}
              >
                {/* v1.23 — Fond grisé pour les jours NON OUVRÉS : week-ends
                    ET jours fériés français (cohérence visuelle avec la grille
                    du header). */}
                <div className="absolute inset-0 flex pointer-events-none">
                  {dates.map((d, i) => (
                    <div
                      key={i}
                      className={isNonWorkingDay(d) ? 'bg-slate-50' : ''}
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
                      showDates,
                      showBarNames,
                    )
                  : renderBar(
                      t,
                      windowStart,
                      dayWidth,
                      collabById,
                      showDates,
                      showBarNames,
                      // v1.19.2 — onTaskClick : jalon/phase deviennent cliquables
                      // dans le planning (cohérent avec le clic sur la barre
                      // tâche et avec le clic dans la colonne gauche).
                      onTaskClick,
                    )}
              </div>
            ))}
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
      // v1.19.2 — z-index 1 : place le SVG AU-DESSUS des éléments « auto »
      // (cellules week-end grises, barre dark des phases) tout en restant
      // SOUS les barres de tâches (z-index 2) et les étiquettes de dates
      // (z-index 3). Résultat : la flèche est visible quand elle traverse
      // une phase ou une colonne week-end, sans masquer les libellés.
      style={{ zIndex: 1 }}
      width={totalWidth}
      height={tasks.length * ROW_HEIGHT}
    >
      <defs>
        {/* v1.19.3 — Marker en `userSpaceOnUse` : taille fixée en pixels
            indépendamment de strokeWidth (sinon la pointe est multipliée par
            le strokeWidth=2, donnant un triangle de 16 px de côté trop gros).
            Nouvelles dimensions : 8 × 6 px (au lieu de 16 × 16). */}
        <marker
          id="gantt-arrow"
          markerUnits="userSpaceOnUse"
          markerWidth="8"
          markerHeight="6"
          refX="7"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L8,3 L0,6 Z" fill="#475569" />
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
            // v1.19.2 — slate-600 + 2 px : visible sur les colonnes WE grises
            // et au-dessus des barres de phase (cf. zIndex SVG = 1).
            stroke="#475569"
            strokeWidth="2"
            fill="none"
            markerEnd="url(#gantt-arrow)"
          />
        )
      })}
    </svg>
  )
}

/**
 * v1.11 — Petites étiquettes de dates discrètes positionnées juste à
 * l'extérieur des bords gauche / droit d'une barre. Format 'dd/MM'
 * (jour/mois sans année). Rendues comme un fragment de spans
 * absolument positionnés, à intégrer directement dans la `div` de la
 * ligne (qui est en `position: relative`).
 *
 * v1.19 — Possibilité de masquer la date de début (`hideStart`) : utilisé
 * pour les tâches avec prédécesseur, où la date de début se superpose à
 * la pointe de flèche entrante ET fait doublon avec la date de fin du
 * prédécesseur déjà affichée. La flèche reste l'indicateur visuel suffisant.
 *
 * @param leftPx    Position X (px) du bord gauche de la barre.
 * @param widthPx   Largeur (px) de la barre.
 * @param startIso  Date de début ISO de la tâche.
 * @param endIso    Date de fin ISO de la tâche.
 * @param single    true → n'affiche qu'une seule date (jalon, à droite).
 * @param hideStart true → n'affiche que la date de fin (cas des tâches avec
 *                  prédécesseur ; la flèche fait l'indicateur de début).
 */
function renderDateLabels(
  leftPx: number,
  widthPx: number,
  startIso: string,
  endIso: string,
  single = false,
  hideStart = false,
) {
  // v1.19 — Style noir gras sur fond blanc semi-opaque : reste lisible
  // au-dessus des cellules week-end grisées ET au-dessus des flèches
  // prédécesseur qui passent désormais SOUS les barres (cf. PredecessorArrows
  // déplacé avant la map des tâches). Le fond mini-pill masque le segment
  // de flèche qui croise l'étiquette, supprimant le chevauchement illisible
  // signalé en v1.18.
  const baseStyle: React.CSSProperties = {
    position: 'absolute',
    top: ROW_HEIGHT / 2 - 7,
    fontSize: 10,
    lineHeight: '14px',
    fontWeight: 600,
    color: '#0f172a', // slate-900
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    background: 'rgba(255,255,255,0.92)',
    padding: '0 3px',
    borderRadius: 2,
    // v1.19.2 — z-index 3 : au-dessus des barres (2) et des flèches (1).
    zIndex: 3,
  }
  return (
    <>
      {!single && !hideStart && (
        <span
          style={{
            ...baseStyle,
            // Aligné à droite contre le bord gauche de la barre.
            left: leftPx - 4,
            transform: 'translateX(-100%)',
          }}
        >
          {formatShortDate(startIso)}
        </span>
      )}
      <span
        style={{
          ...baseStyle,
          left: leftPx + widthPx + 4,
        }}
      >
        {formatShortDate(endIso)}
      </span>
    </>
  )
}

/**
 * Rend la représentation visuelle d'une tâche : barre rectangulaire avec
 * progress bar interne, ou losange pour un jalon.
 *
 * v1.19.2 — Ajout du `onTaskClick` : phases et jalons deviennent cliquables
 * dans le planning (les tâches sont gérées via `renderInteractiveTaskBar`).
 * Sur ces deux types, on stoppe la propagation du mousedown pour éviter
 * que le pan souris (cf. useHorizontalPan branché sur le panneau parent)
 * ne se déclenche en parallèle.
 *
 * @param task         La tâche à rendre.
 * @param windowStart  Borne gauche du calendrier (YYYY-MM-DD).
 * @param dayWidth     Largeur d'un jour en pixels.
 * @param collabById   Map id → collaborateur (pour résoudre les couleurs).
 * @param showDates    v1.11 — Si true, ajoute les libellés de dates (dd/MM).
 * @param showBarNames v1.13 — Si true, écrit le nom de la tâche dans la barre.
 * @param onTaskClick  v1.19.2 — Callback ouverture de l'éditeur sur clic.
 */
function renderBar(
  task: Task,
  windowStart: string,
  dayWidth: number,
  collabById: Map<string, Collaborator>,
  showDates: boolean,
  showBarNames: boolean,
  onTaskClick?: (task: Task) => void,
) {
  // v1.19.2 — Handlers communs aux phases et jalons pour ouvrir l'éditeur
  // au clic ET empêcher que le mousedown ne démarre un pan parent.
  const stopMouseDown = (e: React.MouseEvent) => e.stopPropagation()
  const handleClick = () => onTaskClick?.(task)
  const color = effectiveTaskColor(task, Array.from(collabById.values()))
  const left = dateToX(task.start_date, windowStart, dayWidth)

  // v1.6 — Phase : barre épaisse foncée avec petits chevrons aux
  // extrémités (style "bracket") pour bien la distinguer des activités.
  if (task.kind === 'phase') {
    const width = rangeToWidth(task.start_date, task.end_date, dayWidth)
    return (
      <>
        <div
          // v1.19.2 — Plus de pointer-events-none : la phase doit recevoir le
          // clic pour ouvrir l'éditeur. On stoppe le mousedown pour ne pas
          // déclencher de pan parent (cf. useHorizontalPan).
          className="absolute cursor-pointer"
          onClick={handleClick}
          onMouseDown={stopMouseDown}
          style={{
            left,
            top: ROW_HEIGHT / 2 - 5,
            width,
            height: 10,
          }}
          title={`Phase « ${task.name} » — ${task.start_date} → ${task.end_date} — cliquer pour modifier`}
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
        {/* v1.19 — Pas de labels de dates sur les phases : elles sont
            auto-calculées depuis les enfants (= déjà affichées sur les
            barres enfant), et la 1re/dernière date de la phase coïncide
            visuellement avec celle de son 1er/dernier enfant juste en
            dessous, créant un doublon illisible (cf. capture v1.19). */}
      </>
    )
  }

  if (task.kind === 'milestone') {
    // Losange centré sur la date du jalon.
    const size = Math.max(12, Math.min(20, dayWidth - 2))
    const diamondLeft = left + dayWidth / 2 - size / 2
    return (
      <>
        <div
          // v1.19.2 — Cliquable pour ouvrir l'éditeur. stopMouseDown évite
          // d'amorcer un pan parent.
          className="absolute cursor-pointer"
          onClick={handleClick}
          onMouseDown={stopMouseDown}
          style={{
            left: diamondLeft,
            top: (ROW_HEIGHT - size) / 2,
            width: size,
            height: size,
            backgroundColor: color,
            transform: 'rotate(45deg)',
            borderRadius: 2,
            // v1.19.2 — au-dessus du SVG flèches (1) comme les barres tâches.
            zIndex: 2,
          }}
          title={`${task.name} — ${task.start_date} — cliquer pour modifier`}
        />
        {/* v1.11 — Jalon : une seule date (start == end), à droite du losange. */}
        {showDates &&
          renderDateLabels(
            diamondLeft,
            size,
            task.start_date,
            task.start_date,
            true,
          )}
      </>
    )
  }

  const width = rangeToWidth(task.start_date, task.end_date, dayWidth)
  return (
    <>
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
        {showBarNames && width > 60 && (
          <span className="relative px-2 text-[11px] font-medium text-slate-800 truncate">
            {task.name}
          </span>
        )}
      </div>
      {showDates &&
        renderDateLabels(
          left,
          width,
          task.start_date,
          task.end_date,
          false,
          // v1.19 — Masque la date de début si la tâche a un prédécesseur :
          // évite la collision avec la pointe de flèche entrante et le doublon
          // avec la date de fin du prédécesseur.
          !!task.predecessor_id,
        )}
    </>
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
 * @param showDates      v1.11 — Affiche les dates de début/fin (dd/MM).
 * @param showBarNames   v1.13 — Écrit le nom de la tâche dans la barre.
 */
function renderInteractiveTaskBar(
  task: Task,
  windowStart: string,
  dayWidth: number,
  collabById: Map<string, Collaborator>,
  resizing: {
    task: Task
    mode: 'move' | 'resize-end'
    deltaDays: number
  } | null,
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>, task: Task) => void,
  enabled: boolean,
  showDates: boolean,
  showBarNames: boolean,
) {
  const color = effectiveTaskColor(task, Array.from(collabById.values()))
  const baseLeft = dateToX(task.start_date, windowStart, dayWidth)
  const baseWidth = rangeToWidth(task.start_date, task.end_date, dayWidth)

  // Offset visuel pendant un drag actif sur CETTE tâche : décale la barre
  // (mode='move') ou allonge sa fin (mode='resize-end'). Ne touche pas les
  // autres tâches.
  const active = resizing && resizing.task.id === task.id ? resizing : null
  const previewOffset =
    active && active.mode === 'move' ? active.deltaDays * dayWidth : 0
  const previewExtraWidth =
    active && active.mode === 'resize-end' ? active.deltaDays * dayWidth : 0

  // Curseur adapté : indique la sémantique du drag selon la zone.
  // (Le mousemove avec un curseur custom n'est pas trivial sans listener
  //  global ; on se contente d'un curseur unique sur la barre.)
  const cursor = enabled ? 'grab' : 'pointer'

  return (
    <>
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
          // v1.19.2 — z-index 2 : au-dessus du SVG flèches (1) pour que la
          // barre cache la flèche qui passerait derrière, et sous les
          // étiquettes de dates (3).
          zIndex: 2,
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
        {showBarNames && baseWidth + previewExtraWidth > 60 && (
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
      {/* v1.11 — Dates de début/fin discrètes à l'extérieur des bords. Pendant
          un drag, on suit le preview pour qu'elles bougent en cohérence.
          v1.19 — Cache la date de début pour les tâches avec prédécesseur
          (évite collision avec la flèche entrante + doublon avec pred.end). */}
      {showDates &&
        renderDateLabels(
          baseLeft + previewOffset,
          baseWidth + previewExtraWidth,
          task.start_date,
          task.end_date,
          false,
          !!task.predecessor_id,
        )}
    </>
  )
}
