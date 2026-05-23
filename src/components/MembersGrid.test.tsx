// @vitest-environment jsdom
// =============================================================================
// TESTS — MembersGrid (Gantt v2.1 / F4)
// =============================================================================
// Vérifie le clic-cycle (RG-GANTT-2000) et le mini-formulaire « + Période »
// (RG-GANTT-2005). Les autres interactions (drag-paint) sont couvertes par
// les tests purs de `useDragPaint`.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MembersGrid from './MembersGrid'
import type { Collaborator, MemberAllocation } from '../lib/types'

const COLLABS: Collaborator[] = [
  { id: 'alice', name: 'Alice', color: '#3b82f6', position: 0 },
  { id: 'bob', name: 'Bob', color: '#10b981', position: 1 },
]

const PROJ = 'p1'

/** Helper : monte la grille avec des callbacks mockés. */
function mount(opts?: Partial<React.ComponentProps<typeof MembersGrid>>) {
  const onAddMember = vi.fn()
  const onCreateCollaborator = vi.fn()
  const onAddAllocation = vi.fn()
  const onCommitChanges = vi.fn()
  const utils = render(
    <MembersGrid
      windowStart="2026-06-01"
      windowEnd="2026-06-05"
      dayWidth={40}
      collaborators={COLLABS}
      memberIds={['alice']}
      memberAllocations={[]}
      projectName="Projet 1"
      projectId={PROJ}
      onAddMember={onAddMember}
      onCreateCollaborator={onCreateCollaborator}
      onAddAllocation={onAddAllocation}
      onCommitChanges={onCommitChanges}
      {...opts}
    />,
  )
  return {
    onAddMember,
    onCreateCollaborator,
    onAddAllocation,
    onCommitChanges,
    ...utils,
  }
}

describe('MembersGrid (v2.1 / RG-GANTT-2000 / RG-GANTT-2005)', () => {
  it('RG-GANTT-2000 — clic sur case vide démarre le cycle (vide → 25)', () => {
    const { onCommitChanges } = mount()
    // Lundi 1er juin 2026 est ouvré → cellule cliquable.
    // On cible la cellule via son title (Alice — 01/06/2026 : 0 %).
    const cell = screen.getByTitle(/Alice — 01\/06\/2026 : 0 %/)
    // Mousedown déclenche le mousedown du hook drag-paint (= cycle).
    fireEvent.mouseDown(cell)
    // Le commit se déclenche au mouseup global (capturé par useDragPaint).
    fireEvent.mouseUp(window)
    expect(onCommitChanges).toHaveBeenCalledTimes(1)
    const [collabId, changes] = onCommitChanges.mock.calls[0]
    expect(collabId).toBe('alice')
    expect(changes.get('2026-06-01')).toBe(25)
  })

  it('RG-GANTT-2000 — clic sur case 50 → cycle au palier 75', () => {
    const { onCommitChanges } = mount({
      memberAllocations: [
        {
          id: 'a1',
          project_id: PROJ,
          collaborator_id: 'alice',
          start_date: '2026-06-01',
          end_date: '2026-06-05',
          allocation_pct: 50,
        } as MemberAllocation,
      ],
    })
    const cell = screen.getByTitle(/Alice — 01\/06\/2026 : 50 %/)
    fireEvent.mouseDown(cell)
    fireEvent.mouseUp(window)
    expect(onCommitChanges).toHaveBeenCalledTimes(1)
    const [, changes] = onCommitChanges.mock.calls[0]
    expect(changes.get('2026-06-01')).toBe(75)
  })

  it('RG-GANTT-2000 — clic sur case 100 → cycle au palier 0 (wrap-around)', () => {
    const { onCommitChanges } = mount({
      memberAllocations: [
        {
          id: 'a1',
          project_id: PROJ,
          collaborator_id: 'alice',
          start_date: '2026-06-01',
          end_date: '2026-06-05',
          allocation_pct: 100,
        } as MemberAllocation,
      ],
    })
    const cell = screen.getByTitle(/Alice — 01\/06\/2026 : 100 %/)
    fireEvent.mouseDown(cell)
    fireEvent.mouseUp(window)
    const [, changes] = onCommitChanges.mock.calls[0]
    expect(changes.get('2026-06-01')).toBe(0)
  })

  it('RG-GANTT-2005 — clic « + Période » ouvre le mini-formulaire', () => {
    mount()
    // Bouton « + Période » dans la colonne gauche.
    const btn = screen.getByTitle(/Ajouter une période d'allocation/)
    fireEvent.click(btn)
    // Le formulaire affiche les champs date début / date fin / %.
    expect(screen.getByText(/Période pour Alice/)).toBeInTheDocument()
    // Bouton Ajouter présent.
    expect(screen.getByRole('button', { name: 'Ajouter' })).toBeInTheDocument()
  })

  it('RG-GANTT-2005 — soumettre le formulaire appelle onAddAllocation avec le payload', () => {
    const { onAddAllocation } = mount()
    fireEvent.click(screen.getByTitle(/Ajouter une période d'allocation/))
    // Remplit les 3 champs via fireEvent.change.
    const inputs = screen.getAllByDisplayValue('') // 2 date inputs
    fireEvent.change(inputs[0], { target: { value: '2026-07-01' } })
    fireEvent.change(inputs[1], { target: { value: '2026-07-15' } })
    // % défaut 100, on le laisse.
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }))
    expect(onAddAllocation).toHaveBeenCalledTimes(1)
    expect(onAddAllocation).toHaveBeenCalledWith('alice', {
      start_date: '2026-07-01',
      end_date: '2026-07-15',
      allocation_pct: 100,
    })
  })

  // v2.2 / F4 — Bouton « + Nouveau collaborateur » : doit toujours être
  // visible (même si la liste des candidats est vide, cas où tous les
  // collabs existants sont déjà membres du projet courant).
  it('F4 — le bouton « + Nouveau » est visible même quand tous les collabs sont déjà membres', () => {
    mount({ memberIds: ['alice', 'bob'] })
    expect(screen.getByRole('button', { name: /Nouveau/ })).toBeInTheDocument()
  })

  it('F4 — clic sur « + Nouveau » appelle onCreateCollaborator', () => {
    const { onCreateCollaborator } = mount({ memberIds: ['alice', 'bob'] })
    fireEvent.click(screen.getByRole('button', { name: /Nouveau/ }))
    expect(onCreateCollaborator).toHaveBeenCalledTimes(1)
  })
})
