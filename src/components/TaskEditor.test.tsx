// @vitest-environment jsdom
// =============================================================================
// TESTS — TaskEditor (composant React)
// =============================================================================
// On exerce la logique métier du modal :
//   • Validation client : nom obligatoire, end_date ≥ start_date
//   • Prédécesseur : start_date initialisée mais éditable, borne MIN
//   • Phase / jalon / tâche : champs visibles ou cachés selon le type
//   • Couleur custom + retour à "Auto"
//   • Annulation + suppression (callbacks)
// Les tests utilisent React Testing Library (RTL) — on cible des rôles
// et libellés accessibles plutôt que des sélecteurs CSS internes.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TaskEditor from './TaskEditor'
import type { Collaborator, Task } from '../lib/types'

/** Helper pour fabriquer une tâche complète sans verbosité dans chaque test. */
function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    name: 'Tâche A',
    kind: 'task',
    start_date: '2026-05-01',
    end_date: '2026-05-10',
    progress: 0,
    collaborator_id: null,
    color: null,
    parent_id: null,
    predecessor_id: null,
    predecessor_lag: 0,
    priority: null,
    position: 0,
    project_id: 'p_test',
    ...overrides,
  }
}

const COLLABS: Collaborator[] = [
  { id: 'c1', name: 'Alice', color: '#3b82f6', position: 0 },
]

