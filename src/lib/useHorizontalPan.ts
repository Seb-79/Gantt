// =============================================================================
// HOOK useHorizontalPan — Gantt v1.19
// =============================================================================
// Transforme un drag horizontal à la souris en décalages successifs de la
// fenêtre temporelle du planning. À brancher sur le panneau scrollable :
//
//   const { onMouseDown, isPanning } = useHorizontalPan(dayWidth, onShift)
//   <div onMouseDown={onMouseDown} className={isPanning ? 'cursor-grabbing' : 'cursor-grab'}>
//
// Sémantique « grab & pull » (comme une carte) :
//   • drag VERS LA DROITE  → fenêtre déplacée VERS LE PASSÉ
//   • drag VERS LA GAUCHE  → fenêtre déplacée VERS LE FUTUR
//
// Chaque tranche de `dayWidth` pixels équivaut à 1 jour de décalage. Le hook
// émet `onShiftWindow(delta)` à chaque seuil franchi (pas un appel par pixel).
//
// Hook stateless côté logique : utilise un useRef pour le suivi de la position
// de départ + jours déjà émis (évite un re-render à chaque mousemove).
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * v1.19 — Hook React qui transforme un drag-souris horizontal en décalages
 * successifs de la fenêtre temporelle. Pensé pour s'attacher en `onMouseDown`
 * sur le panneau du planning ; émet `onShiftWindow(delta)` à chaque jour
 * franchi pendant le drag.
 *
 * @param dayWidth       Largeur d'1 jour en pixels (zoom courant).
 * @param onShiftWindow  Callback à appeler avec un entier signé (jours).
 *                       Si non fourni, le hook devient un no-op : le clic
 *                       passe sans déclencher de pan (utile pour activer
 *                       conditionnellement la fonctionnalité côté parent).
 * @returns              { onMouseDown, isPanning } à utiliser dans le JSX.
 */
export function useHorizontalPan(
  dayWidth: number,
  onShiftWindow: ((days: number) => void) | undefined,
) {
  /** Drapeau d'activation : déclenche le useEffect d'écoute globale. */
  const [isPanning, setIsPanning] = useState(false)
  /**
   * Position de départ + nombre de jours déjà émis pour ce drag. En ref pour
   * éviter un re-render à chaque mousemove (60 fps × N tâches, ça coûte).
   */
  const panRef = useRef<{ startX: number; emitted: number } | null>(null)

  /**
   * Démarre le pan : enregistre le X de départ et active l'écoute globale
   * mousemove/mouseup. À brancher en `onMouseDown` sur l'élément qui doit
   * capturer le geste (typiquement le panneau scrollable du planning).
   *
   * Ne réagit qu'au bouton gauche, et seulement si `onShiftWindow` est défini.
   */
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || !onShiftWindow) return
      panRef.current = { startX: e.clientX, emitted: 0 }
      setIsPanning(true)
      // Empêche le drag natif HTML5 et la sélection de texte pendant le geste.
      e.preventDefault()
    },
    [onShiftWindow],
  )

  // Pose mousemove + mouseup au niveau document tant que le pan est actif.
  // Détache automatiquement au unmount ou à la fin du drag (cleanup).
  useEffect(() => {
    if (!isPanning) return
    /** Convertit le déplacement total souris en delta jours à émettre. */
    function onMove(e: MouseEvent) {
      const p = panRef.current
      if (!p || !onShiftWindow || dayWidth <= 0) return
      // Convention « grab & pull » : drag → ⇒ fenêtre ←, d'où le signe négatif.
      const totalDx = e.clientX - p.startX
      const target = Math.round(-totalDx / dayWidth)
      const delta = target - p.emitted
      if (delta !== 0) {
        onShiftWindow(delta)
        p.emitted = target
      }
    }
    /** Termine le drag : nettoie l'état et désactive les listeners. */
    function onUp() {
      panRef.current = null
      setIsPanning(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isPanning, dayWidth, onShiftWindow])

  return { onMouseDown, isPanning }
}
