// =============================================================================
// COMPOSANT TaskEditor — Gantt v1.3
// =============================================================================
// Modal léger pour éditer (ou créer) une tâche / jalon : nom, type, dates,
// avancement, collaborateur, phase parent, prédécesseur, couleur.
//
// État local synchronisé sur la prop `task` (édition) ou vide (création).
// Validation côté client : end_date >= start_date + auto-recalage de
// end_date quand start_date avance (manuellement ou via un prédécesseur).
// Affichage d'un message d'erreur lisible dans le modal en cas de souci.
// La validation forte reste faite par Zod côté serveur.
//
// Règles métier :
//   • Si un PRÉDÉCESSEUR est sélectionné, la `start_date` est initialisée sur
//     sa `end_date` mais reste éditable : l'utilisateur peut décaler le début
//     plus tard. En revanche, il ne peut pas la mettre AVANT la fin du
//     prédécesseur (attribut `min` + validation côté `handleSave`).
//   • Un jalon peut servir de prédécesseur (sa date de fin == sa date de jalon).
//     Seules les phases sont exclues du menu.
//   • Quand la `start_date` change (manuellement ou via prédécesseur) et
//     dépasse la `end_date`, on recale `end_date = start_date` automatiquement.
//   • La COULEUR est éditable. Valeur initiale = couleur effective (collab >
//     défaut). Bouton "↺ Auto" pour revenir à null (= ré-hériter du collab).
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_TASK_COLOR,
  descendantIds,
  effectiveTaskColor,
  maxIso,
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
  /** Message d'erreur de validation à afficher dans le modal (null = OK). */
  const [error, setError] = useState<string | null>(null)

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
    setError(null)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [task, defaults])

  /**
   * Modifie la date de début (saisie manuelle). Recale automatiquement
   * end_date sur la nouvelle valeur si elle se retrouve antérieure
   * (préserve la cohérence end_date >= start_date sans contrarier l'utilisateur).
   *
   * @param value  Nouvelle date ISO YYYY-MM-DD (ou '' si l'input est vidé).
   */
  function handleStartDateChange(value: string) {
    setStartDate(value)
    setEndDate((current) => maxIso(current, value))
    setError(null)
  }

  /**
   * Sélectionne (ou retire) un prédécesseur. Si un nouveau prédécesseur est
   * choisi, on recale start_date sur sa end_date (sauf si l'utilisateur avait
   * déjà saisi une date plus tardive — qu'on conserve). end_date est recalée
   * pour rester ≥ start_date.
   *
   * @param value  Id du prédécesseur (ou '' pour retirer).
   */
  function handlePredecessorChange(value: string) {
    setPredecessorId(value)
    if (value) {
      const pred = tasks.find((t) => t.id === value)
      if (pred) {
        setStartDate((current) => maxIso(current, pred.end_date))
        setEndDate((current) => maxIso(current, pred.end_date))
      }
    }
    setError(null)
  }

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

  /** Liste des prédécesseurs valides : toutes les tâches OU jalons sauf
   *  elle-même et ses descendants (anti-cycle). Les phases (regroupements)
   *  sont exclues car leurs dates sont calculées automatiquement. */
  const validPredecessors = useMemo(() => {
    const isEligible = (t: Task) => t.kind === 'task' || t.kind === 'milestone'
    if (!task) return tasks.filter(isEligible)
    const banned = descendantIds(task.id, tasks)
    banned.add(task.id)
    return tasks.filter((t) => isEligible(t) && !banned.has(t.id))
  }, [task, tasks])

  /** Prédécesseur sélectionné (ou null). Sa end_date sert de borne MIN. */
  const predecessor = useMemo(
    () => (predecessorId ? tasks.find((t) => t.id === predecessorId) : null),
    [predecessorId, tasks],
  )
  /** Date minimale autorisée pour start_date (= fin du prédécesseur, ou ''). */
  const minStart = predecessor?.end_date || ''

  /**
   * Calcule le tooltip à afficher sur le champ "Début" selon le contexte.
   * Évite un ternaire imbriqué dans le JSX (cf. `sonarjs/no-nested-conditional`).
   */
  function startDateTooltip(): string | undefined {
    if (kind === 'phase') return 'Calculée automatiquement à partir des enfants'
    if (predecessor)
      return `Doit être ≥ fin du prédécesseur « ${predecessor.name} » (${minStart})`
    return undefined
  }

  /**
   * Valide les champs puis appelle onSave. Affiche un message d'erreur
   * dans le modal (au lieu d'un alert technique) si la validation échoue.
   */
  function handleSave() {
    // Validations métier ordonnées du plus simple au plus complexe.
    if (!name.trim()) {
      setError('Le nom est obligatoire.')
      return
    }
    if (!startDate) {
      setError('La date de début est obligatoire.')
      return
    }
    // Le début ne peut pas être antérieur à la fin du prédécesseur, mais
    // peut tout à fait être postérieur (décalage volontaire).
    if (predecessor && kind !== 'phase' && startDate < predecessor.end_date) {
      setError(
        `La date de début doit être ≥ fin du prédécesseur « ${predecessor.name} » (${predecessor.end_date}).`,
      )
      return
    }
    const finalEnd = kind === 'milestone' ? startDate : endDate || startDate
    if (kind !== 'milestone' && finalEnd < startDate) {
      setError(
        'La date de fin doit être supérieure ou égale à la date de début.',
      )
      return
    }
    setError(null)
    onSave({
      name: name.trim(),
      kind,
      start_date: startDate,
      end_date: finalEnd,
      progress,
      // v1.6 — Une phase n'a ni collaborateur ni prédécesseur (forcés à null
      // côté DAL aussi, mais on doublonne ici pour ne pas envoyer de bruit).
      collaborator_id: kind === 'phase' ? null : collabId || null,
      parent_id: parentId || null,
      predecessor_id: kind === 'phase' ? null : predecessorId || null,
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
          {task ? 'Modifier' : 'Nouvelle tâche / jalon / phase'}
        </h2>

        {/* Bandeau d'erreur lisible (validation locale OU erreur API
            transmise via prop ultérieurement). */}
        {error && (
          <div
            className="text-sm rounded border border-red-300 bg-red-50 text-red-700 px-3 py-2"
            role="alert"
          >
            {error}
          </div>
        )}

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
              <option value="phase">Phase (regroupement)</option>
            </select>
          </label>

          <label className="block text-sm flex-1">
            <span className="text-slate-600">Avancement (%)</span>
            <input
              type="number"
              min={0}
              max={100}
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5 disabled:bg-slate-100 disabled:text-slate-500"
              value={progress}
              onChange={(e) => setProgress(Number(e.target.value))}
              disabled={kind === 'milestone' || kind === 'phase'}
            />
          </label>
        </div>

        {/* v1.6 — Bandeau d'aide spécifique aux phases. */}
        {kind === 'phase' && (
          <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-2">
            🗂️ <strong>Phase</strong> : les dates seront calculées
            automatiquement à partir des activités enfants (début = la plus
            précoce, fin = la plus tardive). Une phase n'a pas de collaborateur
            ni de prédécesseur.
          </div>
        )}

        <div className="flex gap-2">
          <label className="block text-sm flex-1">
            <span className="text-slate-600">
              Début
              {predecessor && (
                <span
                  className="ml-1 text-xs text-slate-400"
                  title={`Minimum : ${minStart} (fin du prédécesseur)`}
                >
                  (≥ {minStart})
                </span>
              )}
            </span>
            <input
              type="date"
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5 disabled:bg-slate-100 disabled:text-slate-500"
              value={startDate}
              min={minStart || undefined}
              onChange={(e) => handleStartDateChange(e.target.value)}
              disabled={kind === 'phase'}
              title={startDateTooltip()}
            />
          </label>

          <label className="block text-sm flex-1">
            <span className="text-slate-600">Fin</span>
            <input
              type="date"
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5 disabled:bg-slate-100 disabled:text-slate-500"
              value={endDate}
              min={startDate || undefined}
              onChange={(e) => {
                setEndDate(e.target.value)
                setError(null)
              }}
              disabled={kind === 'milestone' || kind === 'phase'}
              title={
                kind === 'phase'
                  ? 'Calculée automatiquement à partir des enfants'
                  : undefined
              }
            />
          </label>
        </div>

        {/* Collaborateur — masqué pour les phases (qui n'en ont pas). */}
        {kind !== 'phase' && (
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
        )}

        <label className="block text-sm">
          <span className="text-slate-600">Phase parent</span>
          <select
            className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
          >
            <option value="">— aucune —</option>
            {/* v1.6 — Une "phase parent" doit être de kind='phase'. */}
            {tasks
              .filter((t) => t.id !== task?.id && t.kind === 'phase')
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </label>

        {/* Prédécesseur — masqué pour les phases. */}
        {kind !== 'phase' && (
          <label className="block text-sm">
            <span className="text-slate-600">
              Prédécesseur
              <span className="ml-1 text-xs text-slate-400">
                (facultatif — borne la date de début au minimum)
              </span>
            </span>
            <select
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
              value={predecessorId}
              onChange={(e) => handlePredecessorChange(e.target.value)}
            >
              <option value="">— aucun —</option>
              {validPredecessors.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.kind === 'milestone' ? '◆ ' : ''}
                  {t.name} (fin : {t.end_date})
                </option>
              ))}
            </select>
          </label>
        )}

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
                    project_id: '',
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
