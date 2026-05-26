// =============================================================================
// CreateProjectDialog — Dialog de création de projet (v2.3 / RG-GANTT-2100)
// =============================================================================
// Ouverte via le bouton ➕ déjà présent dans la barre du sélecteur de projet.
// Remplace l'ancien `askPrompt` qui ne demandait que le nom.
//
// Demande :
//   • le NOM du projet ;
//   • la DATE DE DÉMARRAGE (RG-GANTT-2100), défaut = `today`.
//
// La date peut être dans le passé ou le futur sans restriction. Pas de
// validation RG-2110 ici : à la création le projet n'a pas encore de tâches.
// =============================================================================

import { useEffect, useState } from 'react'

type Props = {
  /** `true` ouvre la modal ; `false` la cache. */
  open: boolean
  /** Callback à la création (l'appelant gère le POST API). */
  onCreate: (input: { name: string; project_start_date: string }) => void
  /** Callback à l'annulation / fermeture. */
  onClose: () => void
}

/**
 * v2.3 / RG-GANTT-2100 — Dialog de création de projet (nom + date démarrage).
 *
 * Le composant est contrôlé : il est rendu uniquement si `open` est `true`.
 */
export default function CreateProjectDialog({
  open,
  onCreate,
  onClose,
}: Props) {
  // États locaux du formulaire (réinitialisés à chaque ouverture).
  const [name, setName] = useState('')
  const [startDate, setStartDate] = useState('')

  // Réinitialise les champs à chaque ouverture (pattern intentionnel : reset
  // au snapshot par défaut quand `open` passe de false à true).
  useEffect(() => {
    if (open) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setName('Nouveau projet')
      // v2.3 — Défaut = today (ISO YYYY-MM-DD).
      setStartDate(new Date(Date.now()).toISOString().slice(0, 10))
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [open])

  if (!open) return null

  const canSubmit =
    name.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(startDate)

  const handleSubmit = () => {
    if (!canSubmit) return
    onCreate({ name: name.trim(), project_start_date: startDate })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-white rounded-lg shadow-xl p-6 w-[480px] max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Créer un projet"
      >
        <h2 className="text-lg font-semibold mb-4">Créer un projet</h2>

        {/* Champ : nom du projet */}
        <label className="block mb-4">
          <span className="text-sm font-medium text-slate-700">
            Nom du projet
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            className="mt-1 w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>

        {/* Champ : date de démarrage (RG-GANTT-2100) */}
        <label className="block mb-2">
          <span className="text-sm font-medium text-slate-700">
            Date de démarrage du projet
          </span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="mt-1 w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>

        <p className="text-xs text-slate-500 mb-4">
          La date peut être dans le passé ou le futur. Elle sert de borne basse
          par défaut pour le Replan. Vous pourrez la modifier à tout moment via
          le bouton « Paramètres » (✏️).
        </p>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
          >
            Annuler
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            Créer
          </button>
        </div>
      </div>
    </div>
  )
}
