// =============================================================================
// COMPOSANT AbsencesGrid — Gantt v2.1 / F5
// =============================================================================
// Onglet « Congés » refondu en grille calendaire (jumeau de MembersGrid).
// Pour chaque collaborateur (tous projets confondus — un congé est cross-
// projet, RG-GANTT-1401), affiche la fraction d'absence jour par jour.
//
// Le user peut :
//   • CLIQUER sur une case → cycle `vide → 0,25 → 0,5 → 0,75 → 1 → vide`.
//   • DRAGGER horizontalement → peint avec la valeur de la case de départ
//     (Q1=A, Q2=écrasement, Q3=horizontal seulement). 1 seul commit au mouseup.
//   • Cliquer « + Période » → mini-formulaire inline pour saisir une plage
//     entière avec une fraction (cohérent avec le legacy de l'onglet).
//
// 1 jour = 1 ligne en base (clé primaire composite (collab, date)) → pas
// besoin de compactage : chaque changement est une mutation indépendante
// (POST=UPSERT si fraction>0, DELETE si fraction=0).
//
// Composant 100 % présentationnel : il NE FAIT PAS d'appel API.
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
import type { Collaborator, CollaboratorAbsence } from '../lib/types'

/** Hauteur d'une ligne — synchronisée avec MembersGrid/WorkloadChart. */
const ROW_HEIGHT = 26

/** Seuil de zoom (px par jour) sous lequel le header passe en semaines ISO. */
const WEEK_HEADER_THRESHOLD = 12

/** Cycle des fractions d'absence pour le clic / drag (RG-GANTT-1400). */
const FRACTION_CYCLE = [0, 0.25, 0.5, 0.75, 1] as const

/** Choix de fractions pour le mini-formulaire Période. */
const FRACTION_CHOICES = [0.25, 0.5, 0.75, 1] as const

interface Props {
  /** Bornes du calendrier (incluses), au format YYYY-MM-DD. */
  windowStart: string
  windowEnd: string
  /** Largeur d'un jour en pixels (zoom). */
  dayWidth: number
  /** Tous les collaborateurs connus (cross-projet). */
  collaborators: Collaborator[]
  /** Toutes les absences connues (cross-projet, RG-GANTT-1401). */
  absences: CollaboratorAbsence[]
  /**
   * Callback : applique un batch de changements jour-par-jour pour un collab.
   * Le parent exécute en série POST (fraction>0) / DELETE (fraction=0) puis
   * un seul `fetchState`.
   */
  onCommitChanges: (
    collaboratorId: string,
    changes: Map<string, number>,
  ) => void
  /**
   * Callback : ajoute une absence en série sur une plage (mini-formulaire
   * Période). Le parent fait 1 POST par jour ouvré de la plage.
   */
  onAddPeriod: (
    collaboratorId: string,
    body: { start_date: string; end_date: string; fraction: number },
  ) => void
  /**
   * Callback (optionnel) — pan horizontal de la fenêtre temporelle (drag à
   * la souris sur le panneau scrollable).
   */
  onShiftWindow?: (days: number) => void
}

/**
 * v2.1 / F5 — Cycle à la fraction suivante à partir d'une fraction courante.
 *
 * @param cur  Fraction courante (∈ FRACTION_CYCLE, ou 0 si vide).
 * @returns    Fraction du palier suivant (avec wrap-around vers 0).
 */
function nextFraction(cur: number): number {
  const i = FRACTION_CYCLE.indexOf(cur as (typeof FRACTION_CYCLE)[number])
  if (i === -1) return 0.25 // valeur inattendue → premier palier non-nul
  return FRACTION_CYCLE[(i + 1) % FRACTION_CYCLE.length]
}

/**
 * v2.1 / F5 — Format lisible d'une fraction (1 = "1", 0,5 = "0,5", etc.).
 * Affiché à la française (virgule décimale).
 */
function formatFraction(f: number): string {
  if (f === 1) return '1'
  return f.toString().replace('.', ',')
}

/**
 * v2.1 / F5 — Vue grille des congés (cross-projet). Cf. en-tête du fichier.
 */
