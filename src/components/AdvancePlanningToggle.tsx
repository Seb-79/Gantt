// =============================================================================
// COMPOSANT AdvancePlanningToggle — Gantt v2.2 / RG-V (RG-GANTT-1910)
// =============================================================================
// Toggle "Planification anticipée" persisté en localStorage par projet.
// Quand activé, le Replan (manuel et automatique post-édition) suspend
// RG-GANTT-1903 (today comme borne basse pour les activités en cours).
//
// RG-GANTT-1902 (progress=100 lockée) et RG-GANTT-1904 (consomme le reste à
// faire) restent appliquées. Le toggle ne modifie que la borne basse de
// placement.
// =============================================================================

import { useState } from 'react'
import { getAdvancePlanning, setAdvancePlanning } from '../lib/storage'

interface Props {
  /** Id du projet courant ; clé de persistance localStorage. */
  projectId: string
}

/**
 * v2.2 / RG-V — Case à cocher qui pilote le mode anticipé pour un projet.
 * Décochée par défaut. Persistance par navigateur × projet (cf. RG-GANTT-1910).
 */
export default function AdvancePlanningToggle({ projectId }: Props) {
  const [checked, setChecked] = useState<boolean>(() =>
    getAdvancePlanning(projectId),
  )
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked
    setChecked(next)
    setAdvancePlanning(projectId, next)
  }
  return (
    <label
      className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer select-none"
      title="Quand activé, le Replan ne 'tire' pas vers aujourd'hui les tâches dont la date de début est dans le passé. Utile pour préparer un planning de phase future."
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={handleChange}
        className="cursor-pointer"
      />
      Planification anticipée
    </label>
  )
}
