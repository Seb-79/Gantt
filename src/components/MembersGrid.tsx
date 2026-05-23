// =============================================================================
// COMPOSANT MembersGrid — Gantt v2.1 / F4
// =============================================================================
// Onglet « Affectation » refondu en grille calendaire (calquée sur
// WorkloadChart). Pour chaque collaborateur membre du projet, affiche le %
// d'allocation jour par jour. Le user peut :
//
//   • CLIQUER sur une case → cycle `vide → 25 → 50 → 75 → 100 → vide` (la
//     décision UX Q2 du brief). 1 commit serveur par clic.
//   • DRAGGER horizontalement → peint toutes les cases survolées de la même
//     ligne avec la valeur de la case de départ (Q1=A, Q2=écrasement,
//     Q3=horizontal seulement). 1 seul commit serveur au mouseup.
//   • Cliquer le bouton « + Période » → mini-formulaire inline pour saisir
//     une plage avec un % (cohérent avec le comportement legacy de l'onglet).
//
// Composant 100 % présentationnel :
//   • lit `memberAllocations` du projet courant pour afficher les pct,
//   • délègue toutes les mutations au parent via `onCommitChanges` (drag/clic)
//     et `onAddAllocation` (formulaire Période).
//
// Le parent (App.tsx) reçoit `onCommitChanges(collabId, changes)`, calcule le
// `AllocationRebuildPlan` via `rebuildAllocationsForCollab` puis exécute la
// série DELETE+POST côté API + refetch.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addDaysIso,
  buildDateRange,
  daysBetweenIso,
  groupByMonth,
  groupByWeek,
  isFrenchHoliday,
  isNonWorkingDay,
} from '../lib/utils'
import { useDragPaint } from '../lib/useDragPaint'
import { useHorizontalPan } from '../lib/useHorizontalPan'
import type { Collaborator, MemberAllocation } from '../lib/types'

/** Hauteur d'une ligne — synchronisée avec WorkloadChart/GanttChart. */
const ROW_HEIGHT = 26

/** Seuil de zoom (px par jour) sous lequel le header passe en semaines ISO. */
const WEEK_HEADER_THRESHOLD = 12

/** Cycle des paliers d'allocation pour le clic / drag. */
const PCT_CYCLE = [0, 25, 50, 75, 100] as const

/** Choix de % pour le mini-formulaire Période. */
const PCT_CHOICES = [25, 50, 75, 100] as const

interface Props {
  /** Bornes du calendrier (incluses), au format YYYY-MM-DD. */
  windowStart: string
  windowEnd: string
  /** Largeur d'un jour en pixels (zoom). */
  dayWidth: number
  /** Tous les collaborateurs connus (pour résoudre noms + couleurs + ajout). */
  collaborators: Collaborator[]
  /** Ids des collabs membres du projet courant. */
  memberIds: string[]
  /** Allocations du projet courant. */
  memberAllocations: MemberAllocation[]
  /** Nom du projet courant (titre). */
  projectName: string | null
  /** Id du projet courant (null = base vide). */
  projectId: string | null
  /** Callback : ajoute un collab au projet (POST membership). */
  onAddMember: (collaboratorId: string) => void
  /**
   * v2.2 / F4 — Callback : crée un nouveau collaborateur (entité globale)
   * ET l'affecte au projet courant. Déclenché par le bouton « + Nouveau ».
   * Tout le détail (prompt, POST, refresh) est porté côté App.tsx ; le grid
   * se contente de signaler l'intention.
   */
  onCreateCollaborator: () => void
  /** Callback : ajoute une période d'allocation (POST allocation). */
  onAddAllocation: (
    collaboratorId: string,
    body: { start_date: string; end_date: string; allocation_pct: number },
  ) => void
  /**
   * Callback : applique un batch de changements jour-par-jour pour un collab.
   * Appelé au commit du drag-paint (ou à chaque clic — qui est un mini-drag
   * d'1 cellule). Le parent calcule le `AllocationRebuildPlan` via
   * `rebuildAllocationsForCollab` puis exécute les mutations API.
   */
  onCommitChanges: (
    collaboratorId: string,
    changes: Map<string, number>,
  ) => void
  /**
   * Callback (optionnel) — pan horizontal de la fenêtre temporelle (drag à
   * la souris sur le panneau scrollable). Mêmes sémantiques que dans
   * GanttChart / WorkloadChart.
   */
  onShiftWindow?: (days: number) => void
}

