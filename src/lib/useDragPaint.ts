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
  /**
   * Source de vérité = refs (lues dans les callbacks et le listener
   * mouseup global). Le state React n'est que le miroir des refs : il sert
   * uniquement à exposer aux callers `isDragging` / `paintingRowId` /
   * `paintingValue` pour adapter le rendu (curseur, désactivations…).
   *
   * Pourquoi ne pas se contenter du state ? Les callbacks (useCallback)
   * capturent leurs deps via closure : si `onCellEnter` lisait
   * `isDragging` depuis le state, il verrait l'ANCIENNE valeur tant que
   * React n'a pas re-rendu (cas d'un mousedown immédiatement suivi d'un
   * mousemove dans le même tick — typique d'un drag rapide). Les refs
   * sont mises à jour SYNCHRONIQUEMENT dans `onCellMouseDown`, ce qui
   * rend le hook correct quelles que soient les fréquences d'événements.
   */
  const draggingRef = useRef(false)
  const rowIdRef = useRef<string | null>(null)
  const valueRef = useRef<V | null>(null)
  const changesRef = useRef<Map<string, V>>(new Map())

  // Miroir state pour les consommateurs UI.
  const [isDragging, setIsDragging] = useState(false)
  const [paintingRowId, setPaintingRowId] = useState<string | null>(null)
  const [paintingValue, setPaintingValue] = useState<V | null>(null)

  /**
   * Démarrage du drag : met à jour SYNCHRONIQUEMENT les refs, applique
   * la cellule cliquée immédiatement, puis met à jour le state miroir.
   */
  const onCellMouseDown = useCallback(
    (rowId: string, dateIso: string, value: V) => {
      draggingRef.current = true
      rowIdRef.current = rowId
      valueRef.current = value
      changesRef.current = new Map()
      changesRef.current.set(dateIso, value)
      setLocal(rowId, dateIso, value)
      // Miroir state (asynchrone, mais sans impact sur les callbacks
      // puisqu'ils lisent les refs).
      setIsDragging(true)
      setPaintingRowId(rowId)
      setPaintingValue(value)
    },
    [setLocal],
  )

  /**
   * Mouvement sur une cellule pendant le drag. Lit les refs (synchrones)
   * pour être correct même au sein d'un seul tick après un mousedown.
   *   • Verrouillage horizontal : si la cellule n'est pas sur la ligne
   *     d'origine, no-op (RG-GANTT-2006).
   *   • Idempotence : si la cellule a déjà été peinte par CE drag, no-op.
   *   • Q2 écrasement : pas de check sur la valeur précédente — la valeur
   *     du pinceau est appliquée systématiquement (sauf les 2 cas
   *     ci-dessus).
   */
  const onCellEnter = useCallback(
    (rowId: string, dateIso: string) => {
      if (!draggingRef.current) return
      if (rowIdRef.current !== rowId) return
      const value = valueRef.current
      if (value === null) return
      if (changesRef.current.has(dateIso)) return
      changesRef.current.set(dateIso, value)
      setLocal(rowId, dateIso, value)
    },
    [setLocal],
  )

  /**
   * Listener mouseup global : monté UNE FOIS au mount, lit les refs pour
   * savoir s'il y a un drag actif. On ne dépend pas de `isDragging` (state)
   * pour ne pas remonter/démonter le listener à chaque cycle.
   */
  useEffect(() => {
    function onUp() {
      if (!draggingRef.current) return
      const rowId = rowIdRef.current
      const changes = changesRef.current
      // Reset refs AVANT le callback (le caller peut déclencher un
      // setState qui re-render — il doit voir un drag fini).
      draggingRef.current = false
      rowIdRef.current = null
      valueRef.current = null
      changesRef.current = new Map()
      // Miroir state (le linter ne flag pas ici car on est dans un
      // listener déclenché de manière externe, pas directement dans le body
      // du useEffect).
      setIsDragging(false)
      setPaintingRowId(null)
      setPaintingValue(null)
      if (rowId && changes.size > 0) {
        onCommit(rowId, changes)
      }
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [onCommit])

  return {
    isDragging,
    paintingRowId,
    paintingValue,
    onCellMouseDown,
    onCellEnter,
  }
}
