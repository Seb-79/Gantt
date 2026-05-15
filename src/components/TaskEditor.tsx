// =============================================================================
// COMPOSANT TaskEditor — Gantt v1
// =============================================================================
// Modal léger pour éditer (ou créer) une tâche / jalon : nom, type, dates,
// avancement, collaborateur, parent.
//
// État local synchronisé sur la prop `task` (édition) ou vide (création).
// Validation minimale côté client : la validation forte est faite par Zod
// côté serveur.
// =============================================================================

import { useEffect, useState } from 'react'
import type { Collaborator, Task, TaskKind } from '../lib/types'

interface Props {
  /** Tâche à éditer (null = création). */
  task: Task | null
  /** Pour la création : valeurs initiales à pré-remplir (sinon vide). */
  defaults?: Partial<Task>
  /** Liste des collaborateurs disponibles dans le menu. */
  collaborators: Collaborator[]
  /** Liste des tâches existantes (pour le menu "parent"). */
  tasks: Task[]
  /** Callback de validation. Reçoit les champs édités. */
  onSave: (patch: Partial<Task>) => void
  /** Callback fermeture sans sauver. */
  onClose: () => void
  /** Callback suppression (uniquement en mode édition). */
  onDelete?: () => void
}

/** Modal d'édition. Affichée si on clique sur une tâche dans le Gantt. */
export default function TaskEditor({
  task,
  defaults,
  collaborators,
  tasks,
  onSave,
  onClose,
  onDelete,
}: Props) {
  // État local. On le réinitialise à chaque ouverture (changement de prop).
  const [name, setName] = useState('')
  const [kind, setKind] = useState<TaskKind>('task')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [progress, setProgress] = useState(0)
  const [collabId, setCollabId] = useState<string>('')
  const [parentId, setParentId] = useState<string>('')

  // Réinitialisation de l'état local à chaque ouverture (changement de
  // task ou defaults). setState dans l'effect est ici intentionnel —
  // c'est précisément ce qui permet de re-synchroniser le formulaire.
  useEffect(() => {
    const src = task || defaults || {}
    /* eslint-disable react-hooks/set-state-in-effect */
    setName(src.name || '')
    setKind(src.kind || 'task')
    setStartDate(src.start_date || '')
    setEndDate(src.end_date || src.start_date || '')
    setProgress(src.progress ?? 0)
    setCollabId(src.collaborator_id || '')
    setParentId(src.parent_id || '')
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [task, defaults])

  /** Construit le patch et appelle onSave. */
  function handleSave() {
    if (!name.trim() || !startDate) return
    onSave({
      name: name.trim(),
      kind,
      start_date: startDate,
      end_date: kind === 'milestone' ? startDate : endDate || startDate,
      progress,
      collaborator_id: collabId || null,
      parent_id: parentId || null,
    })
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">
          {task ? 'Modifier' : 'Nouvelle tâche / jalon'}
        </h2>

        <label className="block text-sm">
          <span className="text-slate-600">Nom</span>
          <input
            className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>

        <div className="flex gap-2">
          <label className="block text-sm flex-1">
            <span className="text-slate-600">Type</span>
            <select
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
              value={kind}
              onChange={(e) => setKind(e.target.value as TaskKind)}
            >
              <option value="task">Tâche</option>
              <option value="milestone">Jalon</option>
            </select>
          </label>

          <label className="block text-sm flex-1">
            <span className="text-slate-600">Avancement (%)</span>
            <input
              type="number"
              min={0}
              max={100}
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
              value={progress}
              onChange={(e) => setProgress(Number(e.target.value))}
              disabled={kind === 'milestone'}
            />
          </label>
        </div>

        <div className="flex gap-2">
          <label className="block text-sm flex-1">
            <span className="text-slate-600">Début</span>
            <input
              type="date"
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>

          <label className="block text-sm flex-1">
            <span className="text-slate-600">Fin</span>
            <input
              type="date"
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              disabled={kind === 'milestone'}
            />
          </label>
        </div>

        <label className="block text-sm">
          <span className="text-slate-600">Collaborateur</span>
          <select
            className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
            value={collabId}
            onChange={(e) => setCollabId(e.target.value)}
          >
            <option value="">— aucun —</option>
            {collaborators.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="text-slate-600">Phase parent</span>
          <select
            className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
          >
            <option value="">— aucune —</option>
            {tasks
              .filter((t) => t.id !== task?.id && t.kind === 'task')
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </label>

        <div className="flex justify-between pt-2">
          {task && onDelete ? (
            <button
              className="px-3 py-1.5 text-sm rounded border border-red-300 text-red-600 hover:bg-red-50"
              onClick={onDelete}
            >
              Supprimer
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              className="px-3 py-1.5 text-sm rounded border border-slate-300 hover:bg-slate-50"
              onClick={onClose}
            >
              Annuler
            </button>
            <button
              className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
              onClick={handleSave}
            >
              {task ? 'Enregistrer' : 'Créer'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
