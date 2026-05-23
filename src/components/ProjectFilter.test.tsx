// @vitest-environment jsdom
// =============================================================================
// TESTS — ProjectFilter (Gantt v2.2 / F2-F3)
// =============================================================================
// Vérifie le contrat du sélecteur de projet multi-mode :
//   • Libellé du déclencheur selon le mode (single / all / subset).
//   • Ouverture/fermeture du menu (clic, Escape, clic extérieur).
//   • Toggle « 🌐 Tous les projets ».
//   • Toggle d'une checkbox individuelle.
//   • Transitions automatiques single ↔ subset ↔ all selon le nombre cochés.
//   • Refus de tout décocher (au moins 1 projet sélectionné).
//   • État désactivé.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProjectFilter } from './ProjectFilter'
import type { Project, ProjectSelection } from '../lib/types'

const PROJECTS: Project[] = [
  { id: 'p1', name: 'Projet 1', position: 0 },
  { id: 'p2', name: 'Projet 2', position: 1 },
  { id: 'p3', name: 'Projet 3', position: 2 },
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
      currentProjectId="p1"
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

  it('affiche « N projets sélectionnés » en mode subset', () => {
    mount({ mode: 'subset', projectIds: ['p1', 'p2'] })
    expect(screen.getByRole('combobox')).toHaveTextContent(
      '📁 2 projets sélectionnés',
    )
  })
})

describe('ProjectFilter — ouverture/fermeture du menu', () => {
  it("n'affiche pas la liste avant ouverture", () => {
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
})

describe('ProjectFilter — sélection « Tous les projets »', () => {
  it("coche « Tous » → mode 'all'", () => {
    const { onChange } = mount({ mode: 'single', projectId: 'p1' })
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByLabelText('Tous les projets'))
    expect(onChange).toHaveBeenCalledWith({ mode: 'all' })
  })

  it("décoche « Tous » → mode 'single' sur le projet courant", () => {
    const { onChange } = mount({ mode: 'all' }, { currentProjectId: 'p2' })
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByLabelText('Tous les projets'))
    expect(onChange).toHaveBeenCalledWith({
      mode: 'single',
      projectId: 'p2',
    })
  })
})

describe("ProjectFilter — toggle d'un projet individuel", () => {
  it("cocher un 2e projet depuis single → mode 'subset'", () => {
    const { onChange } = mount({ mode: 'single', projectId: 'p1' })
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByLabelText('Projet 2'))
    expect(onChange).toHaveBeenCalledWith({
      mode: 'subset',
      projectIds: ['p1', 'p2'],
    })
  })

  it("cocher tous les projets restants → mode 'all'", () => {
    const { onChange } = mount({
      mode: 'subset',
      projectIds: ['p1', 'p2'],
    })
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByLabelText('Projet 3'))
    expect(onChange).toHaveBeenCalledWith({ mode: 'all' })
  })

  it("décocher pour ne laisser qu'un projet → mode 'single' sur celui-là", () => {
    const { onChange } = mount({
      mode: 'subset',
      projectIds: ['p1', 'p2'],
    })
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByLabelText('Projet 1'))
    expect(onChange).toHaveBeenCalledWith({
      mode: 'single',
      projectId: 'p2',
    })
  })

  it('refuse de tout décocher (au moins 1 projet)', () => {
    const { onChange } = mount({ mode: 'single', projectId: 'p1' })
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByLabelText('Projet 1'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("partir de 'all' et décocher un projet → mode 'subset' sur les restants", () => {
    const { onChange } = mount({ mode: 'all' })
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByLabelText('Projet 2'))
    expect(onChange).toHaveBeenCalledWith({
      mode: 'subset',
      projectIds: ['p1', 'p3'],
    })
  })
})

describe('ProjectFilter — aria-selected', () => {
  it('marque le projet single comme sélectionné', () => {
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

  it('marque « Tous les projets » comme sélectionné en mode all', () => {
    mount({ mode: 'all' })
    fireEvent.click(screen.getByRole('combobox'))
    expect(
      screen.getByRole('option', { name: /Tous les projets/ }),
    ).toHaveAttribute('aria-selected', 'true')
  })

  it('marque les projets du subset comme sélectionnés', () => {
    mount({ mode: 'subset', projectIds: ['p1', 'p3'] })
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.getByRole('option', { name: /Projet 1/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('option', { name: /Projet 2/ })).toHaveAttribute(
      'aria-selected',
      'false',
    )
    expect(screen.getByRole('option', { name: /Projet 3/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })
})
