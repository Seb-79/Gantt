// @vitest-environment jsdom
// =============================================================================
// TESTS — AbsencesGrid (Gantt v2.1 / F5)
// =============================================================================
// Vérifie le clic-cycle de la fraction d'absence (RG-GANTT-2003), le bouton
// « + Période » (RG-GANTT-2005), et le contrat du commit POST/DELETE par
// jour modifié (RG-GANTT-2004).
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import AbsencesGrid from './AbsencesGrid'
import type { Collaborator, CollaboratorAbsence } from '../lib/types'

const COLLABS: Collaborator[] = [
  { id: 'alice', name: 'Alice', color: '#3b82f6', position: 0 },
]

/** Helper : monte la grille avec des callbacks mockés. */
function mount(opts?: Partial<React.ComponentProps<typeof AbsencesGrid>>) {
  const onCommitChanges = vi.fn()
  const onAddPeriod = vi.fn()
  const utils = render(
    <AbsencesGrid
      windowStart="2026-06-01"
      windowEnd="2026-06-05"
      dayWidth={40}
      collaborators={COLLABS}
      absences={[]}
      onCommitChanges={onCommitChanges}
      onAddPeriod={onAddPeriod}
      {...opts}
    />,
  )
  return { onCommitChanges, onAddPeriod, ...utils }
}

describe('AbsencesGrid (v2.1 / RG-GANTT-2003 / RG-GANTT-2004 / RG-GANTT-2005)', () => {
  it('RG-GANTT-2003 — clic sur case vide cycle vers 0,25', () => {
    const { onCommitChanges } = mount()
    const cell = screen.getByTitle(/Alice — 01\/06\/2026 : pas de congé/)
    fireEvent.mouseDown(cell)
    fireEvent.mouseUp(window)
    expect(onCommitChanges).toHaveBeenCalledTimes(1)
    const [collabId, changes] = onCommitChanges.mock.calls[0]
    expect(collabId).toBe('alice')
    expect(changes.get('2026-06-01')).toBe(0.25)
  })

  it('RG-GANTT-2003 — clic sur case 0,5 cycle vers 0,75', () => {
    const { onCommitChanges } = mount({
      absences: [
        {
          collaborator_id: 'alice',
          date: '2026-06-01',
          fraction: 0.5,
        } as CollaboratorAbsence,
      ],
    })
    const cell = screen.getByTitle(/Alice — 01\/06\/2026 : 0,5 j/)
    fireEvent.mouseDown(cell)
    fireEvent.mouseUp(window)
    const [, changes] = onCommitChanges.mock.calls[0]
    expect(changes.get('2026-06-01')).toBe(0.75)
  })

  it('RG-GANTT-2003 — clic sur case 1 → cycle vers 0 (wrap-around)', () => {
    const { onCommitChanges } = mount({
      absences: [
        {
          collaborator_id: 'alice',
          date: '2026-06-01',
          fraction: 1,
        } as CollaboratorAbsence,
      ],
    })
    const cell = screen.getByTitle(/Alice — 01\/06\/2026 : 1 j/)
    fireEvent.mouseDown(cell)
    fireEvent.mouseUp(window)
    const [, changes] = onCommitChanges.mock.calls[0]
    expect(changes.get('2026-06-01')).toBe(0)
  })

  it('RG-GANTT-2004 — un drag horizontal sur 2 cases produit 2 entrées dans le batch', () => {
    const { onCommitChanges } = mount()
    const cell1 = screen.getByTitle(/Alice — 01\/06\/2026 : pas de congé/)
    const cell2 = screen.getByTitle(/Alice — 02\/06\/2026 : pas de congé/)
    fireEvent.mouseDown(cell1)
    fireEvent.mouseEnter(cell2)
    fireEvent.mouseUp(window)
    expect(onCommitChanges).toHaveBeenCalledTimes(1)
    const [, changes] = onCommitChanges.mock.calls[0]
    expect(changes.size).toBe(2)
    expect(changes.get('2026-06-01')).toBe(0.25)
    expect(changes.get('2026-06-02')).toBe(0.25)
  })

  it('RG-GANTT-2005 — clic « + Période » ouvre le formulaire et soumettre appelle onAddPeriod', () => {
    const { onAddPeriod } = mount()
    fireEvent.click(screen.getByTitle(/Ajouter une période de congés/))
    expect(screen.getByText(/Période pour Alice/)).toBeInTheDocument()
    const inputs = screen.getAllByDisplayValue('')
    fireEvent.change(inputs[0], { target: { value: '2026-08-10' } })
    fireEvent.change(inputs[1], { target: { value: '2026-08-12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }))
    expect(onAddPeriod).toHaveBeenCalledWith('alice', {
      start_date: '2026-08-10',
      end_date: '2026-08-12',
      fraction: 1,
    })
  })
})
