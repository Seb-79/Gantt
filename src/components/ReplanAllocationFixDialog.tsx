// =============================================================================
// COMPOSANT ReplanAllocationFixDialog — Gantt v2.1 / F2.9.D
// =============================================================================
// Modal de résolution affichée quand le bouton « Replan » est cliqué alors
// que plusieurs activités du projet ne peuvent PAS être planifiées (charge
// non absorbée par les allocations actuelles).
//
// Différent de `AllocationFixDialog` (qui traite UNE tâche au moment du save) :
// ici on affiche la LISTE des tâches problématiques (Q4=B : un dialog
// récapitulatif unique), avec pour chacune :
//   • une case à cocher (cochée par défaut) pour décider de l'étendre ou non ;
//   • un sélecteur de date d'extension (pré-calculée, éditable) ;
//   • un sélecteur de taux (25/50/75/100).
//
// Actions globales :
//   • « Tout cocher / Tout décocher » : bascule l'ensemble des cases.
//   • « Annuler le replan » : ferme tout, aucun replan ne se déclenche.
//   • « Étendre et replanifier » : exécute en série les plans d'extension
//     des lignes cochées via le callback parent, puis demande le replan.
//
// Composant 100 % présentationnel : il NE FAIT PAS d'appel API.
// =============================================================================

import { useMemo, useState } from 'react'
import {
  computeExtensionPlan,
  type AllocationShortfall,
  type ExtensionPlan,
  type MemberAllocation,
  type CollaboratorAbsence,
} from '../lib/utils'
import type { Collaborator } from '../lib/types'

/**
 * v2.1 / F2.9.D — Description d'une tâche en problème pour ce dialog.
 * Construite par `App.tsx` après scan via `computeAllocationShortfall`.
 */
export interface ReplanShortfallItem {
  taskId: string
  taskName: string
  startDate: string
  charge: number
  collaboratorIds: string[]
  shortfall: AllocationShortfall
}

interface Props {
  /** Liste des tâches en problème (au moins 1 sinon le dialog n'est pas ouvert). */
  items: ReplanShortfallItem[]
  /** Projet courant. */
  projectId: string
  /** Liste complète des collaborateurs (pour résoudre noms + couleurs). */
  collaborators: Collaborator[]
  /** Allocations actuelles connues (toutes paires). */
  allocations: MemberAllocation[]
  /** Absences cross-projet (pour la simulation). */
  absences: CollaboratorAbsence[]
  /**
   * Callback « Étendre et replanifier » — reçoit la liste des plans à exécuter
   * dans l'ordre fourni. Le parent doit ensuite déclencher le replan lui-même.
   */
  onApply: (plans: ExtensionPlan[]) => void
  /** Callback « Annuler le replan » — ferme tout, aucun replan. */
  onCancel: () => void
}

/** Choix de taux possibles (cohérent avec les périodes côté ProjectMembers). */
const PCT_CHOICES = [25, 50, 75, 100] as const

/**
 * État local d'édition par tâche (case à cocher + date + pct). Une `Map` par
 * `taskId` garde un état stable même si l'ordre des items change.
 */
interface ItemState {
  selected: boolean
  pct: number
  targetDate: string
}

/**
 * v2.1 / F2.9.D — Dialog récapitulatif d'extension d'allocation pour replan.
 *
 * @param props  Cf. interface ci-dessus.
 */
