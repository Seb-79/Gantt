// @vitest-environment jsdom
// =============================================================================
// TESTS — PredecessorPicker (v1.22)
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import PredecessorPicker from './PredecessorPicker'
import type { Task } from '../lib/types'
import { mkTask as mkTaskBase } from '../test/fixtures'

/**
 * Wrapper local : ce fichier teste un picker qui exige des tâches avec
 * `priority=3` (les jalons n'ont pas de priorité) et `project_id='p1'`
 * (jeton historique du fichier). On dérive de la fixture partagée pour
 * ne pas dupliquer les autres champs.
 */
function mkTask(overrides: Partial<Task>): Task {
  return mkTaskBase({
    priority: 3,
    project_id: 'p1',
    ...overrides,
  })
}

/**
 * Jeu de tâches commun :
 *   Phase1
 *     T-A
 *     T-B
 *   Phase2
 *     T-C (jalon)
 *   T-D (édité dans la plupart des tests)
 */
const allTasks: Task[] = [
  mkTask({ id: 'ph1', name: 'Phase 1', kind: 'phase', position: 0 }),
  mkTask({ id: 'tA', name: 'Tâche A', parent_id: 'ph1', position: 0 }),
  mkTask({ id: 'tB', name: 'Tâche B', parent_id: 'ph1', position: 1 }),
  mkTask({ id: 'ph2', name: 'Phase 2', kind: 'phase', position: 1 }),
  mkTask({
    id: 'tC',
    name: 'Jalon C',
    kind: 'milestone',
    parent_id: 'ph2',
    position: 0,
  }),
  mkTask({ id: 'tD', name: 'Tâche D éditée', position: 2 }),
]

describe('PredecessorPicker — chips', () => {
  it('liste vide : aucune chip, mais le déclencheur « — ajouter — » est présent', () => {
    // v2.5 — Harmonisation avec l'ajout d'un collaborateur : pas de texte
    // « Aucun prédécesseur » ; la zone de chips est simplement vide et le
    // déclencheur (sosie du select « — ajouter — ») reste affiché.
    render(
      <PredecessorPicker
        task={null}
        allTasks={allTasks}
        value={[]}
        onChange={() => {}}
      />,
    )
    expect(
      screen.getByRole('button', { name: /ajouter un prédécesseur/i }),
    ).toBeInTheDocument()
    expect(screen.getByText('— ajouter —')).toBeInTheDocument()
  })

  it('affiche une chip par prédécesseur (avec son lag)', () => {
    render(
      <PredecessorPicker
        task={null}
        allTasks={allTasks}
        value={[
          { id: 'tA', lag: 0 },
          { id: 'tC', lag: 3 },
        ]}
        onChange={() => {}}
      />,
    )
    expect(screen.getByText('Tâche A')).toBeInTheDocument()
    expect(screen.getByText(/Jalon C/)).toBeInTheDocument()
    // Le lag du jalon est éditable dans un input number.
    const lagInputs = screen.getAllByRole('spinbutton')
    expect(lagInputs[0]).toHaveValue(0)
    expect(lagInputs[1]).toHaveValue(3)
  })

  it('clic sur ✕ retire le prédécesseur (callback avec nouvelle liste)', () => {
    const onChange = vi.fn()
    render(
      <PredecessorPicker
        task={null}
        allTasks={allTasks}
        value={[
          { id: 'tA', lag: 0 },
          { id: 'tB', lag: 0 },
        ]}
        onChange={onChange}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /Retirer le prédécesseur Tâche A/ }),
    )
    expect(onChange).toHaveBeenCalledWith([{ id: 'tB', lag: 0 }])
  })

  it("modifier le lag d'une chip propage la valeur normalisée (≥ 0, entier)", () => {
    const onChange = vi.fn()
    render(
      <PredecessorPicker
        task={null}
        allTasks={allTasks}
        value={[{ id: 'tA', lag: 0 }]}
        onChange={onChange}
      />,
    )
    fireEvent.change(screen.getByLabelText('Délai du prédécesseur Tâche A'), {
      target: { value: '4' },
    })
    expect(onChange).toHaveBeenCalledWith([{ id: 'tA', lag: 4 }])
  })
})

