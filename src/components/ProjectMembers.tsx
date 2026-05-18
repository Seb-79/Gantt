// =============================================================================
// COMPOSANT ProjectMembers — Gantt v2.0 / F1 + F2
// =============================================================================
// Onglet « Affectation projet » : affiche la liste des collaborateurs membres
// du projet courant ET, pour chacun, ses périodes d'allocation %.
//
// Règles métier v2.0 :
//   • RG-GANTT-1200 : un collaborateur ne peut être affecté à une tâche d'un
//     projet QUE s'il en est membre.
//   • RG-GANTT-1201 : un collaborateur est membre d'un projet si une ligne
//     `(project_id, collaborator_id)` existe dans `project_members`.
//   • RG-GANTT-1202 : à la migration v2.0, chaque couple distinct
//     (projet, collab) déjà présent dans `tasks` devient automatiquement une
//     membership (cf. `ensureProjectMembersTable` côté DAL).
//   • RG-GANTT-1300 (F2) : une activité affectée à un collab a sa fin
//     calculée en consommant l'allocation % du collab jour par jour.
//   • RG-GANTT-1301 (F2) : deux périodes ne peuvent pas se chevaucher pour
//     un même (projet, collab).
//   • RG-GANTT-1302 (F2) : % ∈ {25, 50, 75, 100}.
//
// Pas de suppression de membership en F1/F2 (décision utilisateur). On peut
// en revanche supprimer une PÉRIODE d'allocation, utile pour corriger une
// saisie ou réduire la dispo d'un collab.
// =============================================================================

import { useMemo, useState } from 'react'
import type { Collaborator, MemberAllocation } from '../lib/types'

interface Props {
  /** Tous les collaborateurs connus (vivier dans lequel on pioche pour ajouter). */
  collaborators: Collaborator[]
  /** Ids des collabs déjà membres du projet courant. */
  memberIds: string[]
  /** v2.0 / F2 — Toutes les allocations du projet courant (toutes paires confondues). */
  memberAllocations: MemberAllocation[]
  /** Nom du projet courant (pour le titre — null si base vide). */
  projectName: string | null
  /** Id du projet courant (null = base vide). */
  projectId: string | null
  /** Callback d'ajout d'un membership (le parent gère le POST API + refresh). */
  onAddMember: (collaboratorId: string) => void
  /** v2.0 / F2 — Callback d'ajout d'une période d'allocation pour un membre. */
  onAddAllocation: (
    collaboratorId: string,
    body: { start_date: string; end_date: string; allocation_pct: number },
  ) => void
  /** v2.0 / F2 — Callback de suppression d'une période par son id. */
  onDeleteAllocation: (allocationId: string) => void
}

/**
 * Vue « Affectation projet » du projet courant. Composant 100 % présentationnel :
 * il reçoit la liste des membres + leurs allocations et délègue les mutations
 * au parent (qui pilote l'API + le refetch /api/state).
 */
