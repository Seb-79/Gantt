// =============================================================================
// Tooltip — Composant de tooltip custom (Gantt v2.2 / F1 — refondu)
// =============================================================================
// Remplace l'attribut HTML natif `title=` dont le délai d'apparition est
// contrôlé par le navigateur (souvent 700-1500 ms) et dont le tooltip
// disparaît au moindre mouvement de souris sans réapparaître avant ~5 s.
//
// Comportement (RG-GANTT-2200 / F1) :
//   • Le tooltip apparaît après un délai court (défaut 150 ms) au survol
//     OU au focus clavier.
//   • Il disparaît immédiatement au mouseleave ou au blur.
//   • Le délai en cours est annulé si la souris quitte avant la fin.
//
// Rendu (refonte 2026-05-23) :
//   • Le tooltip est rendu via `createPortal` dans `document.body`. Sans
//     portail, le `overflow-hidden` du header parent tronquait la bulle
//     côté droit (bouton à l'extrême droite invisible).
//   • Couleur : fond gris clair (slate-100) + bordure (slate-300) + texte
//     slate-800, style proche d'un tooltip natif macOS — harmonisé avec le
//     reste de l'app (l'utilisateur trouvait le fond noir précédent moche).
//   • Position calculée via `getBoundingClientRect` du wrapper (cohérent
//     avec ProjectFilter).
//
// Accessibilité :
//   • `aria-label={label}` est propagé sur le child uniquement si son
//     textContent fait ≤ 3 caractères (= bouton icône). Sur les boutons
//     avec texte ("+ Tâche", "🔄 Replan"), le textContent suffit.
//   • Tests : interroger via `getByLabelText(...)` pour les icônes,
//     `getByRole('button', { name })` pour les boutons texte.
// =============================================================================

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

/**
 * Props du composant Tooltip.
 *
 * @property label       Texte du tooltip. Court (1-10 mots typique).
 * @property children    Élément à wrapper (typiquement un <button>).
 * @property delay       Délai d'apparition en ms. Défaut 150.
 * @property placement   Côté d'apparition par rapport au wrapper. Défaut 'bottom'.
 * @property align       Ancre horizontale (top/bottom) ou verticale (left/right).
 *                       Défaut 'center'. Utiliser 'end' pour les boutons à
 *                       l'extrême droite pour éviter le débordement.
 */
export interface TooltipProps {
  label: string
  children: ReactNode
  delay?: number
  placement?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
}

/** Espacement (px) entre le wrapper et la bulle de tooltip. */
const GAP = 4

/**
 * Calcule le point d'ancrage (top/left) de la bulle de tooltip dans le
 * viewport à partir du rectangle du wrapper, du `placement` et de l'`align`.
 * La bulle elle-même applique ensuite un `transform: translate(...)` (calculé
 * dans le composant) pour s'aligner correctement par rapport à ce point.
 */
function computeTooltipAnchor(
  rect: DOMRect,
  placement: 'top' | 'bottom' | 'left' | 'right',
  align: 'start' | 'center' | 'end',
): { top: number; left: number } {
  const isVertical = placement === 'bottom' || placement === 'top'
  if (isVertical) {
    const top = placement === 'bottom' ? rect.bottom + GAP : rect.top - GAP
    const HORIZ = {
      start: rect.left,
      center: (rect.left + rect.right) / 2,
      end: rect.right,
    } as const
    return { top, left: HORIZ[align] }
  }
  const left = placement === 'right' ? rect.right + GAP : rect.left - GAP
  const VERT = {
    start: rect.top,
    center: (rect.top + rect.bottom) / 2,
    end: rect.bottom,
  } as const
  return { top: VERT[align], left }
}

/**
 * Wrapper d'élément qui affiche un tooltip custom au survol et au focus.
 * Voir l'entête du fichier pour le contrat complet.
 */
export function Tooltip({
  label,
  children,
  delay = 150,
  placement = 'bottom',
  align = 'center',
}: TooltipProps) {
  // Visibilité effective du tooltip (true une fois le délai écoulé).
  const [visible, setVisible] = useState(false)
  // Référence du timer pour pouvoir l'annuler au mouseleave anticipé.
  const timerRef = useRef<number | null>(null)
  // Référence du wrapper (pour calculer la position du tooltip en portail).
  const wrapperRef = useRef<HTMLSpanElement>(null)
  // Position absolue calculée à l'affichage. `null` tant que pas affiché.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  // Identifiant unique pour aria-describedby (accessibilité).
  const tooltipId = useId()

  // Démarre le timer d'apparition s'il n'est pas déjà actif.
  const show = () => {
    if (timerRef.current !== null) return
    timerRef.current = window.setTimeout(() => {
      setVisible(true)
      timerRef.current = null
    }, delay)
  }

  // Annule le timer en cours et masque immédiatement le tooltip.
  const hide = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setVisible(false)
    setPos(null)
  }

  // Cleanup : annule un éventuel timer si démontage pendant l'attente.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  // Calcule la position du tooltip à chaque affichage. useLayoutEffect pour
  // avoir la position avant le 1er paint (pas de flash).
  useLayoutEffect(() => {
    if (!visible || !wrapperRef.current) return
    const rect = wrapperRef.current.getBoundingClientRect()
    setPos(computeTooltipAnchor(rect, placement, align))
  }, [visible, placement, align])

  // Transform CSS pour aligner correctement la bulle par rapport au point
  // d'ancrage `pos`. La bulle est positionnée par son coin/centre approprié.
  const transformOrigin = (() => {
    // Calculs en fonction de placement × align.
    let tx = '0'
    let ty = '0'
    if (placement === 'bottom' || placement === 'top') {
      if (align === 'center') tx = '-50%'
      else if (align === 'end') tx = '-100%'
      if (placement === 'top') ty = '-100%'
    } else {
      if (align === 'center') ty = '-50%'
      else if (align === 'end') ty = '-100%'
      if (placement === 'left') tx = '-100%'
    }
    return `translate(${tx}, ${ty})`
  })()

  // Propage `aria-label={label}` sur les boutons icône uniquement.
  const isIconOnly = (() => {
    if (!isValidElement(children)) return false
    const inner = (children as ReactElement<{ children?: ReactNode }>).props
      .children
    if (typeof inner !== 'string') return false
    return inner.trim().length <= 3
  })()
  const extraProps: Record<string, unknown> = isIconOnly
    ? { 'aria-label': label }
    : {}
  const enhancedChild = isValidElement(children)
    ? cloneElement(
        children as ReactElement<Record<string, unknown>>,
        extraProps,
      )
    : children

  return (
    <span
      ref={wrapperRef}
      className="inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={visible ? tooltipId : undefined}
    >
      {enhancedChild}
      {visible &&
        pos &&
        createPortal(
          <span
            id={tooltipId}
            role="tooltip"
            // Couleur native-like : fond clair, texte sombre, bordure
            // discrète + petite ombre. Harmonisé avec les tooltips natifs
            // des navigateurs/OS — plus discret que le fond noir précédent.
            className="fixed z-[1000] px-2 py-1 text-xs text-slate-800 bg-slate-100 border border-slate-300 rounded shadow-md whitespace-nowrap pointer-events-none"
            style={{
              top: pos.top,
              left: pos.left,
              transform: transformOrigin,
            }}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  )
}
