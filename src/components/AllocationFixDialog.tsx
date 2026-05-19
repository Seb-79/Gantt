// =============================================================================
// COMPOSANT AllocationFixDialog — Gantt v2.1 / F2.9
// =============================================================================
// Modal de résolution affichée quand la sauvegarde d'une activité est bloquée
// par un manque d'allocation des collaborateurs affectés (RG-GANTT-1500).
//
// L'utilisateur a 3 sorties possibles :
//   1. « Modifier manuellement » → on ferme le TaskEditor pour qu'il aille
//      dans l'onglet Affectation ajuster les % / dates lui-même.
//   2. « Étendre l'allocation » → il choisit la date cible (pré-calculée mais
//      éditable, Q3=C) et le taux (25/50/75/100). Le parent exécute le plan
//      d'extension (POST/PATCH allocations) puis enchaîne la sauvegarde.
//   3. « Annuler » → ferme uniquement ce dialog, retour au TaskEditor.
//
// Composant 100 % présentationnel : il NE FAIT PAS d'appel API.
// Il construit un `ExtensionPlan` via le helper pur `computeExtensionPlan` et
// le transmet au parent via `onApply(plan)`.
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

interface Props {
  /** Tâche en cours d'édition (pour titre + contexte). */
  taskName: string
  /** Charge totale (jours ouvrés) — affichée pour rappel. */
  charge: number
  /** Date de début de la tâche (YYYY-MM-DD). */
  startDate: string
  /** Bilan d'absorption calculé par `computeAllocationShortfall`. */
  shortfall: AllocationShortfall
  /** Ids des collaborateurs affectés (limitants compris). */
  collaboratorIds: string[]
  /** Projet de la tâche. */
  projectId: string
  /** Liste complète des collaborateurs (pour résoudre noms / couleurs). */
  collaborators: Collaborator[]
  /** Allocations actuelles connues (toutes paires). */
  allocations: MemberAllocation[]
  /** Absences cross-projet (pour la simulation). */
  absences: CollaboratorAbsence[]
  /** Callback « Appliquer et sauvegarder » — reçoit le plan à exécuter. */
  onApply: (plan: ExtensionPlan) => void
  /** Callback « Modifier manuellement » — ferme tout, l'user va dans Affectation. */
  onCancelToManual: () => void
  /** Callback « Annuler » — ferme le dialog seul, reste sur le TaskEditor. */
  onAbort: () => void
}

/** Choix de taux possible (cohérent avec les périodes côté ProjectMembers). */
const PCT_CHOICES = [25, 50, 75, 100] as const

/**
 * v2.1 / F2.9 — Dialog de résolution d'un manque d'allocation.
 *
 * @param props  Cf. interface ci-dessus.
 */
