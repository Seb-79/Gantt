// =============================================================================
// ProjectSettingsModal — Modal de modification d'un projet (v2.3 / RG-GANTT-2101)
// =============================================================================
// Ouverte via le bouton crayon ✏️ déjà présent dans la barre du sélecteur de
// projet. Permet de modifier :
//   • le NOM du projet ;
//   • la DATE DE DÉMARRAGE (RG-GANTT-2100).
//
// Validation RG-GANTT-2110 côté client (défense en profondeur, le serveur
// re-valide aussi) : la nouvelle date ne peut pas être postérieure à la
// `start_date` d'au moins une activité du projet ayant `progress > 0`.
//
// À l'enregistrement, si `project_start_date` a changé, propose un Replan
// immédiat (case cochée par défaut, opt-out, même pattern que RG-GANTT-0909).
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import type { Project, Task } from '../lib/types'

type Props = {
  /** Projet à éditer. `null` ferme la modal. */
  project: Project | null
  /** Tâches du projet (pour la validation RG-2110). */
  tasks: Task[]
  /** Callback à l'enregistrement. `replanRequested` vaut `true` si la date a
   *  changé ET que la case "Replanifier après enregistrement" est cochée. */
  onSave: (
    patch: { name?: string; project_start_date?: string },
    replanRequested: boolean,
  ) => void
  /** Callback à l'annulation / fermeture de la modal. */
  onClose: () => void
}

/**
 * v2.3 / RG-GANTT-2101 — Modal "Paramètres du projet" (nom + date de démarrage).
 *
 * Le composant est contrôlé : il est rendu uniquement si `project` est non null.
 * Toute fermeture appelle `onClose` ; toute validation appelle `onSave` avec
 * le patch et un flag `replanRequested`.
 */
export default function ProjectSettingsModal({
  project,
  tasks,
  onSave,
  onClose,
}: Props) {
  // États locaux du formulaire (synchronisés à l'ouverture).
  const [name, setName] = useState('')
  const [startDate, setStartDate] = useState('')
  const [replanAfter, setReplanAfter] = useState(true)

  // Synchronise les états à chaque ouverture (changement de project).
  // Pattern intentionnel : on remet l'état local au snapshot du projet à
  // chaque ouverture pour que les changements non sauvegardés d'une ouverture
  // précédente ne fuient pas. Pas de cascade rendering grave ici (les
  // setState sont stables à la première frame quand `project` change).
  useEffect(() => {
    if (!project) return
    /* eslint-disable react-hooks/set-state-in-effect */
    setName(project.name)
    setStartDate(project.project_start_date)
    setReplanAfter(true)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [project])

  // v2.3 / RG-GANTT-2110 — Validation : la nouvelle date ne doit pas être
  // postérieure à la start_date d'une tâche du projet à progress > 0.
  // Calcul de la plus précoce des start_date des tâches "en cours/terminées".
  const minAllowedDate = useMemo(() => {
    if (!project) return null
    const inProgress = tasks.filter(
      (t) =>
        t.project_id === project.id &&
        t.kind === 'task' &&
        (t.progress ?? 0) > 0,
    )
    if (inProgress.length === 0) return null
    return inProgress.reduce(
      (min, t) => (t.start_date < min ? t.start_date : min),
      inProgress[0].start_date,
    )
  }, [project, tasks])

  // Tâche en conflit, pour le message d'erreur (si applicable).
  const conflictingTask = useMemo(() => {
    if (!project || !minAllowedDate) return null
    if (startDate <= minAllowedDate) return null
    return tasks.find(
      (t) =>
        t.project_id === project.id &&
        t.kind === 'task' &&
        (t.progress ?? 0) > 0 &&
        t.start_date === minAllowedDate,
    )
  }, [project, tasks, minAllowedDate, startDate])

  if (!project) return null

  // Détection des changements pour activer/désactiver le bouton "Enregistrer"
  // et savoir si on doit proposer un Replan.
  const nameChanged = name.trim() !== project.name
  const dateChanged = startDate !== project.project_start_date
  const hasChanges = nameChanged || dateChanged
  const hasError = !!conflictingTask
  const canSave = hasChanges && !hasError && name.trim().length > 0

  const handleSubmit = () => {
    if (!canSave) return
    const patch: { name?: string; project_start_date?: string } = {}
    if (nameChanged) patch.name = name.trim()
    if (dateChanged) patch.project_start_date = startDate
    onSave(patch, dateChanged && replanAfter)
  }

  return (
    // Backdrop semi-transparent + modale centrée.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-white rounded-lg shadow-xl p-6 w-[480px] max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Paramètres du projet"
      >
        <h2 className="text-lg font-semibold mb-4">Paramètres du projet</h2>

        {/* Champ : nom du projet */}
        <label className="block mb-4">
          <span className="text-sm font-medium text-slate-700">
            Nom du projet
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>

        {/* Champ : date de démarrage du projet (RG-GANTT-2100) */}
        <label className="block mb-2">
          <span className="text-sm font-medium text-slate-700">
            Date de démarrage du projet
          </span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className={`mt-1 w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 ${
              hasError
                ? 'border-red-500 focus:ring-red-500'
                : 'border-slate-300 focus:ring-blue-500'
            }`}
          />
        </label>

        {/* Message d'erreur RG-2110 si conflit avec une tâche en cours */}
        {conflictingTask && (
          <p className="text-xs text-red-600 mb-3">
            Impossible de définir la date de démarrage au {startDate} : la tâche
            « {conflictingTask.name} » est déjà démarrée le{' '}
            {conflictingTask.start_date}. Choisissez une date antérieure ou
            éditez d'abord la tâche.
          </p>
        )}

        {/* Aide visuelle */}
        <p className="text-xs text-slate-500 mb-4">
          La date peut être dans le passé ou le futur. Elle sert de borne basse
          par défaut pour le Replan (chaque activité est replanifiée à partir de
          cette date au plus tôt).
        </p>

        {/* Case à cocher "Replanifier après" (visible UNIQUEMENT si la date a changé) */}
        {dateChanged && (
          <label className="flex items-center gap-2 text-sm mb-4">
            <input
              type="checkbox"
              checked={replanAfter}
              onChange={(e) => setReplanAfter(e.target.checked)}
            />
            <span>
              Replanifier immédiatement après l'enregistrement (recommandé)
            </span>
          </label>
        )}

        {/* Boutons */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
          >
            Annuler
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSave}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            Enregistrer
          </button>
        </div>
      </div>
    </div>
  )
}
