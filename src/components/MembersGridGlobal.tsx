// =============================================================================
// MembersGridGlobal — Vue Affectation × Tous les projets (Gantt v2.2 / F5)
// =============================================================================
// Rendue UNIQUEMENT quand le sélecteur projet est en mode 'all' sur l'onglet
// Affectation. Deux sections empilées :
//
//   • Vue 1 — Tableau croisé Collaborateur × Projet (matrice avec ✓ pour
//     chaque couple membre). Lecture seule. Permet de voir d'un coup d'œil
//     qui est affecté où.
//
//   • Vue 2 — Grille temporelle. UNE ligne par couple (collab, projet)
//     existant. Affiche les pct d'allocation jour-par-jour. Édition par
//     CLIC-CYCLE (0 → 25 → 50 → 75 → 100 → 0). Pas de drag-paint en V1
//     (sera ajouté si le besoin se confirme — laisse le code simple pour ce
//     premier jet).
//
// Composant 100 % présentationnel : toutes les mutations remontent au parent
// via `onCommitCellChange(collabId, projectId, dayIso, newPct)`. Le parent
// (App.tsx) calcule le plan d'allocation et exécute les mutations API.
// =============================================================================

import { useMemo } from 'react'
import {
  buildDateRange,
  dateToIso,
  groupByMonth,
  groupByWeek,
  isFrenchHoliday,
  isNonWorkingDay,
} from '../lib/utils'
import { useHorizontalPan } from '../lib/useHorizontalPan'
import type { Collaborator, MemberAllocation, Project } from '../lib/types'

/** Hauteur d'une ligne — synchronisée avec MembersGrid / WorkloadChart. */
const ROW_HEIGHT = 26

/** Seuil de zoom (px par jour) sous lequel le header passe en semaines ISO. */
const WEEK_HEADER_THRESHOLD = 12

/** Cycle des paliers d'allocation pour le clic. */
const PCT_CYCLE = [0, 25, 50, 75, 100] as const

/** Couple (collaborateur, projet) — clé logique des lignes de la Vue 2. */
interface MemberPair {
  collaborator_id: string
  project_id: string
}

interface Props {
  /** Borne basse de la fenêtre visible (ISO YYYY-MM-DD). */
  windowStart: string
  /** Borne haute de la fenêtre visible (ISO YYYY-MM-DD, INCLUSIVE). */
  windowEnd: string
  /** Largeur d'un jour en pixels (zoom). */
  dayWidth: number
  /** Tous les projets connus (utilisé pour le header de la matrice + libellés). */
  projects: Project[]
  /** Tous les collaborateurs connus (résolution noms/couleurs + lignes). */
  collaborators: Collaborator[]
  /** Tous les memberships cross-projet (couples membres). */
  allProjectMembers: MemberPair[]
  /** Toutes les allocations cross-projet (toutes périodes, tous projets). */
  allMemberAllocations: MemberAllocation[]
  /**
   * Commit d'un changement de pct pour une cellule (collab, projet, jour).
   * Le parent recalcule le plan d'allocations et POSTe la mutation.
   */
  onCommitCellChange: (
    collaboratorId: string,
    projectId: string,
    dayIso: string,
    newPct: number,
  ) => void
  /** Pan horizontal (drag à la souris sur le panneau scrollable). */
  onShiftWindow?: (days: number) => void
}

/**
 * Calcule le prochain palier de % à partir du pct courant (clic-cycle).
 *   • 0 → 25 → 50 → 75 → 100 → 0 …
 *   • Toute valeur inattendue → repart au 1er palier non-nul (25).
 */
function nextPct(cur: number): number {
  const i = PCT_CYCLE.indexOf(cur as (typeof PCT_CYCLE)[number])
  if (i === -1) return 25
  return PCT_CYCLE[(i + 1) % PCT_CYCLE.length]
}

/**
 * Trouve le pct courant pour un couple (collab, projet) à un jour donné.
 * Cherche une allocation qui couvre `dayIso` (start ≤ day ≤ end). Retourne
 * 0 si aucune allocation ne couvre ce jour (= jour libre).
 */
function findPctForDay(
  allocations: MemberAllocation[],
  collabId: string,
  projectId: string,
  dayIso: string,
): number {
  for (const a of allocations) {
    if (a.collaborator_id !== collabId) continue
    if (a.project_id !== projectId) continue
    if (dayIso >= a.start_date && dayIso <= a.end_date) {
      return a.allocation_pct
    }
  }
  return 0
}

/**
 * Vue Affectation × Tous les projets. Cf. en-tête du fichier.
 */
