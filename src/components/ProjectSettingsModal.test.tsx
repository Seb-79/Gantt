// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ProjectSettingsModal from './ProjectSettingsModal'
import type { Project, Task } from '../lib/types'

const mkProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Projet 1',
  position: 0,
  project_start_date: '2026-06-01',
  ...overrides,
})

const mkTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: 't1',
    name: 'T1',
    kind: 'task',
    start_date: '2026-06-10',
    end_date: '2026-06-15',
    progress: 0,
    collaborator_id: null,
    color: null,
    parent_id: null,
    predecessor_id: null,
    predecessor_lag: 0,
    priority: null,
    not_before_date: null,
    not_later_than_date: null,
    charge_jours: 5,
    position: 0,
    project_id: 'p1',
    ...overrides,
  }) as Task

describe('ProjectSettingsModal (v2.3 / RG-GANTT-2101 + 2110)', () => {
  afterEach(() => cleanup())

  it('ne rend rien si project=null', () => {
    render(
      <ProjectSettingsModal
        project={null}
        tasks={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it("affiche nom et date du projet à l'ouverture", () => {
    render(
      <ProjectSettingsModal
        project={mkProject()}
        tasks={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const name = screen.getByLabelText(/nom du projet/i) as HTMLInputElement
    const date = screen.getByLabelText(/date de démarrage/i) as HTMLInputElement
    expect(name.value).toBe('Projet 1')
    expect(date.value).toBe('2026-06-01')
  })

  it('Enregistrer désactivé si aucune modification', () => {
    render(
      <ProjectSettingsModal
        project={mkProject()}
        tasks={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /enregistrer/i })).toBeDisabled()
  })

  it('onSave appelée avec patch nom seul (replanRequested=false)', () => {
    const onSave = vi.fn()
    render(
      <ProjectSettingsModal
        project={mkProject()}
        tasks={[]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/nom du projet/i), {
      target: { value: 'Renommé' },
    })
    fireEvent.click(screen.getByRole('button', { name: /enregistrer/i }))
    expect(onSave).toHaveBeenCalledWith({ name: 'Renommé' }, false)
  })

  it('onSave appelée avec patch date + replanRequested=true par défaut', () => {
    const onSave = vi.fn()
    render(
      <ProjectSettingsModal
        project={mkProject()}
        tasks={[]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/date de démarrage/i), {
      target: { value: '2026-07-01' },
    })
    fireEvent.click(screen.getByRole('button', { name: /enregistrer/i }))
    expect(onSave).toHaveBeenCalledWith(
      { project_start_date: '2026-07-01' },
      true,
    )
  })

  it("RG-2110 : refuse la date si > start d'une tâche progress>0 (Enregistrer désactivé)", () => {
    const tasks = [
      mkTask({
        id: 'ti',
        name: 'En cours',
        start_date: '2026-06-05',
        progress: 50,
      }),
    ]
    render(
      <ProjectSettingsModal
        project={mkProject()}
        tasks={tasks}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    // On essaie de mettre la date à 2026-09-01 (postérieure à la tâche ti).
    fireEvent.change(screen.getByLabelText(/date de démarrage/i), {
      target: { value: '2026-09-01' },
    })
    // Message d'erreur attendu + bouton désactivé.
    expect(
      screen.getByText(/En cours.*déjà démarrée le 2026-06-05/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /enregistrer/i })).toBeDisabled()
  })

  it('RG-2110 : autorise la date si <= start de la tâche progress>0', () => {
    const tasks = [
      mkTask({
        id: 'ti',
        name: 'En cours',
        start_date: '2026-06-05',
        progress: 50,
      }),
    ]
    const onSave = vi.fn()
    render(
      <ProjectSettingsModal
        project={mkProject()}
        tasks={tasks}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/date de démarrage/i), {
      target: { value: '2026-06-05' },
    })
    fireEvent.click(screen.getByRole('button', { name: /enregistrer/i }))
    expect(onSave).toHaveBeenCalledWith(
      { project_start_date: '2026-06-05' },
      true,
    )
  })
})
