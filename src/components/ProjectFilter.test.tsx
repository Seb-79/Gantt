// @vitest-environment jsdom
// =============================================================================
// TESTS — ProjectFilter (Gantt v2.2 / F2-F3 refondu)
// =============================================================================
// Vérifie le contrat du sélecteur de projet simplifié (single | all) :
//   • Libellé du déclencheur selon le mode.
//   • Ouverture/fermeture du menu (clic, Escape, clic extérieur).
//   • Sélection d'un projet unique → mode 'single'.
//   • Sélection « 🌐 Tous les projets » → mode 'all'.
//   • L'option « Tous » est masquée si `allowAll={false}` (onglet Gantt).
//   • aria-selected correct selon le mode actif.
//   • État désactivé.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProjectFilter } from './ProjectFilter'
import type { Project, ProjectSelection } from '../lib/types'

const PROJECTS: Project[] = [
  { id: 'p1', name: 'Projet 1', position: 0, project_start_date: '2026-01-01' },
  { id: 'p2', name: 'Projet 2', position: 1, project_start_date: '2026-01-01' },
  { id: 'p3', name: 'Projet 3', position: 2, project_start_date: '2026-01-01' },
]

/** Helper : monte le composant avec une sélection initiale et un callback mocké. */
function mount(
  selection: ProjectSelection,
  opts?: Partial<React.ComponentProps<typeof ProjectFilter>>,
) {
  const onChange = vi.fn()
  const utils = render(
    <ProjectFilter
      projects={PROJECTS}
      selection={selection}
      onChange={onChange}
      {...opts}
    />,
  )
  return { ...utils, onChange }
}

describe('ProjectFilter — libellé du déclencheur', () => {
  it('affiche le nom du projet en mode single', () => {
    mount({ mode: 'single', projectId: 'p2' })
    expect(screen.getByRole('combobox')).toHaveTextContent('📁 Projet 2')
  })

  it('affiche « Tous les projets » en mode all', () => {
    mount({ mode: 'all' })
    expect(screen.getByRole('combobox')).toHaveTextContent(
      '🌐 Tous les projets',
    )
  })

  it("affiche « — aucun projet — » si l'id ne correspond à rien", () => {
    mount({ mode: 'single', projectId: 'unknown' })
    expect(screen.getByRole('combobox')).toHaveTextContent('— aucun projet —')
  })
})

describe('ProjectFilter — ouverture/fermeture du menu', () => {
  it("n'affiche pas le menu avant ouverture", () => {
    mount({ mode: 'single', projectId: 'p1' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('ouvre le menu au clic sur le déclencheur', () => {
    mount({ mode: 'single', projectId: 'p1' })
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    // 1 option « Tous les projets » + 3 projets = 4 options.
    expect(screen.getAllByRole('option')).toHaveLength(4)
  })

  it('ferme le menu sur Escape', () => {
    mount({ mode: 'single', projectId: 'p1' })
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('désactive le déclencheur si la liste est vide', () => {
    mount({ mode: 'single', projectId: 'p1' }, { projects: [] })
    expect(screen.getByRole('combobox')).toBeDisabled()
  })

  it('respecte la prop disabled', () => {
    mount({ mode: 'single', projectId: 'p1' }, { disabled: true })
    expect(screen.getByRole('combobox')).toBeDisabled()
  })
})

describe('ProjectFilter — sélection', () => {
  it('cliquer sur un projet émet mode single sur ce projet', () => {
    const { onChange } = mount({ mode: 'single', projectId: 'p1' })
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: /Projet 2/ }))
    expect(onChange).toHaveBeenCalledWith({
      mode: 'single',
      projectId: 'p2',
    })
  })

  it("cliquer sur « Tous les projets » émet mode 'all'", () => {
    const { onChange } = mount({ mode: 'single', projectId: 'p1' })
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: /Tous les projets/ }))
    expect(onChange).toHaveBeenCalledWith({ mode: 'all' })
  })

  it('le menu se ferme après une sélection', () => {
    mount({ mode: 'single', projectId: 'p1' })
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: /Projet 2/ }))
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('ProjectFilter — allowAll', () => {
  it("masque l'option « Tous les projets » si allowAll=false", () => {
    mount({ mode: 'single', projectId: 'p1' }, { allowAll: false })
    fireEvent.click(screen.getByRole('combobox'))
    // Seuls les 3 projets sont listés (pas d'option « Tous »).
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(
      screen.queryByRole('option', { name: /Tous les projets/ }),
    ).toBeNull()
  })

  it("affiche l'option « Tous les projets » par défaut (allowAll=true)", () => {
    mount({ mode: 'single', projectId: 'p1' })
    fireEvent.click(screen.getByRole('combobox'))
    expect(
      screen.getByRole('option', { name: /Tous les projets/ }),
    ).toBeInTheDocument()
  })
})

describe('ProjectFilter — aria-selected', () => {
  it('marque le projet actif comme aria-selected=true en mode single', () => {
    mount({ mode: 'single', projectId: 'p2' })
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.getByRole('option', { name: /Projet 2/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('option', { name: /Projet 1/ })).toHaveAttribute(
      'aria-selected',
      'false',
    )
  })

  it('marque « Tous les projets » comme aria-selected=true en mode all', () => {
    mount({ mode: 'all' })
    fireEvent.click(screen.getByRole('combobox'))
    expect(
      screen.getByRole('option', { name: /Tous les projets/ }),
    ).toHaveAttribute('aria-selected', 'true')
  })
})
