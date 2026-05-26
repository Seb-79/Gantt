// =============================================================================
// Tests AdvancePlanningToggle — v2.2 / RG-V (RG-GANTT-1910)
// @vitest-environment jsdom
// =============================================================================

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import AdvancePlanningToggle from './AdvancePlanningToggle'
import { getAdvancePlanning } from '../lib/storage'

describe('AdvancePlanningToggle (v2.2 / RG-V)', () => {
  beforeEach(() => localStorage.clear())

  it('affiche décoché par défaut', () => {
    render(<AdvancePlanningToggle projectId="p1" />)
    const cb = screen.getByLabelText(
      /planification anticipée/i,
    ) as HTMLInputElement
    expect(cb.checked).toBe(false)
  })

  it('persiste la valeur dans localStorage lors d’un clic', () => {
    render(<AdvancePlanningToggle projectId="p1" />)
    const cb = screen.getByLabelText(/planification anticipée/i)
    fireEvent.click(cb)
    expect(getAdvancePlanning('p1')).toBe(true)
  })

  it('relit la valeur persistée au montage', () => {
    localStorage.setItem('gantt:advance-planning:p1', 'true')
    render(<AdvancePlanningToggle projectId="p1" />)
    const cb = screen.getByLabelText(
      /planification anticipée/i,
    ) as HTMLInputElement
    expect(cb.checked).toBe(true)
  })

  it('isole les projets entre eux', () => {
    localStorage.setItem('gantt:advance-planning:p1', 'true')
    render(<AdvancePlanningToggle projectId="p2" />)
    const cb = screen.getByLabelText(
      /planification anticipée/i,
    ) as HTMLInputElement
    expect(cb.checked).toBe(false)
  })
})