export default function AbsencesGrid({
  windowStart,
  windowEnd,
  dayWidth,
  collaborators,
  absences,
  onCommitChanges,
  onAddPeriod,
  onShiftWindow,
}: Props) {
  /** Collabs triés par position globale. */
  const orderedCollabs = useMemo(
    () => [...collaborators].sort((a, b) => a.position - b.position),
    [collaborators],
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
   * Fraction d'absence par (collab, dateIso). 1 absence par jour max
   * (PRIMARY KEY composite côté DAL — RG-GANTT-1403).
   */
  const fractionByCollabDay = useMemo(() => {
    const m = new Map<string, Map<string, number>>()
    for (const a of absences) {
      let perDay = m.get(a.collaborator_id)
      if (!perDay) {
        perDay = new Map()
        m.set(a.collaborator_id, perDay)
      }
      perDay.set(a.date, a.fraction)
    }
    return m
  }, [absences])

  /**
   * Overrides locaux PENDANT un drag-paint : reflète instantanément les
   * cellules peintes sans attendre le refetch serveur.
   */
  const [localOverrides, setLocalOverrides] = useState<
    Map<string, Map<string, number>>
  >(() => new Map())

  /** Lecture de la fraction courante d'une cellule (override > base). */
  function getCellFraction(collabId: string, dateIso: string): number {
    const localPerDay = localOverrides.get(collabId)
    const localValue = localPerDay?.get(dateIso)
    if (localValue !== undefined) return localValue
    return fractionByCollabDay.get(collabId)?.get(dateIso) ?? 0
  }

  /** Pose un override local (utilisé par le hook useDragPaint). */
  function setLocal(collabId: string, dateIso: string, fraction: number) {
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
      perDay.set(dateIso, fraction)
      return next
    })
  }

  /** Commit du drag-paint : transmet la batch au parent. */
  function commitDrag(collabId: string, changes: Map<string, number>) {
    onCommitChanges(collabId, changes)
  }

  /** Purge des overrides locaux au refetch serveur. */
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setLocalOverrides(new Map())
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [absences])

  /** Hook de drag-paint (générique, F4+F5). */
  const drag = useDragPaint<number>({
    setLocal,
    onCommit: commitDrag,
  })

  // -- Mini-formulaire « + Période » (par collab) ----------------------------
  const [periodOpenFor, setPeriodOpenFor] = useState<string | null>(null)
  const [periodStart, setPeriodStart] = useState<string>('')
  const [periodEnd, setPeriodEnd] = useState<string>('')
  const [periodFraction, setPeriodFraction] = useState<number>(1)
  function submitPeriod() {
    if (!periodOpenFor || !periodStart || !periodEnd) return
    onAddPeriod(periodOpenFor, {
      start_date: periodStart,
      end_date: periodEnd,
      fraction: periodFraction,
    })
    setPeriodOpenFor(null)
    setPeriodStart('')
    setPeriodEnd('')
    setPeriodFraction(1)
  }

  if (orderedCollabs.length === 0) {
    return (
      <div className="p-4 text-sm text-slate-500">
        Aucun collaborateur. Créez-en un dans la barre du haut pour pouvoir
        saisir des congés.
      </div>
    )
  }

  return (
    <div className="p-3 space-y-3">
      <header className="flex items-center gap-2 flex-wrap">
        <h2 className="text-base font-semibold">Congés</h2>
        <p className="text-xs text-slate-500">
          Cliquez sur une case pour cycler la fraction. Glissez horizontalement
          pour peindre plusieurs jours. Les congés sont cross-projet.
        </p>
      </header>

      <div
        className="gantt-no-select flex border border-slate-300 bg-white rounded-lg overflow-hidden shadow-sm"
        data-testid="absences-grid"
      >
        {/* Colonne gauche : pastilles + bouton Période. */}
        <div className="shrink-0 w-52 border-r border-slate-300 bg-slate-50">
          <div className="h-14 border-b border-slate-300 flex items-center px-2 font-semibold text-slate-700 text-xs">
            Collaborateurs
          </div>
          {orderedCollabs.map((c) => (
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
                title="Ajouter une période de congés pour ce collaborateur"
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
            {/* HEADER mois. */}
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

            {/* CORPS — 1 ligne par collab × 1 cellule par jour. */}
            <div className="relative">
              {orderedCollabs.map((c) => (
                <div
                  key={c.id}
                  className="flex border-b border-slate-100"
                  style={{ height: ROW_HEIGHT }}
                >
                  {dates.map((d, i) => {
                    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                    const offDay = isNonWorkingDay(d)
                    const fr = getCellFraction(c.id, iso)
                    const cellBg = offDay ? 'bg-slate-50' : fractionCellBg(fr)
                    // Couleur de texte extraite pour éviter un ternaire
                    // imbriqué (sonarjs/no-nested-conditional).
                    let textClass = 'text-slate-800'
                    if (offDay) textClass = 'text-slate-300'
                    else if (fr >= 0.75) textClass = 'text-white'
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
                        title={`${c.name} — ${d.toLocaleDateString('fr-FR')} : ${fr === 0 ? 'pas de congé' : formatFraction(fr) + ' j'}${offDay ? ' (jour non ouvré)' : ''}`}
                        onMouseDown={(e) => {
                          if (offDay) return
                          e.preventDefault()
                          drag.onCellMouseDown(c.id, iso, nextFraction(fr))
                        }}
                        onMouseEnter={() => {
                          if (offDay) return
                          drag.onCellEnter(c.id, iso)
                        }}
                      >
                        {offDay || fr === 0 ? '' : formatFraction(fr)}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Mini-formulaire « + Période ». */}
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
            <span className="text-slate-600">Fraction</span>
            <select
              className="mt-0.5 block border border-slate-300 rounded px-2 py-1"
              value={periodFraction}
              onChange={(e) => setPeriodFraction(Number(e.target.value))}
            >
              {FRACTION_CHOICES.map((f) => (
                <option key={f} value={f}>
                  {formatFraction(f)} j
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
 * v2.1 / F5 — Classe Tailwind du fond d'une cellule selon la fraction
 * d'absence. Palette amber (cohérente avec la couleur amber utilisée pour
 * les alertes / indicateurs métier). Plus la fraction est haute, plus
 * l'amber est marqué.
 */
function fractionCellBg(fr: number): string {
  if (fr >= 1) return 'bg-amber-700'
  if (fr >= 0.75) return 'bg-amber-500'
  if (fr >= 0.5) return 'bg-amber-300'
  if (fr >= 0.25) return 'bg-amber-100'
  return ''
}