export default function ProjectMembers({
  collaborators,
  memberIds,
  memberAllocations,
  projectName,
  projectId,
  onAddMember,
  onAddAllocation,
  onDeleteAllocation,
}: Props) {
  /** Id du collab sélectionné dans la dropdown d'ajout (vide = aucun). */
  const [picked, setPicked] = useState<string>('')

  /** Set des ids déjà membres pour partager rapidement entre les vues. */
  const memberSet = useMemo(() => new Set(memberIds), [memberIds])

  /** Collabs membres du projet, dans l'ordre d'affichage global. */
  const members = useMemo(
    () => collaborators.filter((c) => memberSet.has(c.id)),
    [collaborators, memberSet],
  )

  /** Collabs encore disponibles à l'ajout (pas encore membres). */
  const candidates = useMemo(
    () => collaborators.filter((c) => !memberSet.has(c.id)),
    [collaborators, memberSet],
  )

  /**
   * Allocations indexées par collab pour un rendu rapide. Trie par date de
   * début ascendante (cohérent avec le serveur).
   */
  const allocationsByCollab = useMemo(() => {
    const m = new Map<string, MemberAllocation[]>()
    for (const a of memberAllocations) {
      const arr = m.get(a.collaborator_id) || []
      arr.push(a)
      m.set(a.collaborator_id, arr)
    }
    for (const arr of m.values()) {
      arr.sort((x, y) => x.start_date.localeCompare(y.start_date))
    }
    return m
  }, [memberAllocations])

  /**
   * Soumission du formulaire d'ajout de collab.
   */
  function handleAdd() {
    if (!picked) return
    onAddMember(picked)
    setPicked('')
  }

  // Cas particulier : aucun projet courant (base totalement vide).
  if (!projectName || !projectId) {
    return (
      <div className="p-6 text-slate-500 text-sm">
        Aucun projet sélectionné. Créez un projet pour pouvoir y affecter des
        collaborateurs.
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      <header>
        <h2 className="text-lg font-semibold">
          Affectation projet — {projectName}
        </h2>
        <p className="text-sm text-slate-600">
          Liste des collaborateurs membres de ce projet et de leurs périodes
          d'allocation (en %). La date de fin d'une activité est calculée à
          partir de la charge et du rythme d'allocation du collaborateur.
        </p>
      </header>

      {/* Liste des membres + sous-section périodes par membre. */}
      <section>
        <h3 className="text-sm font-medium text-slate-700 mb-2">
          Membres ({members.length})
        </h3>
        {members.length === 0 ? (
          <p className="text-sm text-slate-500 italic">
            Aucun membre pour l'instant. Ajoutez un collaborateur via le
            formulaire en bas de page.
          </p>
        ) : (
          <ul className="space-y-3">
            {members.map((c) => (
              <MemberRow
                key={c.id}
                collab={c}
                allocations={allocationsByCollab.get(c.id) || []}
                onAdd={(body) => onAddAllocation(c.id, body)}
                onDelete={onDeleteAllocation}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Formulaire d'ajout de membre. Masqué si tous les collabs sont déjà
          membres (rien d'utile à proposer). */}
      {candidates.length > 0 && (
        <section className="border-t border-slate-200 pt-4">
          <h3 className="text-sm font-medium text-slate-700 mb-2">
            Ajouter un collaborateur au projet
          </h3>
          <div className="flex gap-2 items-end">
            <label className="block text-sm flex-1">
              <span className="text-slate-600">Collaborateur</span>
              <select
                className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
                value={picked}
                onChange={(e) => setPicked(e.target.value)}
              >
                <option value="">— choisir —</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={handleAdd}
              disabled={!picked}
              className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
            >
              Ajouter
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

/**
 * v2.0 / F2 — Ligne d'un membre avec sa pastille de couleur, son nom et la
 * liste de ses périodes d'allocation. Inclut un mini-formulaire d'ajout
 * (dates + %) et un bouton de suppression par période.
 *
 * Extrait dans son propre composant pour limiter la complexité cognitive
 * de `ProjectMembers` (chaque ligne porte son propre état de formulaire).
 */
function MemberRow({
  collab,
  allocations,
  onAdd,
  onDelete,
}: {
  collab: Collaborator
  allocations: MemberAllocation[]
  onAdd: (body: {
    start_date: string
    end_date: string
    allocation_pct: number
  }) => void
  onDelete: (id: string) => void
}) {
  /** État local du mini-formulaire d'ajout de période. */
  const [start, setStart] = useState<string>('')
  const [end, setEnd] = useState<string>('')
  const [pct, setPct] = useState<number>(100)
  /** Affiche/masque le formulaire pour ne pas encombrer chaque ligne. */
  const [open, setOpen] = useState<boolean>(false)

  /**
   * Soumission du formulaire local. Validations simples côté client (le
   * serveur a le dernier mot : % autorisés, no-overlap, dates).
   */
  function submit() {
    if (!start || !end) return
    if (end < start) return
    onAdd({ start_date: start, end_date: end, allocation_pct: pct })
    // Reset du formulaire pour permettre d'enchaîner plusieurs périodes.
    setStart('')
    setEnd('')
    setPct(100)
    setOpen(false)
  }

  return (
    <li className="border border-slate-200 rounded p-3">
      <div className="flex items-center gap-2">
        <span
          className="inline-block w-3 h-3 rounded-full border border-slate-300"
          style={{ backgroundColor: collab.color }}
          aria-hidden
        />
        <span className="text-sm font-medium flex-1">{collab.name}</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-100"
        >
          {open ? 'Annuler' : '+ Période'}
        </button>
      </div>

      {/* Liste des périodes existantes. */}
      {allocations.length > 0 && (
        <ul className="mt-2 space-y-1">
          {allocations.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 text-xs text-slate-700 pl-5"
            >
              <span className="font-mono">
                {a.start_date} → {a.end_date}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-medium">
                {a.allocation_pct} %
              </span>
              <button
                type="button"
                onClick={() => onDelete(a.id)}
                className="text-red-600 hover:text-red-700 ml-auto"
                title="Supprimer cette période"
              >
                🗑
              </button>
            </li>
          ))}
        </ul>
      )}

      {allocations.length === 0 && (
        <p className="mt-2 pl-5 text-xs text-amber-700">
          Aucune période d'allocation : ce collab n'a aucune capacité sur le
          projet. Ajoutez au moins une période pour qu'il puisse travailler.
        </p>
      )}

      {/* Formulaire d'ajout de période (toggle). */}
      {open && (
        <div className="mt-3 pl-5 flex flex-wrap items-end gap-2">
          <label className="block text-xs">
            <span className="text-slate-600">Du</span>
            <input
              type="date"
              className="mt-0.5 block border border-slate-300 rounded px-2 py-1 text-xs"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label className="block text-xs">
            <span className="text-slate-600">Au</span>
            <input
              type="date"
              className="mt-0.5 block border border-slate-300 rounded px-2 py-1 text-xs"
              value={end}
              min={start || undefined}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <label className="block text-xs">
            <span className="text-slate-600">Allocation</span>
            <select
              className="mt-0.5 block border border-slate-300 rounded px-2 py-1 text-xs"
              value={pct}
              onChange={(e) => setPct(Number(e.target.value))}
            >
              <option value={25}>25 %</option>
              <option value={50}>50 %</option>
              <option value={75}>75 %</option>
              <option value={100}>100 %</option>
            </select>
          </label>
          <button
            type="button"
            onClick={submit}
            disabled={!start || !end || end < start}
            className="px-3 py-1 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            Ajouter la période
          </button>
        </div>
      )}
    </li>
  )
}
