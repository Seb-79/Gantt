// =============================================================================
// HOOK useDragPaint — Gantt v2.1 / F4 + F5
// =============================================================================
// Hook réutilisable pour les grilles « Affectation » (F4) et « Congés » (F5) :
// permet à l'utilisateur de cliquer-glisser horizontalement sur les cellules
// d'une même ligne pour les peindre avec la valeur de la case de départ.
//
// Décisions UX figées avec Seb :
//   • Q1 = A — valeur du pinceau = valeur de la case de départ (pas
//             incrémental). On cycle d'abord la 1ʳᵉ case puis on étend.
//   • Q2 = Oui — écrasement silencieux des valeurs existantes pendant le
//             drag. C'est ce qu'on attend d'un outil de « peinture ».
//   • Q3 = Horizontal seulement — on verrouille la ligne d'origine au
//             mousedown, le mouvement vertical est ignoré.
//
// Architecture :
//   • Au mousedown, on capture `paintRowId` + `paintValue` (la valeur du
//     pinceau, fournie par le caller).
//   • Au mousemove sur une cellule (`onCellEnter(rowId, date)`), si la ligne
//     correspond, on appelle `setLocal(rowId, date, paintValue)`. Le caller
//     applique le changement à un état OPTIMISTE local (pas d'appel API).
//   • Au mouseup global (document), on appelle `onCommit(rowId, changes)`
//     avec la `Map<dateIso, valeur>` accumulée → le caller exécute les
//     mutations API en batch et fait un `fetchState()` unique.
//   • Tant que le drag est actif, `isDragging` est `true` (le caller peut
//     adapter le curseur, désactiver d'autres interactions, etc.).
//
// Le hook ne RENDS rien : c'est le caller qui branche `onCellMouseDown` et
// `onCellEnter` sur ses divs cellules.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Configuration du hook.
 *
 * @template V  Type de valeur portée par une cellule (ex. `number` pour
 *              les pct 0/25/50/75/100, ou les fractions 0/0.25/0.5/0.75/1).
 */
export interface UseDragPaintOptions<V> {
  /**
   * Applique localement (optimiste) un changement de valeur sur une cellule.
   * Appelé à chaque mousedown ET à chaque mousemove franchissant une nouvelle
   * cellule. Le caller met à jour un état React local qui reflète l'effet
   * du drag avant le commit serveur.
   */
  setLocal: (rowId: string, dateIso: string, value: V) => void
  /**
   * Commit final : exécuté au mouseup. Reçoit l'ensemble des cellules
   * effectivement modifiées (Map<dateIso, valeur>), ainsi que l'id de la
   * ligne verrouillée pour ce drag. Le caller exécute ses mutations API en
   * batch puis appelle son refetch global.
   */
  onCommit: (rowId: string, changes: Map<string, V>) => void
}

/**
 * Valeur de retour du hook.
 */
export interface UseDragPaintReturn<V> {
  /** Vrai pendant un drag actif (entre mousedown et mouseup). */
  isDragging: boolean
  /** Ligne verrouillée pour le drag courant (null hors drag). */
  paintingRowId: string | null
  /** Valeur du pinceau (null hors drag). Lecture utile pour debug / UI. */
  paintingValue: V | null
  /**
   * Handler à brancher sur le `onMouseDown` d'une cellule. Démarre le drag
   * en capturant la ligne et la valeur. La valeur fournie peut être un
   * cycle pre-calculé (ex. nextPct du clic).
   */
  onCellMouseDown: (rowId: string, dateIso: string, value: V) => void
  /**
   * Handler à brancher sur le `onMouseEnter` d'une cellule (ou
   * `onMouseMove` selon le besoin). Si le drag est actif et que la cellule
   * appartient à la ligne verrouillée, peint avec `paintingValue`. Sinon
   * no-op.
   */
  onCellEnter: (rowId: string, dateIso: string) => void
}

/**
 * v2.1 / F4 — Hook de drag-paint horizontal sur une grille de cellules.
 *
 * Génériquement typé par la valeur portée par les cellules (`number` pour
 * F4, `number` (fraction) pour F5). Le hook ne connaît pas la sémantique
 * métier : il pilote uniquement la mécanique mousedown→mousemove→mouseup.
 *
 * @template V                       Type de la valeur de cellule.
 * @param   opts                     Cf. `UseDragPaintOptions`.
 * @returns                          Cf. `UseDragPaintReturn`.
 */
export function useDragPaint<V>(
  opts: UseDragPaintOptions<V>,
): UseDragPaintReturn<V> {
  const { setLocal, onCommit } = opts
  /** Vrai pendant un drag actif. */
  const [isDragging, setIsDragging] = useState(false)
  /** Ligne verrouillée pour le drag (null hors drag). */
  const [paintingRowId, setPaintingRowId] = useState<string | null>(null)
  /** Valeur du pinceau capturée au mousedown. */
  const [paintingValue, setPaintingValue] = useState<V | null>(null)
  /**
   * Buffer des changements appliqués pendant le drag. On utilise une ref
   * (pas du state) parce qu'on doit lire la dernière version dans le
   * mouseup global sans relancer la subscription.
   */
  const changesRef = useRef<Map<string, V>>(new Map())
  /** Garde une ref vers la dernière ligne peinte pour le commit. */
  const rowIdRef = useRef<string | null>(null)

  /**
   * Démarrage du drag : capture la ligne, la valeur et applique
   * immédiatement à la cellule cliquée (sinon un clic sans déplacement
   * ne ferait rien).
   */
  const onCellMouseDown = useCallback(
    (rowId: string, dateIso: string, value: V) => {
      setIsDragging(true)
      setPaintingRowId(rowId)
      setPaintingValue(value)
      rowIdRef.current = rowId
      changesRef.current = new Map()
      changesRef.current.set(dateIso, value)
      setLocal(rowId, dateIso, value)
    },
    [setLocal],
  )

  /**
   * Mouvement sur une cellule pendant le drag. Verrouillage horizontal :
   * on n'agit que si la cellule appartient à la ligne d'origine. Q2 =
   * écrasement silencieux (on appelle setLocal même si la valeur précédente
   * était différente).
   */
  const onCellEnter = useCallback(
    (rowId: string, dateIso: string) => {
      if (!isDragging) return
      if (paintingRowId !== rowId) return
      if (paintingValue === null) return
      // Skip si la cellule a déjà été peinte par ce drag (idempotent).
      if (changesRef.current.has(dateIso)) return
      changesRef.current.set(dateIso, paintingValue)
      setLocal(rowId, dateIso, paintingValue)
    },
    [isDragging, paintingRowId, paintingValue, setLocal],
  )

  /**
   * Listener mouseup global : termine le drag et commit. Branché tant que
   * `isDragging` est vrai. On utilise `window` plutôt que `document` pour
   * absorber les relâches hors de la grille (drag sortant).
   */
  useEffect(() => {
    if (!isDragging) return
    function onUp() {
      const rowId = rowIdRef.current
      const changes = changesRef.current
      // Reset interne AVANT d'appeler onCommit pour que le caller puisse
      // déclencher un setState qui ne re-rentre pas dans le drag.
      setIsDragging(false)
      setPaintingRowId(null)
      setPaintingValue(null)
      rowIdRef.current = null
      changesRef.current = new Map()
      if (rowId && changes.size > 0) {
        onCommit(rowId, changes)
      }
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [isDragging, onCommit])

  return {
    isDragging,
    paintingRowId,
    paintingValue,
    onCellMouseDown,
    onCellEnter,
  }
}
