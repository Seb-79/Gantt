// =============================================================================
// ProjectFilter — Sélecteur de projet multi-mode (Gantt v2.2 / F2-F3)
// =============================================================================
// Composant unique remplaçant le `<select>` natif + le bouton « 🌐 Global /
// 📁 Courant ». Trois modes possibles, dérivés implicitement de l'état des
// cases à cocher (voir `ProjectSelection` dans src/lib/types.ts) :
//
//   • single : exactement 1 projet coché — équivalent du scope « current ».
//   • all    : tous les projets cochés — équivalent du scope « global ».
//   • subset : 2 à N-1 projets cochés — filtrage cross-projet.
//
// Règles de transition (UX type filtre Excel) :
//   • Cocher la case spéciale « 🌐 Tous les projets » → mode 'all'.
//   • Décocher « 🌐 Tous les projets » alors qu'on est en 'all' → ne fait
//     rien (impossible de tout décocher : il faut au moins 1 projet).
//   • Cocher / décocher un projet individuel → recalcule le mode :
//       - 0 coché → on garde le projet d'avant en mode 'single' (no-op).
//       - 1 coché → mode 'single' avec ce projet.
//       - 2..N-1 cochés → mode 'subset'.
//       - N cochés → mode 'all'.
//
// Libellé du déclencheur en fonction du mode :
//   • single → « 📁 Nom du projet ».
//   • all    → « 🌐 Tous les projets ».
//   • subset → « 📁 N projets sélectionnés ».
//
// Le composant est purement présenteur : tout le calcul de cohérence est
// fait dans `computeNextSelection` et le résultat est remonté via `onChange`.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import type { Project, ProjectSelection } from '../lib/types'

/** Props du composant ProjectFilter. */
export interface ProjectFilterProps {
  /** Liste des projets disponibles, dans l'ordre d'affichage. */
  projects: Project[]
  /** Projet « actif » pour le mode single. `null` si base vide. */
  currentProjectId: string | null
  /** État courant du filtre. */
  selection: ProjectSelection
  /** Callback unique : nouvelle sélection après une interaction utilisateur. */
  onChange: (next: ProjectSelection) => void
  /** Désactive le composant (ex. pendant un chargement). */
  disabled?: boolean
}

/**
 * Calcule le set d'identifiants de projets cochés à partir d'une sélection
 * et de la liste des projets disponibles. Utilisé pour rendre les cases à
 * cocher du menu.
 */
function selectedIds(
  selection: ProjectSelection,
  projects: Project[],
): Set<string> {
  if (selection.mode === 'all') return new Set(projects.map((p) => p.id))
  if (selection.mode === 'subset') return new Set(selection.projectIds)
  // mode === 'single' → projet explicite.
  return new Set([selection.projectId])
}

/**
 * Calcule la prochaine sélection après un toggle de checkbox individuelle.
 * Garantit toujours qu'au moins 1 projet est sélectionné (retourne null sinon)
 * et normalise vers 'all' / 'single' quand applicable.
 */
function computeNextSelection(
  current: Set<string>,
  toggleId: string,
  projects: Project[],
): ProjectSelection | null {
  const next = new Set(current)
  if (next.has(toggleId)) {
    next.delete(toggleId)
  } else {
    next.add(toggleId)
  }
  if (next.size === 0) return null // refuse : au moins 1 projet sélectionné.
  if (next.size === projects.length) return { mode: 'all' }
  if (next.size === 1) {
    const [only] = next
    return { mode: 'single', projectId: only }
  }
  return { mode: 'subset', projectIds: [...next] }
}

/**
 * Sélecteur de projet avec menu déroulant custom (filtre type Excel).
 * Voir l'entête du fichier pour le contrat complet.
 */
export function ProjectFilter({
  projects,
  currentProjectId,
  selection,
  onChange,
  disabled = false,
}: ProjectFilterProps) {
  // État local : menu ouvert / fermé.
  const [open, setOpen] = useState(false)
  // Référence du conteneur racine pour détecter les clics extérieurs.
  const rootRef = useRef<HTMLDivElement>(null)

  // Ferme le menu sur clic extérieur OU touche Escape.
  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
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

  // Calcule l'ensemble des ids actuellement cochés pour le rendu des cases.
  const checked = selectedIds(selection, projects)

  // Calcule le libellé du déclencheur en fonction du mode.
  const triggerLabel = (() => {
    if (selection.mode === 'all') return '🌐 Tous les projets'
    if (selection.mode === 'subset') {
      return `📁 ${selection.projectIds.length} projets sélectionnés`
    }
    // mode === 'single' : on cherche le projet par son id explicite.
    const proj = projects.find((p) => p.id === selection.projectId)
    if (proj) return `📁 ${proj.name}`
    return '— aucun projet —'
  })()

  // Sélection « Tous les projets » via la case à cocher de tête.
  const handleToggleAll = () => {
    if (selection.mode === 'all') {
      // Décocher « Tous » alors qu'on est en 'all' : on retombe sur le projet
      // courant (au moins un projet doit rester sélectionné).
      if (currentProjectId) {
        onChange({ mode: 'single', projectId: currentProjectId })
      }
      return
    }
    onChange({ mode: 'all' })
  }

  // Toggle d'une checkbox de projet individuel.
  const handleToggleProject = (id: string) => {
    const next = computeNextSelection(checked, id, projects)
    if (next === null) return // refus : tentative de tout décocher.
    onChange(next)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
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
      {open && (
        <div
          role="listbox"
          aria-label="Sélection de projet"
          aria-multiselectable="true"
          className="absolute z-50 mt-1 left-0 min-w-[16rem] max-h-80 overflow-auto bg-white border border-slate-300 rounded shadow-lg py-1"
        >
          {/* Option spéciale : « 🌐 Tous les projets » (toggle all). */}
          <label
            role="option"
            aria-selected={selection.mode === 'all'}
            className={[
              'w-full text-left text-sm px-3 py-1.5 flex items-center gap-2 cursor-pointer',
              selection.mode === 'all'
                ? 'bg-blue-100 text-blue-700 font-medium'
                : 'hover:bg-slate-100',
            ].join(' ')}
          >
            <input
              type="checkbox"
              checked={selection.mode === 'all'}
              onChange={handleToggleAll}
              className="w-4 h-4"
              aria-label="Tous les projets"
            />
            <span>🌐 Tous les projets</span>
          </label>
          <div className="border-t border-slate-200 my-1" />
          {/* Liste des projets — chacun avec sa propre case à cocher. */}
          {projects.map((p) => {
            const isChecked = checked.has(p.id)
            return (
              <label
                key={p.id}
                role="option"
                aria-selected={isChecked}
                className={[
                  'w-full text-left text-sm px-3 py-1.5 flex items-center gap-2 truncate cursor-pointer',
                  isChecked ? 'bg-blue-50 text-blue-700' : 'hover:bg-slate-100',
                ].join(' ')}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => handleToggleProject(p.id)}
                  className="w-4 h-4"
                  aria-label={p.name}
                />
                <span className="truncate">📁 {p.name}</span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}
