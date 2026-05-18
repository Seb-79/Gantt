// =============================================================================
// HOOK useLinkDrag — Gantt v1.23 (F2 : drag-to-link à la souris)
// =============================================================================
// Encapsule l'état d'un drag de création de lien prédécesseur depuis le handle
// d'une barre source vers une barre cible. Tient à jour la position courante
// du curseur (pour l'overlay SVG pointillé) et capte le drop sur une cible.
//
// Contrat :
//   • `startLink(args)` est appelé à `onMouseDown` sur le handle bleu d'une
//     barre source. Il enregistre l'origine ({ sourceId, sourceX, sourceY })
//     et installe les listeners globaux mousemove + mouseup + keydown(Esc).
//   • `dropOnTarget(targetId)` est appelé par chaque barre dans son
//     `onMouseUp` : si on est en cours de linking ET que la cible est
//     différente de la source, on déclenche `onCreateLink(source, target)`
//     et on clôt le drag. Sinon, on clôt silencieusement.
//   • Sans drop sur cible (mouseup ailleurs ou Escape), on annule.
//
// Le hook ne fait AUCUN appel réseau : il transmet seulement l'intention au
// caller via `onCreateLink`. Le caller (App.tsx) PATCH le serveur, l'anti-
// cycle est ré-appliqué côté DAL (`wouldCreateCycle`).
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'

/** État courant du drag de liaison (null = inactif). */
export interface LinkDragState {
  /** Id de la tâche source (handle d'origine). */
  sourceId: string
  /** Coordonnée X (px) de l'origine du trait dans le panneau scrollable. */
  sourceX: number
  /** Coordonnée Y (px) de l'origine du trait dans le panneau scrollable. */
  sourceY: number
  /** Coordonnée X courante du curseur (même repère que sourceX). */
  currentX: number
  /** Coordonnée Y courante du curseur (même repère que sourceY). */
  currentY: number
}

interface UseLinkDragOptions {
  /**
   * Callback appelé quand l'utilisateur dépose le trait sur une barre cible
   * VALIDE (cible ≠ source). Le hook ne valide PAS lui-même les cycles ni
   * les phases : c'est au caller de filtrer si besoin (le DAL fait la garde
   * finale). Si non fourni, le hook ne s'active jamais (`startLink` no-op).
   */
  onCreateLink?: (sourceId: string, targetId: string) => void
}

/**
 * Hook qui gère un drag de création de lien prédécesseur. Renvoie l'état
 * courant (pour l'overlay) et les callbacks à brancher sur les handles
 * sources et les barres cibles.
 *
 * @param opts.onCreateLink Callback invoqué au drop sur une cible valide.
 */
export function useLinkDrag(opts: UseLinkDragOptions) {
  const { onCreateLink } = opts
  const [state, setState] = useState<LinkDragState | null>(null)
  // Ref pour que les listeners globaux accèdent toujours à la dernière valeur
  // sans déclencher de re-render (et sans avoir besoin de relancer l'effect).
  // Synchronisation dans un useEffect — l'écriture d'un ref pendant le render
  // est interdite par eslint-plugin-react-hooks.
  const stateRef = useRef<LinkDragState | null>(null)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  /**
   * Démarre un drag de liaison depuis un handle source. Doit être appelé au
   * `onMouseDown` du handle. Les coordonnées d'origine sont RELATIVES au
   * panneau scrollable du Gantt (cf. `panelRef.getBoundingClientRect()`).
   */
  const startLink = useCallback(
    (args: {
      sourceId: string
      sourceX: number
      sourceY: number
      clientX: number
      clientY: number
      panelRect: DOMRect
      scrollLeft: number
    }) => {
      if (!onCreateLink) return
      // Le curseur initial est calculé dans le même repère (px depuis le
      // bord intérieur du panneau, incluant le scroll horizontal).
      const currentX = args.clientX - args.panelRect.left + args.scrollLeft
      const currentY = args.clientY - args.panelRect.top
      setState({
        sourceId: args.sourceId,
        sourceX: args.sourceX,
        sourceY: args.sourceY,
        currentX,
        currentY,
      })
    },
    [onCreateLink],
  )

  /**
   * Appelé par chaque barre cible dans son `onMouseUp` : si un drag est
   * en cours et la cible est différente de la source, déclenche le callback.
   */
  const dropOnTarget = useCallback(
    (targetId: string) => {
      const s = stateRef.current
      if (!s) return
      setState(null)
      if (s.sourceId !== targetId && onCreateLink) {
        onCreateLink(s.sourceId, targetId)
      }
    },
    [onCreateLink],
  )

  /** Annule un drag en cours (Escape, mouseup hors zone, etc.). */
  const cancel = useCallback(() => {
    setState(null)
  }, [])

  // Listeners globaux : actifs uniquement tant qu'un drag est en cours.
  // Ils permettent (a) de suivre le curseur même quand il quitte une barre
  // (b) d'annuler proprement si on lâche en dehors d'une cible.
  useEffect(() => {
    if (!state) return
    /** Tracking de la position courante (pour l'overlay). */
    function onMove(e: MouseEvent) {
      const s = stateRef.current
      if (!s) return
      // On garde le mouvement RELATIF à la source : on stocke l'écart entre
      // les positions client puis on l'applique sur les coordonnées d'origine.
      // Cela évite d'avoir à re-fournir `panelRect` à chaque mousemove.
      const dx = e.movementX
      const dy = e.movementY
      setState({
        ...s,
        currentX: s.currentX + dx,
        currentY: s.currentY + dy,
      })
    }
    /** Annule si le drop arrive hors d'une cible (mouseup global). */
    function onUp() {
      // Si une barre cible a été touchée, son `onMouseUp` a déjà été appelé
      // AVANT ce listener global (bubble) → state est déjà à null. Sinon on
      // clôt ici.
      if (stateRef.current) setState(null)
    }
    /** Escape annule. */
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setState(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('keydown', onKey)
    }
  }, [state])

  return {
    /** État courant du drag (null = pas de drag). */
    state,
    /** True si un drag est en cours. */
    isLinking: state !== null,
    /** Démarre un drag depuis un handle source. */
    startLink,
    /** À appeler par chaque barre cible au mouseup. */
    dropOnTarget,
    /** Annule explicitement le drag. */
    cancel,
  }
}
