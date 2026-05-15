// =============================================================================
// COMPOSANT TaskEditor — Gantt v1.2
// =============================================================================
// Modal léger pour éditer (ou créer) une tâche / jalon : nom, type, dates,
// avancement, collaborateur, phase parent, prédécesseur, couleur.
//
// État local synchronisé sur la prop `task` (édition) ou vide (création).
// Validation minimale côté client : la validation forte est faite par Zod
// côté serveur.
//
// Règles métier (v1.2) :
//   • Si un PRÉDÉCESSEUR est sélectionné, la `start_date` est forcée sur la
//     `end_date` du prédécesseur ET le champ Début est grisé. Pour reprendre
//     la main sur la date, l'utilisateur doit retirer le prédécesseur.
//   • La COULEUR est éditable. Valeur initiale = couleur effective (collab >
//     défaut). Bouton "↺ Auto" pour revenir à null (= ré-hériter du collab).
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_TASK_COLOR,
  descendantIds,
  effectiveTaskColor,
} from '../lib/utils'
import type { Collaborator, Task, TaskKind } from '../lib/types'

interface Props {
  /** Tâche à éditer (null = création). */
  task: Task | null
  /** Pour la création : valeurs initiales à pré-remplir (sinon vide). */
  defaults?: Partial<Task>
  /** Liste des collaborateurs disponibles dans le menu. */
  collaborators: Collaborator[]
  /** Liste des tâches existantes (pour les menus parent / prédécesseur). */
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
  const [predecessorId, setPredecessorId] = useState<string>('')
  /** Couleur custom (hex, vide = utiliser la couleur effective). */
  const [color, setColor] = useState<string>('')

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
    setPredecessorId(src.predecessor_id || '')
    setColor(src.color || '')
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [task, defaults])

  /**
   * Couleur "proposée par défaut" pour le picker quand l'utilisateur n'a
   * pas défini de couleur custom. = couleur du collab si présent, sinon
   * couleur grise par défaut.
   */
  const defaultColor = useMemo(() => {
    if (collabId) {
      const c = collaborators.find((x) => x.id === collabId)
      if (c) return c.color
    }
    return DEFAULT_TASK_COLOR
  }, [collabId, collaborators])

  /** Liste des prédécesseurs valides : toutes les tâches sauf elle-même
   *  et ses descendants (anti-cycle), et qui ont une end_date. */
  const validPredecessors = useMemo(() => {
    if (!task) return tasks.filter((t) => t.kind === 'task')
    const banned = descendantIds(task.id, tasks)
    banned.add(task.id)
    return tasks.filter((t) => !banned.has(t.id))
  }, [task, tasks])

  /** Si un prédécesseur est sélectionné, on force la start_date affichée. */
  const predecessor = useMemo(
    () => (predecessorId ? tasks.find((t) => t.id === predecessorId) : null),
    [predecessorId, tasks],
  )
  const lockedStart = predecessor?.end_date || ''
  const effectiveStart = predecessor ? lockedStart : startDate

  /** Construit le patch et appelle onSave. */
  function handleSave() {
    if (!name.trim() || !effectiveStart) return
    onSave({
      name: name.trim(),
      kind,
      start_date: effectiveStart,
      end_date:
        kind === 'milestone' ? effectiveStart : endDate || effectiveStart,
      progress,
      collaborator_id: collabId || null,
      parent_id: parentId || null,
      predecessor_id: predecessorId || null,
      // color: '' (vide) → null (= hériter automatiquement)
      color: color || null,
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
            <span className="text-slate-600">
              Début
              {predecessor && (
                <span className="ml-1 text-xs text-slate-400">
                  (verrouillé)
                </span>
              )}
            </span>
            <input
              type="date"
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5 disabled:bg-slate-100 disabled:text-slate-500"
              value={effectiveStart}
              onChange={(e) => setStartDate(e.target.value)}
              disabled={!!predecessor}
              title={
                predecessor
                  ? `Forcée à la fin du prédécesseur « ${predecessor.name} »`
                  : undefined
              }
            />
          </label>

          <label className="block text-sm flex-1">
            <span className="text-slate-600">Fin</span>
            <input
              type="date"
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5 disabled:bg-slate-100 disabled:text-slate-500"
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

        <label className="block text-sm">
          <span className="text-slate-600">
            Prédécesseur
            <span className="ml-1 text-xs text-slate-400">
              (facultatif — verrouille la date de début)
            </span>
          </span>
          <select
            className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
            value={predecessorId}
            onChange={(e) => setPredecessorId(e.target.value)}
          >
            <option value="">— aucun —</option>
            {validPredecessors.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} (fin : {t.end_date})
              </option>
            ))}
          </select>
        </label>

        {/* COULEUR — éditable, par défaut = couleur effective */}
        <div className="block text-sm">
          <span className="text-slate-600">Couleur de la barre</span>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="color"
              className="h-9 w-14 border border-slate-300 rounded cursor-pointer"
              value={
                color ||
                effectiveTaskColor(
                  // tâche fictive juste pour le calcul de couleur effective
                  {
                    id: '',
                    name: '',
                    kind: 'task',
                    start_date: '',
                    end_date: '',
                    progress: 0,
                    collaborator_id: collabId || null,
                    color: null,
                    parent_id: null,
                    predecessor_id: null,
                    position: 0,
                  },
                  collaborators,
                )
              }
              onChange={(e) => setColor(e.target.value)}
              title="Choisir une couleur personnalisée"
            />
            <span className="text-xs text-slate-500 flex-1">
              {color ? (
                <>Couleur personnalisée : {color}</>
              ) : (
                <>
                  Auto :{' '}
                  <span
                    className="inline-block w-3 h-3 rounded align-middle mr-1"
                    style={{ backgroundColor: defaultColor }}
                  />
                  hérite du collaborateur
                </>
              )}
            </span>
            {color && (
              <button
                type="button"
                className="px-2 py-1 text-xs rounded border border-slate-300 hover:bg-slate-100"
                onClick={() => setColor('')}
                title="Repasser en automatique (hérite du collaborateur)"
              >
                ↺ Auto
              </button>
            )}
          </div>
        </div>

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
