// =============================================================================
// ProjectFilter — Sélecteur de projet (Gantt v2.2 / F2-F3 refondu)
// =============================================================================
// Composant unique remplaçant le `<select>` natif + l'ancien bouton « 🌐 Global
// / 📁 Courant ». Deux modes possibles (cf. `ProjectSelection`) :
//
//   • single : un projet précis est actif (mode par défaut, dispo partout).
//   • all    : vue globale (« 🌐 Tous les projets »). Disponible uniquement
//              sur les onglets « Charge » et « Affectation ». La prop
//              `allowAll` contrôle l'affichage de cette option.
//
// Rendu :
//   • Déclencheur (bouton) affichant le mode courant. Toujours visible.
//   • Menu déroulant rendu via `createPortal` dans `document.body` pour ne
//     PAS être tronqué par le `overflow-hidden` du header parent (bug
//     précédent : le menu existait dans le DOM mais restait invisible).
//   • Sélection unique de type radio. Pas de cases à cocher.
//
// Le composant est purement présenteur : l'unique callback `onChange` remonte
// la nouvelle sélection.
// =============================================================================

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Project, ProjectSelection } from '../lib/types'

/** Props du composant ProjectFilter. */
export interface ProjectFilterProps {
  /** Liste des projets disponibles, dans l'ordre d'affichage. */
  projects: Project[]
  /** État courant du filtre. */
  selection: ProjectSelection
  /** Callback unique : nouvelle sélection après une interaction utilisateur. */
  onChange: (next: ProjectSelection) => void
  /**
   * Si `true`, l'option « 🌐 Tous les projets » apparaît en tête du menu.
   * Défaut `true`. Mettre à `false` sur les onglets mono-projet (Gantt).
   */
  allowAll?: boolean
  /** Désactive le composant (ex. pendant un chargement). */
  disabled?: boolean
}

/**
 * Sélecteur de projet avec menu déroulant custom rendu via portail.
 * Voir l'entête du fichier pour le contrat complet.
 */
export function ProjectFilter({
  projects,
  selection,
  onChange,
  allowAll = true,
  disabled = false,
}: ProjectFilterProps) {
  // État local : menu ouvert / fermé.
  const [open, setOpen] = useState(false)
  // Référence du déclencheur (pour calculer la position du menu en portail).
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Référence du menu (pour la détection de clic extérieur).
  const menuRef = useRef<HTMLDivElement>(null)
  // Position absolue du menu, calculée à l'ouverture depuis le déclencheur.
  const [menuPos, setMenuPos] = useState<{
    top: number
    left: number
    width: number
  } | null>(null)

  // Ferme le menu sur clic extérieur OU touche Escape.
  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return
      }
      setOpen(false)
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  // Calcule la position du menu sous le déclencheur à chaque ouverture.
  // useLayoutEffect pour avoir la position avant le 1er paint (pas de flash).
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setMenuPos({
      top: rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 240),
    })
  }, [open])

  // Calcule le libellé affiché sur le déclencheur.
  const triggerLabel = (() => {
    if (selection.mode === 'all') return '🌐 Tous les projets'
    const proj = projects.find((p) => p.id === selection.projectId)
    if (proj) return `📁 ${proj.name}`
    return '— aucun projet —'
  })()

  // Sélectionne une option (single ou all) et ferme le menu.
  const pickSingle = (id: string) => {
    onChange({ mode: 'single', projectId: id })
    setOpen(false)
  }
  const pickAll = () => {
    onChange({ mode: 'all' })
    setOpen(false)
  }

  // Indique si une option donnée est l'active (pour aria-selected + style).
  const isAllActive = selection.mode === 'all'
  const isSingleActive = (id: string) =>
    selection.mode === 'single' && selection.projectId === id

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        // Sémantique WAI-ARIA : un bouton qui ouvre une listbox est un
        // combobox. Le rôle explicite préserve aussi la compat de l'ancienne
        // suite de tests qui interrogeait via getByRole('combobox').
        role="combobox"
        className="text-sm border border-slate-300 rounded px-2 py-1 bg-white hover:bg-slate-50 min-w-[10rem] max-w-[14rem] truncate text-left disabled:opacity-40 disabled:cursor-not-allowed"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || projects.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {triggerLabel}
      </button>
      {open &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label="Sélection de projet"
            className="fixed z-50 max-h-80 overflow-auto bg-white border border-slate-300 rounded shadow-lg py-1"
            style={{
              top: menuPos.top,
              left: menuPos.left,
              minWidth: menuPos.width,
            }}
          >
            {/* Option spéciale « 🌐 Tous les projets » — uniquement si autorisée. */}
            {allowAll && (
              <button
                type="button"
                role="option"
                aria-selected={isAllActive}
                onClick={pickAll}
                className={[
                  'w-full text-left text-sm px-3 py-1.5 flex items-center gap-2',
                  isAllActive
                    ? 'bg-blue-100 text-blue-700 font-medium'
                    : 'hover:bg-slate-100',
                ].join(' ')}
              >
                <span className="w-4">{isAllActive ? '✓' : ''}</span>
                <span>🌐 Tous les projets</span>
              </button>
            )}
            {allowAll && <div className="border-t border-slate-200 my-1" />}
            {/* Liste des projets en sélection unique. */}
            {projects.map((p) => {
              const active = isSingleActive(p.id)
              return (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => pickSingle(p.id)}
                  className={[
                    'w-full text-left text-sm px-3 py-1.5 flex items-center gap-2 truncate',
                    active
                      ? 'bg-blue-100 text-blue-700 font-medium'
                      : 'hover:bg-slate-100',
                  ].join(' ')}
                >
                  <span className="w-4">{active ? '✓' : ''}</span>
                  <span className="truncate">📁 {p.name}</span>
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}