export default function AllocationFixDialog({
  taskName,
  charge,
  startDate,
  shortfall,
  collaboratorIds,
  projectId,
  collaborators,
  allocations,
  absences,
  onApply,
  onCancelToManual,
  onAbort,
}: Props) {
  /** Taux d'extension choisi par le user (défaut 100 %). */
  const [pct, setPct] = useState<number>(100)
  /** Date cible (initialisée depuis le helper, éditable Q3=C). */
  const initialPlan = useMemo(
    () =>
      computeExtensionPlan({
        startDate,
        missing: shortfall.missing,
        collaboratorIds,
        projectId,
        allocations,
        absences,
        pct: 100,
      }),
    // initialPlan est figé : on initialise une seule fois sur le premier
    // rendu. Le state `targetDate` ci-dessous remplace ensuite (mutable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const [targetDate, setTargetDate] = useState<string>(
    initialPlan.targetEndDate,
  )
  /** Plan reconstruit à chaque changement de pct ou targetDate. */
  const plan = useMemo<ExtensionPlan>(() => {
    // Recalcule SEULEMENT la date proposée quand pct change. Si l'utilisateur
    // a déjà saisi une date manuelle (différente de la suggestion auto), on
    // ne l'écrase pas → on respecte la saisie utilisateur. La date courante
    // sert de `targetEndDate` dans le plan retourné.
    const auto = computeExtensionPlan({
      startDate,
      missing: shortfall.missing,
      collaboratorIds,
      projectId,
      allocations,
      absences,
      pct,
    })
    // Si la targetDate du state est antérieure à celle auto-calculée, on la
    // remonte au minimum (sinon la simulation est incohérente avec la date).
    const finalDate =
      targetDate < auto.targetEndDate ? auto.targetEndDate : targetDate
    return {
      ...auto,
      targetEndDate: finalDate,
      operations: auto.operations.map((op) => ({
        ...op,
        endDate: finalDate,
      })),
    }
  }, [
    pct,
    targetDate,
    startDate,
    shortfall.missing,
    collaboratorIds,
    projectId,
    allocations,
    absences,
  ])

  // Recalcule la date proposée à chaque changement de pct (« réagit » au
  // changement). On n'utilise pas useEffect pour éviter une boucle ; on
  // compare et on met à jour seulement si l'utilisateur n'a pas déjà saisi
  // une date plus tardive.
  function handlePctChange(next: number) {
    setPct(next)
    // Quand le pct baisse, la date auto recule plus tard → on resynchronise.
    // Quand le pct monte, la date auto recule avant → on garde la saisie
    // utilisateur si elle reste valide (≥ auto).
    const auto = computeExtensionPlan({
      startDate,
      missing: shortfall.missing,
      collaboratorIds,
      projectId,
      allocations,
      absences,
      pct: next,
    })
    if (targetDate < auto.targetEndDate) {
      setTargetDate(auto.targetEndDate)
    }
  }

  // Résolution des noms + couleurs des collabs affectés (pour affichage).
  const affectedCollabs = useMemo(
    () =>
      collaboratorIds
        .map((id) => collaborators.find((c) => c.id === id))
        .filter((c): c is Collaborator => !!c),
    [collaboratorIds, collaborators],
  )

  // Date min pour le picker = date proposée par l'algo (interdit de saisir
  // une date trop tôt qui n'absorberait pas le manque).
  const minDate = plan.targetEndDate

  // Texte explicatif sur les opérations qui seront effectuées.
  const opSummary = useMemo(() => {
    const patched = plan.operations.filter((o) => o.kind === 'patch').length
    const created = plan.operations.filter((o) => o.kind === 'create').length
    const parts: string[] = []
    if (patched > 0)
      parts.push(
        `${patched} allocation${patched > 1 ? 's' : ''} prolongée${patched > 1 ? 's' : ''}`,
      )
    if (created > 0)
      parts.push(
        `${created} nouvelle${created > 1 ? 's' : ''} allocation${created > 1 ? 's' : ''}`,
      )
    return parts.join(' + ') || 'aucune opération'
  }, [plan.operations])

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-[70] p-4"
      onClick={onAbort}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 pt-3 pb-2 border-b border-slate-100">
          <h2 className="text-base font-semibold text-amber-900">
            ⚠ Allocation insuffisante
          </h2>
          <p className="text-xs text-slate-600 mt-1">
            La tâche <strong>« {taskName || 'sans nom'} »</strong> nécessite{' '}
            <strong>
              {charge} jour{charge > 1 ? 's' : ''}
            </strong>{' '}
            de charge.
            {shortfall.absorbed > 0 ? (
              <>
                {' '}
                Les allocations actuelles couvrent{' '}
                <strong>
                  {shortfall.absorbed.toFixed(2)} jour
                  {shortfall.absorbed > 1 ? 's' : ''}
                </strong>
                . Il manque{' '}
                <strong className="text-red-700">
                  {shortfall.missing.toFixed(2)} jour
                  {shortfall.missing > 1 ? 's' : ''}
                </strong>
                .
              </>
            ) : (
              <>
                {' '}
                Aucun jour ne peut être absorbé avec les allocations actuelles.
              </>
            )}
          </p>
        </div>

        {/* Corps */}
        <div className="px-4 py-3 space-y-3 text-xs">
          {/* Collabs concernés */}
          <div>
            <div className="text-slate-600 mb-1">
              Collaborateur(s) concerné(s) :
            </div>
            <div className="flex flex-wrap gap-1.5">
              {affectedCollabs.map((c) => (
                <span
                  key={c.id}
                  className="inline-flex items-center gap-1 bg-slate-100 border border-slate-300 rounded-full pl-1 pr-2 py-0.5"
                >
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: c.color }}
                    aria-hidden
                  />
                  <span className="font-medium">{c.name}</span>
                </span>
              ))}
            </div>
            {shortfall.horizon && (
              <p className="text-slate-500 mt-1">
                Dernière allocation jusqu'au :{' '}
                <span className="font-mono">{shortfall.horizon}</span>
              </p>
            )}
          </div>

          {/* Section EXTENSION */}
          <div className="border border-slate-200 rounded p-3 space-y-2 bg-slate-50">
            <p className="font-medium text-slate-700">
              Étendre l'allocation pour résoudre :
            </p>

            <div className="flex gap-2">
              <label className="block flex-1">
                <span className="text-slate-600">Jusqu'au</span>
                <input
                  type="date"
                  className="mt-0.5 block w-full text-sm border border-slate-300 rounded px-2 py-1"
                  value={targetDate}
                  min={minDate}
                  onChange={(e) => setTargetDate(e.target.value)}
                  title="Date pré-calculée pour absorber le manque. Éditable."
                />
              </label>
              <label className="block w-32">
                <span className="text-slate-600">Au taux de</span>
                <select
                  className="mt-0.5 block w-full text-sm border border-slate-300 rounded px-2 py-1"
                  value={pct}
                  onChange={(e) => handlePctChange(Number(e.target.value))}
                >
                  {PCT_CHOICES.map((p) => (
                    <option key={p} value={p}>
                      {p} %
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <p className="text-slate-500 italic">
              {plan.feasible
                ? `${opSummary}.`
                : "⚠ Impossible de calculer une date d'extension absorbant le manque (vérifier le taux)."}
            </p>
          </div>

          {/* Alternative manuelle */}
          <div className="border border-slate-200 rounded p-3 space-y-1">
            <p className="font-medium text-slate-700">
              Ou modifier manuellement :
            </p>
            <p className="text-slate-500">
              Fermer cette boîte pour aller ajuster les affectations dans
              l'onglet « Affectation ».
            </p>
            <button
              type="button"
              onClick={onCancelToManual}
              className="text-blue-700 hover:underline"
            >
              → Aller dans Affectation
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-slate-100 flex justify-end gap-2">
          <button
            type="button"
            onClick={onAbort}
            className="px-2.5 py-1 text-xs rounded border border-slate-300 hover:bg-slate-50"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={() => onApply(plan)}
            disabled={!plan.feasible}
            className="px-2.5 py-1 text-xs rounded bg-amber-700 text-white hover:bg-amber-800 disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            Appliquer et sauvegarder
          </button>
        </div>
      </div>
    </div>
  )
}