export default function MembersGridGlobal({
  windowStart,
  windowEnd,
  dayWidth,
  projects,
  collaborators,
  allProjectMembers,
  allMemberAllocations,
  onCommitCellChange,
  onShiftWindow,
}: Props) {
  /** Jours visibles (Date[]) entre windowStart et windowEnd inclus. */
  const days = useMemo(
    () => buildDateRange(windowStart, windowEnd),
    [windowStart, windowEnd],
  )
  /** Groupes mensuels pour le header (ligne du haut). `{label, span}`. */
  const monthGroups = useMemo(() => groupByMonth(days), [days])
  /** Groupes hebdomadaires (ligne du bas si dezoom prononcé). */
  const showWeekHeader = dayWidth < WEEK_HEADER_THRESHOLD
  const weekGroups = useMemo(
    () => (showWeekHeader ? groupByWeek(days) : []),
    [days, showWeekHeader],
  )
  /** Couleur d'un collab par id. */
  const collabById = useMemo(() => {
    const m = new Map<string, Collaborator>()
    for (const c of collaborators) m.set(c.id, c)
    return m
  }, [collaborators])
  /** Nom d'un projet par id. */
  const projectById = useMemo(() => {
    const m = new Map<string, Project>()
    for (const p of projects) m.set(p.id, p)
    return m
  }, [projects])
  /** Couples (collab, projet) triés : par collab.position puis project.position. */
  const orderedPairs = useMemo(() => {
    const enriched = allProjectMembers
      .map((m) => {
        const c = collabById.get(m.collaborator_id)
        const p = projectById.get(m.project_id)
        if (!c || !p) return null
        return { ...m, collabPosition: c.position, projectPosition: p.position }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    enriched.sort((a, b) => {
      if (a.collabPosition !== b.collabPosition) {
        return a.collabPosition - b.collabPosition
      }
      return a.projectPosition - b.projectPosition
    })
    return enriched.map(({ collaborator_id, project_id }) => ({
      collaborator_id,
      project_id,
    }))
  }, [allProjectMembers, collabById, projectById])

  /** Set des couples membres pour lookup O(1) dans la matrice. */
  const memberPairSet = useMemo(() => {
    const s = new Set<string>()
    for (const m of allProjectMembers) {
      s.add(`${m.collaborator_id}::${m.project_id}`)
    }
    return s
  }, [allProjectMembers])

  /** Pan horizontal (drag souris). Seul `onMouseDown` est consommé en V1 ;
   *  `isPanning` (visuel d'overlay) sera ajouté si le besoin se confirme. */
  const { onMouseDown: handlePanMouseDown } = useHorizontalPan(
    dayWidth,
    onShiftWindow,
  )

  /** Largeur totale de la grille temporelle. */
  const gridWidth = days.length * dayWidth

  // -----------------------------------------------------------------------
  // Rendu
  // -----------------------------------------------------------------------
  if (allProjectMembers.length === 0) {
    return (
      <div className="p-4 text-sm text-slate-500">
        Aucune affectation enregistrée sur l'ensemble des projets.
      </div>
    )
  }

  return (
    <div className="p-3 space-y-4">
      <header>
        <h2 className="text-base font-semibold">
          Affectation{' '}
          <span className="text-slate-500 font-normal">— Tous les projets</span>
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Vue agrégée. Pour créer un nouveau collaborateur ou affecter à un
          projet, repassez en sélection mono-projet via le sélecteur en haut.
        </p>
      </header>

      {/* ------------------------------------------------------------ */}
      {/* VUE 1 — Tableau croisé Collab × Projet                       */}
      {/* ------------------------------------------------------------ */}
      <section>
        <h3 className="text-sm font-medium text-slate-700 mb-2">
          Qui sur quoi ?
        </h3>
        <div className="overflow-auto border border-slate-200 rounded">
          <table className="text-xs border-collapse">
            <thead className="bg-slate-50">
              <tr>
                <th className="border-b border-slate-200 px-3 py-1.5 text-left font-medium text-slate-700 sticky left-0 bg-slate-50 z-10">
                  Collaborateur
                </th>
                {projects.map((p) => (
                  <th
                    key={p.id}
                    className="border-b border-l border-slate-200 px-3 py-1.5 font-medium text-slate-700 whitespace-nowrap"
                  >
                    {p.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {collaborators.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="border-b border-slate-200 px-3 py-1 sticky left-0 bg-white z-10 whitespace-nowrap">
                    <span
                      className="inline-block w-2 h-2 rounded-full mr-2 align-middle"
                      style={{ backgroundColor: c.color }}
                    />
                    {c.name}
                  </td>
                  {projects.map((p) => {
                    const isMember = memberPairSet.has(`${c.id}::${p.id}`)
                    return (
                      <td
                        key={p.id}
                        className="border-b border-l border-slate-200 text-center px-3 py-1"
                      >
                        {isMember ? (
                          <span
                            className="text-emerald-600 font-semibold"
                            aria-label="Affecté"
                          >
                            ✓
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ------------------------------------------------------------ */}
      {/* VUE 2 — Grille temporelle (1 ligne par couple collab×projet) */}
      {/* ------------------------------------------------------------ */}
      <section>
        <h3 className="text-sm font-medium text-slate-700 mb-2">
          Allocation dans le temps
        </h3>
        <div className="border border-slate-200 rounded overflow-hidden">
          {/* Header date (mois + jours/semaines) calqué sur MembersGrid. */}
          <div className="flex">
            {/* Colonne fixe à gauche (label de la ligne). */}
            <div className="shrink-0 border-r border-slate-200 bg-slate-50">
              <div className="px-3 py-1 text-xs font-medium text-slate-700 border-b border-slate-200 h-[40px] flex items-center">
                Collaborateur • Projet
              </div>
              <div className="text-xs h-[24px] border-b border-slate-200" />
              {orderedPairs.map(({ collaborator_id, project_id }) => {
                const c = collabById.get(collaborator_id)
                const p = projectById.get(project_id)
                if (!c || !p) return null
                return (
                  <div
                    key={`${collaborator_id}::${project_id}`}
                    className="px-3 text-xs whitespace-nowrap border-b border-slate-100 flex items-center"
                    style={{ height: ROW_HEIGHT }}
                  >
                    <span
                      className="inline-block w-2 h-2 rounded-full mr-2 shrink-0"
                      style={{ backgroundColor: c.color }}
                    />
                    <span className="truncate">
                      {c.name}{' '}
                      <span className="text-slate-400">• {p.name}</span>
                    </span>
                  </div>
                )
              })}
            </div>

            {/* Panneau scrollable (header dates + grille des cellules). */}
            <div
              className="flex-1 overflow-x-auto"
              onMouseDown={handlePanMouseDown}
            >
              {/* Ligne mois. */}
              <div
                className="flex bg-slate-50 border-b border-slate-200"
                style={{ width: gridWidth }}
              >
                {monthGroups.map((g) => (
                  <div
                    key={g.label}
                    className="text-xs font-medium text-slate-700 text-center border-r border-slate-200 py-1 capitalize"
                    style={{ width: g.span * dayWidth }}
                  >
                    {g.label}
                  </div>
                ))}
              </div>
              {/* Ligne semaines ou jours selon le zoom. */}
              <div
                className="flex bg-white border-b border-slate-200"
                style={{ width: gridWidth }}
              >
                {showWeekHeader
                  ? weekGroups.map((g) => (
                      <div
                        key={g.label}
                        className="text-[10px] text-slate-500 text-center border-r border-slate-100"
                        style={{ width: g.span * dayWidth, height: 24 }}
                      >
                        {g.label}
                      </div>
                    ))
                  : days.map((d) => (
                      <div
                        key={dateToIso(d)}
                        className="text-[10px] text-slate-500 text-center border-r border-slate-100"
                        style={{ width: dayWidth, height: 24 }}
                      >
                        {d.getDate()}
                      </div>
                    ))}
              </div>
              {/* Lignes de la grille : une par couple. */}
              {orderedPairs.map(({ collaborator_id, project_id }) => {
                const c = collabById.get(collaborator_id)
                if (!c) return null
                return (
                  <div
                    key={`${collaborator_id}::${project_id}`}
                    className="flex border-b border-slate-100"
                    style={{ width: gridWidth, height: ROW_HEIGHT }}
                  >
                    {days.map((d) => {
                      const dIso = dateToIso(d)
                      const isWeekend = isNonWorkingDay(d)
                      const isHoliday = isFrenchHoliday(d)
                      const pct = findPctForDay(
                        allMemberAllocations,
                        collaborator_id,
                        project_id,
                        dIso,
                      )
                      // Style : fond gris pour weekend/férié, sinon dégradé
                      // d'intensité bleu selon pct (calqué sur MembersGrid).
                      const bg = (() => {
                        if (isWeekend || isHoliday) return '#f1f5f9' // slate-100
                        if (pct === 0) return 'transparent'
                        if (pct >= 100) return '#3b82f6' // blue-500
                        if (pct >= 75) return '#60a5fa' // blue-400
                        if (pct >= 50) return '#93c5fd' // blue-300
                        return '#bfdbfe' // blue-200 (25 %)
                      })()
                      const handleClick = () => {
                        if (isWeekend || isHoliday) return
                        onCommitCellChange(
                          collaborator_id,
                          project_id,
                          dIso,
                          nextPct(pct),
                        )
                      }
                      return (
                        <button
                          type="button"
                          key={dIso}
                          onClick={handleClick}
                          disabled={isWeekend || isHoliday}
                          className="border-r border-slate-100 text-[10px] flex items-center justify-center disabled:cursor-default"
                          style={{
                            width: dayWidth,
                            height: ROW_HEIGHT,
                            backgroundColor: bg,
                            color: pct >= 75 ? 'white' : '#475569',
                          }}
                          title={`${c.name} • ${
                            projectById.get(project_id)?.name ?? project_id
                          } — ${dIso.slice(8, 10)}/${dIso.slice(5, 7)}/${dIso.slice(0, 4)} : ${pct} %`}
                        >
                          {pct > 0 && !isWeekend && !isHoliday ? pct : ''}
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