/**
 * v2.1 / F4 — Cycle au palier suivant à partir d'un pct courant.
 *
 * @param cur  Pct courant (∈ PCT_CYCLE, ou 0 si vide).
 * @returns    Pct du palier suivant (avec wrap-around vers 0).
 */
function nextPct(cur: number): number {
  const i = PCT_CYCLE.indexOf(cur as (typeof PCT_CYCLE)[number])
  if (i === -1) return 25 // valeur inattendue → on rebascule au 1er palier non-nul
  return PCT_CYCLE[(i + 1) % PCT_CYCLE.length]
}

/**
 * v2.1 / F4 — Vue grille des affectations. Cf. en-tête du fichier.
 */
export default function MembersGrid({
  windowStart,
  windowEnd,
  dayWidth,
  collaborators,
  memberIds,
  memberAllocations,
  projectName,
  projectId,
  onAddMember,
  onCreateCollaborator,
  onAddAllocation,
  onCommitChanges,
  onShiftWindow,
}: Props) {
  /** Set des ids membres pour lookups O(1). */
  const memberSet = useMemo(() => new Set(memberIds), [memberIds])
  /** Collabs membres triés par position globale. */
  const orderedMembers = useMemo(
    () =>
      collaborators
        .filter((c) => memberSet.has(c.id))
        .sort((a, b) => a.position - b.position),
    [collaborators, memberSet],
  )
  /** Collabs candidats à l'ajout (non encore membres). */
  const candidates = useMemo(
    () => collaborators.filter((c) => !memberSet.has(c.id)),
    [collaborators, memberSet],
  )

  /** Pan horizontal (drag souris). */
  const { onMouseDown: handlePanMouseDown, isPanning } = useHorizontalPan(
    dayWidth,
    onShiftWindow,
  )
  let panCursorClass = ''
  if (onShiftWindow)
    panCursorClass = isPanning ? 'cursor-grabbing' : 'cursor-grab'

  /** Mesure de la largeur visible pour étendre la grille au dézoom max. */
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
  const totalWidth = dates.length * dayWidth

  /**
   * Pct effectif par (collab, dateIso) issu des allocations du projet
   * courant. Pré-calculé pour éviter de scanner les allocations à chaque
   * cellule (365 × 10 = ~3650 lookups par render).
   */
  const pctByCollabDay = useMemo(() => {
    const m = new Map<string, Map<string, number>>()
    for (const a of memberAllocations) {
      if (a.project_id !== projectId) continue
      let perDay = m.get(a.collaborator_id)
      if (!perDay) {
        perDay = new Map()
        m.set(a.collaborator_id, perDay)
      }
      let cur = a.start_date
      while (cur <= a.end_date) {
        perDay.set(cur, a.allocation_pct)
        cur = addDaysIso(cur, 1)
      }
    }
    return m
  }, [memberAllocations, projectId])

  /**
   * Overrides locaux PENDANT un drag-paint : reflète instantanément les
   * cellules peintes sans attendre le refetch serveur. Reset après chaque
   * commit (le parent met à jour `memberAllocations`, l'override n'a plus
   * d'utilité).
   */
  const [localOverrides, setLocalOverrides] = useState<
    Map<string, Map<string, number>>
  >(() => new Map())

  /**
   * v2.1 / F4 — Lecture du pct courant d'une cellule. Priorité aux overrides
   * locaux (drag en cours), sinon valeur dérivée des allocations.
   */
  function getCellPct(collabId: string, dateIso: string): number {
    const localPerDay = localOverrides.get(collabId)
    const localPct = localPerDay?.get(dateIso)
    if (localPct !== undefined) return localPct
    return pctByCollabDay.get(collabId)?.get(dateIso) ?? 0
  }

  /**
   * v2.1 / F4 — Pose un override local (utilisé par le hook useDragPaint
   * pour l'effet optimiste pendant le drag).
   */
  function setLocal(collabId: string, dateIso: string, pct: number) {
    setLocalOverrides((prev) => {
      const next = new Map(prev)
      let perDay = next.get(collabId)
      if (!perDay) {
        perDay = new Map()
        next.set(collabId, perDay)
      } else {
        perDay = new Map(perDay)
        next.set(collabId, perDay)
      }
      perDay.set(dateIso, pct)
      return next
    })
  }

  /**
   * v2.1 / F4 — Commit du drag-paint : transmet la batch au parent, qui
   * exécute les mutations API. On reset les overrides locaux JUSTE APRÈS
   * (le refetch parent va remplacer les allocations de toute façon ; en
   * attendant, garder les overrides évite un "flash" visuel).
   */
  function commitDrag(collabId: string, changes: Map<string, number>) {
    onCommitChanges(collabId, changes)
    // On garde les overlays jusqu'au prochain rendu avec memberAllocations
    // frais — au refetch suivant, pctByCollabDay reflètera les nouvelles
    // valeurs et il faudra purger les overrides (cf. useEffect ci-dessous).
  }

  /**
   * Purge les overrides locaux quand les allocations du parent changent
   * (= refetch terminé). Évite un état persistant désynchronisé après
   * succès du commit.
   */
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setLocalOverrides(new Map())
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [memberAllocations])

  /** Hook de drag-paint. */
  const drag = useDragPaint<number>({
    setLocal,
    onCommit: commitDrag,
  })

  // -- Mini-formulaire d'ajout de collab (en haut) ---------------------------
  const [pickedCandidate, setPickedCandidate] = useState<string>('')
  function handleAddMember() {
    if (!pickedCandidate) return
    onAddMember(pickedCandidate)
    setPickedCandidate('')
  }

  // -- Mini-formulaire « + Période » (par collab membre) ---------------------
  const [periodOpenFor, setPeriodOpenFor] = useState<string | null>(null)
  const [periodStart, setPeriodStart] = useState<string>('')
  const [periodEnd, setPeriodEnd] = useState<string>('')
  const [periodPct, setPeriodPct] = useState<number>(100)
  function submitPeriod() {
    if (!periodOpenFor || !periodStart || !periodEnd) return
    onAddAllocation(periodOpenFor, {
      start_date: periodStart,
      end_date: periodEnd,
      allocation_pct: periodPct,
    })
    setPeriodOpenFor(null)
    setPeriodStart('')
    setPeriodEnd('')
    setPeriodPct(100)
  }

  if (!projectId) {
    return (
      <div className="p-4 text-sm text-slate-500">
        Aucun projet sélectionné.
      </div>
    )
  }

  return (
    <div className="p-3 space-y-3">
      <header className="flex items-center gap-2 flex-wrap">
        <h2 className="text-base font-semibold">
          Affectation
          {projectName && (
            <span className="text-slate-500 font-normal"> — {projectName}</span>
          )}
        </h2>
        {/* v2.2 / F4 — Zone d'ajout d'un membre. Contient :
              • Le dropdown des candidats existants (affichés UNIQUEMENT s'il
                en reste — sinon caché pour ne pas montrer un select vide).
              • Le bouton « + Nouveau » qui crée un collab inédit ET l'affecte
                au projet courant. TOUJOURS visible (même candidates vide :
                c'est le seul moyen sur un projet où tous les collabs
                existants sont déjà membres). */}
        <div className="ml-auto flex items-center gap-1">
          {candidates.length > 0 && (
            <>
              <select
                className="text-xs border border-slate-300 rounded px-2 py-1"
                value={pickedCandidate}
                onChange={(e) => setPickedCandidate(e.target.value)}
              >
                <option value="">— ajouter un collaborateur —</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleAddMember}
                disabled={!pickedCandidate}
                className="px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
                title="Affecter le collaborateur sélectionné au projet"
              >
                +
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onCreateCollaborator}
            className="px-2 py-1 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-700"
            title="Créer un nouveau collaborateur et l'affecter au projet"
          >
            + Nouveau
          </button>
        </div>
      </header>

      {orderedMembers.length === 0 ? (
        <div className="text-xs text-slate-500 italic">
          Aucun membre dans ce projet — ajoutez-en un via le sélecteur
          ci-dessus.
        </div>
      ) : (
        <div
          className="gantt-no-select flex border border-slate-300 bg-white rounded-lg overflow-hidden shadow-sm"
          data-testid="members-grid"
        >
          {/* Colonne gauche : pastilles + bouton Période. */}
          <div className="shrink-0 w-52 border-r border-slate-300 bg-slate-50">
            <div className="h-14 border-b border-slate-300 flex items-center px-2 font-semibold text-slate-700 text-xs">
              Collaborateurs
            </div>
            {orderedMembers.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-1 border-b border-slate-200 px-2 text-xs"
                style={{ height: ROW_HEIGHT }}
                title={c.name}
              >
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: c.color }}
                  aria-hidden
                />
                <span className="truncate flex-1">{c.name}</span>
                <button
                  type="button"
                  onClick={() =>
                    setPeriodOpenFor((id) => (id === c.id ? null : c.id))
                  }
                  className="text-[10px] px-1 py-0.5 rounded border border-slate-300 hover:bg-slate-100"
                  title="Ajouter une période d'allocation pour ce collaborateur"
                >
                  + Période
                </button>
              </div>
            ))}
          </div>

          {/* Colonne droite : header + grille scrollable. */}
          <div
            ref={scrollRef}
            onMouseDown={handlePanMouseDown}
            className={['flex-1 overflow-x-auto', panCursorClass].join(' ')}
          >
            <div style={{ width: totalWidth }}>
              {/* HEADER mois */}
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

              {/* HEADER jours OU semaines. */}
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

              {/* CORPS — 1 ligne par membre × 1 cellule par jour. */}
              <div className="relative">
                {orderedMembers.map((c) => (
                  <div
                    key={c.id}
                    className="flex border-b border-slate-100"
                    style={{ height: ROW_HEIGHT }}
                  >
                    {dates.map((d, i) => {
                      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                      const offDay = isNonWorkingDay(d)
                      const pct = getCellPct(c.id, iso)
                      const cellBg = offDay ? 'bg-slate-50' : pctCellBg(pct)
                      // Couleur de texte extraite pour éviter un ternaire
                      // imbriqué (sonarjs/no-nested-conditional).
                      let textClass = 'text-slate-800'
                      if (offDay) textClass = 'text-slate-300'
                      else if (pct >= 75) textClass = 'text-white'
                      return (
                        <div
                          key={i}
                          className={[
                            'flex items-center justify-center text-[10px] font-medium border-r border-slate-100',
                            cellBg,
                            textClass,
                            'cursor-pointer select-none',
                          ].join(' ')}
                          style={{ width: dayWidth }}
                          title={`${c.name} — ${d.toLocaleDateString('fr-FR')} : ${pct} %${offDay ? ' (jour non ouvré)' : ''}`}
                          onMouseDown={(e) => {
                            if (offDay) return
                            e.preventDefault()
                            // Q1=A : la valeur du pinceau = nextPct(pct).
                            // Au clic seul, cela suffit à cycler. Au drag,
                            // toutes les cases survolées prennent cette
                            // valeur (cohérent : on étend la valeur de la
                            // case de départ après son cycle).
                            drag.onCellMouseDown(c.id, iso, nextPct(pct))
                          }}
                          onMouseEnter={() => {
                            if (offDay) return
                            drag.onCellEnter(c.id, iso)
                          }}
                        >
                          {offDay || pct === 0 ? '' : pct}
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mini-formulaire « + Période » (inline). Affiché seulement si l'user
          a cliqué sur le bouton dans la colonne gauche d'un collab. */}
      {periodOpenFor && (
        <div className="border border-slate-200 rounded p-2 bg-slate-50 flex flex-wrap items-end gap-2 text-xs">
          <span className="font-semibold">
            Période pour{' '}
            {collaborators.find((c) => c.id === periodOpenFor)?.name}
          </span>
          <label className="block">
            <span className="text-slate-600">Début</span>
            <input
              type="date"
              className="mt-0.5 block border border-slate-300 rounded px-2 py-1"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-slate-600">Fin</span>
            <input
              type="date"
              className="mt-0.5 block border border-slate-300 rounded px-2 py-1"
              value={periodEnd}
              min={periodStart || undefined}
              onChange={(e) => setPeriodEnd(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-slate-600">%</span>
            <select
              className="mt-0.5 block border border-slate-300 rounded px-2 py-1"
              value={periodPct}
              onChange={(e) => setPeriodPct(Number(e.target.value))}
            >
              {PCT_CHOICES.map((p) => (
                <option key={p} value={p}>
                  {p} %
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={submitPeriod}
            disabled={!periodStart || !periodEnd}
            className="px-3 py-1 rounded bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            Ajouter
          </button>
          <button
            type="button"
            onClick={() => setPeriodOpenFor(null)}
            className="px-2 py-1 rounded border border-slate-300 hover:bg-slate-100"
          >
            Annuler
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * v2.1 / F4 — Classe Tailwind du fond d'une cellule selon le % d'allocation.
 * Palette bleue cohérente avec la sous-charge du Plan de charge (mais plus
 * marquée pour distinguer les paliers).
 */
function pctCellBg(pct: number): string {
  if (pct >= 100) return 'bg-blue-700'
  if (pct >= 75) return 'bg-blue-500'
  if (pct >= 50) return 'bg-blue-300'
  if (pct >= 25) return 'bg-blue-100'
  return ''
}