export default function ReplanAllocationFixDialog({
  items,
  projectId,
  collaborators,
  allocations,
  absences,
  onApply,
  onCancel,
}: Props) {
  /** État initial (1 entrée par item) : tout coché, taux 100 %, date auto. */
  const [byTask, setByTask] = useState<Map<string, ItemState>>(() => {
    const m = new Map<string, ItemState>()
    for (const it of items) {
      const auto = computeExtensionPlan({
        startDate: it.startDate,
        missing: it.shortfall.missing,
        collaboratorIds: it.collaboratorIds,
        projectId,
        allocations,
        absences,
        pct: 100,
      })
      m.set(it.taskId, {
        selected: true,
        pct: 100,
        targetDate: auto.targetEndDate,
      })
    }
    return m
  })

  /** Cache id → collaborateur pour résoudre rapidement les pastilles couleur. */
  const collabById = useMemo(() => {
    const m = new Map<string, Collaborator>()
    for (const c of collaborators) m.set(c.id, c)
    return m
  }, [collaborators])

  /** Met à jour partiellement l'état d'une ligne (immutable). */
  function patchItem(taskId: string, patch: Partial<ItemState>) {
    setByTask((prev) => {
      const next = new Map(prev)
      const cur = next.get(taskId)
      if (!cur) return prev
      next.set(taskId, { ...cur, ...patch })
      return next
    })
  }

  /** Bascule toutes les cases à un état donné. */
  function setAllSelected(value: boolean) {
    setByTask((prev) => {
      const next = new Map<string, ItemState>()
      for (const [id, s] of prev) next.set(id, { ...s, selected: value })
      return next
    })
  }

  /**
   * Quand le pct d'une ligne change : on recalcule la date auto et on
   * resynchronise targetDate seulement si la valeur actuelle est antérieure
   * (sinon la simulation devient incohérente avec la date).
   */
  function handlePctChange(taskId: string, nextPct: number) {
    const item = items.find((i) => i.taskId === taskId)
    if (!item) return
    const auto = computeExtensionPlan({
      startDate: item.startDate,
      missing: item.shortfall.missing,
      collaboratorIds: item.collaboratorIds,
      projectId,
      allocations,
      absences,
      pct: nextPct,
    })
    setByTask((prev) => {
      const next = new Map(prev)
      const cur = next.get(taskId)
      if (!cur) return prev
      const finalDate =
        cur.targetDate < auto.targetEndDate
          ? auto.targetEndDate
          : cur.targetDate
      next.set(taskId, { ...cur, pct: nextPct, targetDate: finalDate })
      return next
    })
  }

  /** Compte des cases cochées (pour libellé du bouton primaire). */
  const selectedCount = useMemo(() => {
    let n = 0
    for (const s of byTask.values()) if (s.selected) n++
    return n
  }, [byTask])

  /**
   * Construit la liste des plans à exécuter en suivant l'ordre des items
   * et les paramètres saisis par l'utilisateur.
   */
  function buildPlans(): ExtensionPlan[] {
    const plans: ExtensionPlan[] = []
    for (const it of items) {
      const st = byTask.get(it.taskId)
      if (!st || !st.selected) continue
      const auto = computeExtensionPlan({
        startDate: it.startDate,
        missing: it.shortfall.missing,
        collaboratorIds: it.collaboratorIds,
        projectId,
        allocations,
        absences,
        pct: st.pct,
      })
      // Honore la date saisie par l'utilisateur (≥ auto par construction).
      const finalDate =
        st.targetDate < auto.targetEndDate ? auto.targetEndDate : st.targetDate
      plans.push({
        ...auto,
        targetEndDate: finalDate,
        operations: auto.operations.map((op) => ({
          ...op,
          endDate: finalDate,
        })),
      })
    }
    return plans
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-[70] p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 pt-3 pb-2 border-b border-slate-100">
          <h2 className="text-base font-semibold text-amber-900">
            ⚠ Replan bloqué — Allocations insuffisantes
          </h2>
          <p className="text-xs text-slate-600 mt-1">
            {items.length} activité{items.length > 1 ? 's' : ''} ne peu
            {items.length > 1 ? 'vent' : 't'} pas être planifiée
            {items.length > 1 ? 's' : ''} avec les allocations actuelles. Cochez
            celles dont vous voulez étendre l'allocation, ou annulez le replan
            pour ajuster manuellement.
          </p>
          {/* Actions globales sur la sélection. */}
          <div className="mt-2 flex gap-2 text-xs">
            <button
              type="button"
              onClick={() => setAllSelected(true)}
              className="px-2 py-0.5 rounded border border-slate-300 hover:bg-slate-50"
            >
              Tout cocher
            </button>
            <button
              type="button"
              onClick={() => setAllSelected(false)}
              className="px-2 py-0.5 rounded border border-slate-300 hover:bg-slate-50"
            >
              Tout décocher
            </button>
          </div>
        </div>

        {/* Corps scrollable — liste des tâches en problème, 1 ligne par tâche. */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {items.map((it) => {
            const st = byTask.get(it.taskId)
            if (!st) return null
            return (
              <ReplanItemRow
                key={it.taskId}
                item={it}
                state={st}
                collabById={collabById}
                onToggle={(v) => patchItem(it.taskId, { selected: v })}
                onDateChange={(v) => patchItem(it.taskId, { targetDate: v })}
                onPctChange={(v) => handlePctChange(it.taskId, v)}
              />
            )
          })}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-slate-100 flex justify-between items-center">
          <span className="text-xs text-slate-500">
            {selectedCount} sur {items.length} à étendre
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-2.5 py-1 text-xs rounded border border-slate-300 hover:bg-slate-50"
            >
              Annuler le replan
            </button>
            <button
              type="button"
              onClick={() => onApply(buildPlans())}
              disabled={selectedCount === 0}
              className="px-2.5 py-1 text-xs rounded bg-amber-700 text-white hover:bg-amber-800 disabled:bg-slate-300 disabled:cursor-not-allowed"
            >
              Étendre et replanifier
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * v2.1 / F2.9.D — Ligne d'une tâche en problème dans le dialog récap.
 * Extrait pour limiter la complexité du composant parent (sonarjs).
 */
function ReplanItemRow({
  item,
  state,
  collabById,
  onToggle,
  onDateChange,
  onPctChange,
}: {
  item: ReplanShortfallItem
  state: ItemState
  collabById: Map<string, Collaborator>
  onToggle: (v: boolean) => void
  onDateChange: (v: string) => void
  onPctChange: (v: number) => void
}) {
  return (
    <div
      className={
        'border rounded p-2 ' +
        (state.selected
          ? 'border-amber-300 bg-amber-50'
          : 'border-slate-200 bg-slate-50')
      }
    >
      <label className="flex items-start gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 accent-amber-500"
          checked={state.selected}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <div className="flex-1 text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-800">
              {item.taskName}
            </span>
            {item.collaboratorIds.map((id) => {
              const c = collabById.get(id)
              if (!c) return null
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 bg-white border border-slate-300 rounded-full pl-1 pr-2 py-0.5"
                >
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ backgroundColor: c.color }}
                    aria-hidden
                  />
                  <span>{c.name}</span>
                </span>
              )
            })}
            <span className="ml-auto text-red-700 font-medium">
              {item.shortfall.missing.toFixed(2)} j manquant
              {item.shortfall.missing > 1 ? 's' : ''}
            </span>
          </div>
          <div className="mt-1 text-slate-500">
            Charge : {item.charge} j — Début : {item.startDate}
            {item.shortfall.horizon && (
              <>
                {' '}
                — Dernière alloc :{' '}
                <span className="font-mono">{item.shortfall.horizon}</span>
              </>
            )}
          </div>
        </div>
      </label>

      {/* Réglages d'extension (date + %), activés UNIQUEMENT si la case est
          cochée — sinon affichés grisés pour signaler qu'ils sont inactifs. */}
      <div
        className={
          'mt-2 pl-5 flex flex-wrap items-end gap-2 ' +
          (state.selected ? '' : 'opacity-50 pointer-events-none')
        }
      >
        <label className="block text-xs">
          <span className="text-slate-600">Étendre jusqu'au</span>
          <input
            type="date"
            className="mt-0.5 block text-sm border border-slate-300 rounded px-2 py-1"
            value={state.targetDate}
            onChange={(e) => onDateChange(e.target.value)}
            title="Date pré-calculée pour absorber le manque. Éditable."
          />
        </label>
        <label className="block text-xs">
          <span className="text-slate-600">Au taux de</span>
          <select
            className="mt-0.5 block text-sm border border-slate-300 rounded px-2 py-1"
            value={state.pct}
            onChange={(e) => onPctChange(Number(e.target.value))}
          >
            {PCT_CHOICES.map((p) => (
              <option key={p} value={p}>
                {p} %
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}
