// =============================================================================
// Tooltip — Composant de tooltip custom (Gantt v2.2 / F1)
// =============================================================================
// Remplace l'attribut HTML natif `title=` dont le délai d'apparition est
// contrôlé par le navigateur (souvent 700-1500 ms) et dont le tooltip
// disparaît au moindre mouvement de souris sans réapparaître avant ~5 s.
//
// Comportement attendu (RG-GANTT-2200 / F1) :
//   • Le tooltip apparaît après un délai court (défaut 150 ms) au survol
//     OU au focus clavier.
//   • Il disparaît immédiatement au mouseleave ou au blur.
//   • Le délai en cours est annulé si la souris quitte avant la fin.
//   • Le contenu est un libellé textuel court (`label: string`).
//   • Le wrapper est `inline-flex` pour épouser la taille du bouton enfant
//     sans casser les flex layouts de la toolbar.
//
// Le composant ne gère pas le débordement de viewport en V1 : pour les
// boutons à l'extrême droite, prévoir `align="end"` pour ancrer le tooltip
// sur le bord droit du wrapper plutôt que centré.
// =============================================================================

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'

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
  }

  // Cleanup : annule un éventuel timer si le composant est démonté pendant l'attente.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  // Classes Tailwind pour positionner la bulle par rapport au wrapper.
  // 'start' / 'end' jouent sur l'axe perpendiculaire au placement.
  const HORIZ_ALIGN = {
    start: 'left-0',
    center: 'left-1/2 -translate-x-1/2',
    end: 'right-0',
  } as const
  const VERT_ALIGN = {
    start: 'top-0',
    center: 'top-1/2 -translate-y-1/2',
    end: 'bottom-0',
  } as const
  const positionClass = (() => {
    if (placement === 'top' || placement === 'bottom') {
      const side = placement === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'
      return `${side} ${HORIZ_ALIGN[align]}`
    }
    const side = placement === 'left' ? 'right-full mr-1' : 'left-full ml-1'
    return `${side} ${VERT_ALIGN[align]}`
  })()

  // Propage `title={label}` sur le child DOM élément pour :
  //   • garder un fallback d'accessibilité (lecteurs d'écran),
  //   • préserver les tests qui interrogent par `getByTitle(...)`.
  // On n'ajoute PAS aria-label : il écraserait le nom accessible naturel des
  // boutons avec texte (ex. "+ Tâche") et casserait getByRole('button', { name }).
  // Le tooltip natif HTML n'apparaît jamais visuellement en pratique : notre
  // custom s'affiche à 150 ms alors que le natif n'arrive qu'à ~700 ms.
  const enhancedChild = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        title: label,
      })
    : children

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={visible ? tooltipId : undefined}
    >
      {enhancedChild}
      {visible && (
        <span
          id={tooltipId}
          role="tooltip"
          className={`absolute z-50 px-2 py-1 text-xs text-white bg-slate-800 rounded shadow-lg whitespace-nowrap pointer-events-none ${positionClass}`}
        >
          {label}
        </span>
      )}
    </span>
  )
}