describe('PredecessorPicker — popover (arbre)', () => {
  it("clic sur « + Ajouter » ouvre l'arbre", () => {
    render(
      <PredecessorPicker
        task={null}
        allTasks={allTasks}
        value={[]}
        onChange={() => {}}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /ajouter un prédécesseur/i }),
    )
    // L'arbre est rendu : on retrouve les tâches.
    expect(screen.getByPlaceholderText(/Rechercher/)).toBeInTheDocument()
    expect(screen.getByText('Tâche A')).toBeInTheDocument()
  })

  it('phase grisée et non-cliquable', () => {
    const onChange = vi.fn()
    render(
      <PredecessorPicker
        task={null}
        allTasks={allTasks}
        value={[]}
        onChange={onChange}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /ajouter un prédécesseur/i }),
    )
    const phaseRow = document.querySelector('[data-task-id="ph1"]')!
    expect(phaseRow.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(phaseRow)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('la tâche éditée elle-même est interdite (anti-cycle direct)', () => {
    const onChange = vi.fn()
    render(
      <PredecessorPicker
        task={allTasks.find((t) => t.id === 'tD')!}
        allTasks={allTasks}
        value={[]}
        onChange={onChange}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /ajouter un prédécesseur/i }),
    )
    const selfRow = document.querySelector('[data-task-id="tD"]')!
    expect(selfRow.getAttribute('aria-disabled')).toBe('true')
  })

  it('les descendants de la tâche éditée sont interdits (anti-cycle indirect)', () => {
    // tD devient parent : tA est son enfant → tA ne doit pas être proposable.
    const tasks: Task[] = [
      mkTask({ id: 'tD', name: 'Parent' }),
      mkTask({ id: 'tA', name: 'Enfant', parent_id: 'tD' }),
    ]
    render(
      <PredecessorPicker
        task={tasks[0]}
        allTasks={tasks}
        value={[]}
        onChange={() => {}}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /ajouter un prédécesseur/i }),
    )
    expect(
      document
        .querySelector('[data-task-id="tA"]')!
        .getAttribute('aria-disabled'),
    ).toBe('true')
  })

  it('tâche déjà sélectionnée : grisée + marquée ✓', () => {
    render(
      <PredecessorPicker
        task={null}
        allTasks={allTasks}
        value={[{ id: 'tA', lag: 0 }]}
        onChange={() => {}}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /ajouter un prédécesseur/i }),
    )
    const row = document.querySelector('[data-task-id="tA"]')!
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(within(row as HTMLElement).getByText('✓')).toBeInTheDocument()
  })

  it('clic sur une tâche valide → onChange avec ajout (lag=0 par défaut)', () => {
    const onChange = vi.fn()
    render(
      <PredecessorPicker
        task={null}
        allTasks={allTasks}
        value={[]}
        onChange={onChange}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /ajouter un prédécesseur/i }),
    )
    fireEvent.click(document.querySelector('[data-task-id="tA"]')!)
    expect(onChange).toHaveBeenCalledWith([{ id: 'tA', lag: 0 }])
  })

  it('recherche : filtre les lignes par nom (case-insensitive)', () => {
    render(
      <PredecessorPicker
        task={null}
        allTasks={allTasks}
        value={[]}
        onChange={() => {}}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /ajouter un prédécesseur/i }),
    )
    fireEvent.change(screen.getByPlaceholderText(/Rechercher/), {
      target: { value: 'jalon' },
    })
    // Seul "Jalon C" doit rester visible parmi les noms de tâches.
    expect(screen.queryByText('Tâche A')).not.toBeInTheDocument()
    expect(screen.getByText(/Jalon C/)).toBeInTheDocument()
  })

  it('Escape ferme le popover', () => {
    render(
      <PredecessorPicker
        task={null}
        allTasks={allTasks}
        value={[]}
        onChange={() => {}}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /ajouter un prédécesseur/i }),
    )
    expect(screen.getByPlaceholderText(/Rechercher/)).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByPlaceholderText(/Rechercher/)).not.toBeInTheDocument()
  })
})
