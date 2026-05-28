// =============================================================================
// useAlertDisplay — Gantt v2.4
// =============================================================================
// Gère l'état d'affichage du bandeau de cohérence (`CoherenceAlert`) pour le
// PROJET COURANT, avec mémoire par projet :
//   • Réhydraté depuis localStorage quand le projet courant change (pattern
//     « ajuster un état pendant le rendu » recommandé par React, sans
//     useEffect → pas de render en cascade).
//   • Chaque changement est persisté par projet (survit au F5, pas de fuite
//     d'un projet à l'autre).
//
// Extrait de `App` pour ne pas alourdir sa complexité cognitive et pour suivre
// le pattern des hooks du dossier (useDragPaint, useLinkDrag…).
// =============================================================================

import { useCallback, useState } from 'react'
import {
  getAlertDisplay,
  setAlertDisplay as persistAlertDisplay,
  type AlertDisplay,
} from './storage'

export interface UseAlertDisplay {
  /** État d'affichage courant du bandeau. */
  display: AlertDisplay
  /** Change l'état d'affichage du projet courant (état + persistance). */
  setDisplay: (mode: AlertDisplay) => void
}

/**
 * Hook d'état d'affichage du bandeau de cohérence, mémorisé par projet.
 *
 * @param currentProjectId Id du projet affiché (ou null/undefined si aucun).
 * @returns                `display` courant + `setDisplay` (persiste).
 */
export function useAlertDisplay(
  currentProjectId: string | null | undefined,
): UseAlertDisplay {
  const projectId = currentProjectId ?? null
  const [display, setDisplayState] = useState<AlertDisplay>('expanded')
  // Projet pour lequel `display` a été chargé : sert à détecter un changement
  // de projet et à réhydrater pendant le rendu.
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null)

  // Réhydratation pendant le rendu au changement de projet courant.
  if (projectId !== loadedProjectId) {
    setLoadedProjectId(projectId)
    setDisplayState(projectId ? getAlertDisplay(projectId) : 'expanded')
  }

  const setDisplay = useCallback(
    (mode: AlertDisplay) => {
      setDisplayState(mode)
      if (projectId) persistAlertDisplay(projectId, mode)
    },
    [projectId],
  )

  return { display, setDisplay }
}