describe('TaskEditor — création', () => {
  it('affiche le titre "Nouvelle tâche / jalon / phase" en mode création', () => {
    render(
      <TaskEditor
        task={null}
        defaults={{ start_date: '2026-05-01', end_date: '2026-05-01' }}
        collaborators={COLLABS}
        tasks={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('heading', { name: /Nouvelle tâche/ }),
    ).toBeInTheDocument()
  })

  it('refuse la sauvegarde si le nom est vide', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={null}
        defaults={{ start_date: '2026-05-01' }}
        collaborators={COLLABS}
        tasks={[]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Créer' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/nom est obligatoire/i)
  })

  it('appelle onSave avec les champs saisis', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={null}
        defaults={{ start_date: '2026-05-01', end_date: '2026-05-01' }}
        collaborators={COLLABS}
        tasks={[]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Nom/), {
      target: { value: 'Ma tâche' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Créer' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    const patch = onSave.mock.calls[0][0]
    expect(patch.name).toBe('Ma tâche')
    expect(patch.kind).toBe('task')
    expect(patch.start_date).toBe('2026-05-01')
  })
})

describe('TaskEditor — édition', () => {
  it('pré-remplit le formulaire à partir de la tâche', () => {
    render(
      <TaskEditor
        task={mkTask({ name: 'Existante', progress: 42 })}
        collaborators={COLLABS}
        tasks={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByLabelText(/Nom/)).toHaveValue('Existante')
    expect(screen.getByLabelText(/Avancement/)).toHaveValue(42)
    expect(screen.getByRole('heading')).toHaveTextContent('Modifier')
  })

  it('refuse une end_date < start_date', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={mkTask()}
        collaborators={COLLABS}
        tasks={[]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    // On baisse la end_date en dessous de start_date.
    fireEvent.change(screen.getByLabelText(/^Fin/), {
      target: { value: '2026-04-01' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer/ }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/date de fin/i)
  })

  it('bouton Supprimer appelle onDelete (uniquement en édition)', () => {
    const onDelete = vi.fn()
    render(
      <TaskEditor
        task={mkTask()}
        collaborators={COLLABS}
        tasks={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
        onDelete={onDelete}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Supprimer/ }))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('Annuler appelle onClose sans onSave', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    render(
      <TaskEditor
        task={mkTask()}
        collaborators={COLLABS}
        tasks={[]}
        onSave={onSave}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('TaskEditor — prédécesseur', () => {
  const PRED = mkTask({
    id: 'tA',
    name: 'Prédécesseur',
    start_date: '2026-05-01',
    end_date: '2026-05-15',
  })

  it('liste les jalons en plus des tâches dans le menu prédécesseur', () => {
    const milestone = mkTask({
      id: 'mA',
      name: 'Jalon',
      kind: 'milestone',
      start_date: '2026-05-20',
      end_date: '2026-05-20',
    })
    render(
      <TaskEditor
        task={null}
        defaults={{ start_date: '2026-05-22', end_date: '2026-05-25' }}
        collaborators={COLLABS}
        tasks={[PRED, milestone]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const select = screen.getByLabelText(/Prédécesseur/) as HTMLSelectElement
    const optionLabels = Array.from(select.options).map((o) => o.text)
    expect(optionLabels.some((l) => /Prédécesseur/.test(l))).toBe(true)
    // Le préfixe ◆ identifie les jalons.
    expect(optionLabels.some((l) => /◆ Jalon/.test(l))).toBe(true)
  })

  it('initialise start_date sur la end_date du prédécesseur choisi', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={null}
        defaults={{
          name: 'Nouvelle',
          start_date: '2026-05-01',
          end_date: '2026-05-01',
        }}
        collaborators={COLLABS}
        tasks={[PRED]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Nom/), {
      target: { value: 'Nouvelle' },
    })
    fireEvent.change(screen.getByLabelText(/Prédécesseur/), {
      target: { value: 'tA' },
    })
    // La date de début doit avoir été poussée à 2026-05-15 (fin du prédécesseur).
    expect(screen.getByLabelText(/^Début/)).toHaveValue('2026-05-15')
    fireEvent.click(screen.getByRole('button', { name: 'Créer' }))
    expect(onSave.mock.calls[0][0].start_date).toBe('2026-05-15')
    expect(onSave.mock.calls[0][0].predecessor_id).toBe('tA')
  })

  it('refuse une start_date < fin du prédécesseur', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={null}
        defaults={{
          name: 'X',
          start_date: '2026-05-15',
          end_date: '2026-05-20',
        }}
        collaborators={COLLABS}
        tasks={[PRED]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Nom/), { target: { value: 'X' } })
    fireEvent.change(screen.getByLabelText(/Prédécesseur/), {
      target: { value: 'tA' },
    })
    // Si on essaie de remettre une date AVANT 2026-05-15, l'erreur s'affiche.
    fireEvent.change(screen.getByLabelText(/^Début/), {
      target: { value: '2026-05-10' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Créer' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/≥ fin du prédécesseur/)
  })

  it('autorise une start_date > fin du prédécesseur (décalage volontaire)', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={null}
        defaults={{
          name: 'X',
          start_date: '2026-05-15',
          end_date: '2026-05-20',
        }}
        collaborators={COLLABS}
        tasks={[PRED]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Nom/), { target: { value: 'X' } })
    fireEvent.change(screen.getByLabelText(/Prédécesseur/), {
      target: { value: 'tA' },
    })
    fireEvent.change(screen.getByLabelText(/^Début/), {
      target: { value: '2026-05-20' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Créer' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0].start_date).toBe('2026-05-20')
  })
})

describe('TaskEditor — kinds spécifiques', () => {
  it('jalon : fin et avancement désactivés, end_date = start_date au save', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={null}
        defaults={{
          name: 'Jalon test',
          start_date: '2026-06-01',
          end_date: '2026-06-01',
        }}
        collaborators={COLLABS}
        tasks={[]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Nom/), {
      target: { value: 'Jalon test' },
    })
    fireEvent.change(screen.getByLabelText(/Type/), {
      target: { value: 'milestone' },
    })
    expect(screen.getByLabelText(/^Fin/)).toBeDisabled()
    expect(screen.getByLabelText(/Avancement/)).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Créer' }))
    const patch = onSave.mock.calls[0][0]
    expect(patch.kind).toBe('milestone')
    expect(patch.end_date).toBe(patch.start_date)
  })

  it("phase : collaborateur et prédécesseur masqués, bandeau d'aide affiché", () => {
    render(
      <TaskEditor
        task={null}
        defaults={{
          name: 'P',
          start_date: '2026-06-01',
          end_date: '2026-06-30',
        }}
        collaborators={COLLABS}
        tasks={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Type/), {
      target: { value: 'phase' },
    })
    expect(screen.queryByLabelText(/Collaborateur/)).toBeNull()
    expect(screen.queryByLabelText(/Prédécesseur/)).toBeNull()
    expect(
      screen.getByText(/dates seront calculées automatiquement/),
    ).toBeInTheDocument()
  })
})

describe('TaskEditor — couleur', () => {
  it('bouton "↺ Auto" remet la couleur sur null', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={mkTask({ color: '#ff0000' })}
        collaborators={COLLABS}
        tasks={[]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }))
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer/ }))
    expect(onSave.mock.calls[0][0].color).toBeNull()
  })
})
