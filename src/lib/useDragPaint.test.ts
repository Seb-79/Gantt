// =============================================================================
// TESTS — useDragPaint (Gantt v2.1 / F4 + F5)
// =============================================================================
// Vérifie la mécanique du hook générique de drag-paint horizontal partagé
// entre la grille « Affectation » (F4) et la grille « Congés » (F5).
//
// On utilise `renderHook` + `act` pour piloter l'état hors d'un composant
// React, et `fireEvent` (window.dispatchEvent) pour simuler le mouseup
// global capturé par le hook.
// =============================================================================

// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDragPaint } from './useDragPaint'

describe('useDragPaint (v2.1 / RG-GANTT-2001 / RG-GANTT-2006)', () => {
  /** Helper : monte le hook avec des mocks setLocal/onCommit injectés. */
  function mount() {
    const setLocal = vi.fn()
    const onCommit = vi.fn()
    const r = renderHook(() => useDragPaint<number>({ setLocal, onCommit }))
    return { setLocal, onCommit, r }
  }

  /** Helper : émet un mouseup global pour terminer le drag. */
  function fireMouseUp() {
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'))
    })
  }

  it('RG-GANTT-2001 — mousedown puis mouseup → onCommit avec 1 changement', () => {
    const { setLocal, onCommit, r } = mount()
    act(() => {
      r.result.current.onCellMouseDown('row-A', '2026-06-15', 50)
    })
    expect(setLocal).toHaveBeenCalledWith('row-A', '2026-06-15', 50)
    expect(r.result.current.isDragging).toBe(true)
    expect(r.result.current.paintingRowId).toBe('row-A')
    expect(r.result.current.paintingValue).toBe(50)
    fireMouseUp()
    expect(onCommit).toHaveBeenCalledTimes(1)
    const [rowId, changes] = onCommit.mock.calls[0]
    expect(rowId).toBe('row-A')
    expect(changes.size).toBe(1)
    expect(changes.get('2026-06-15')).toBe(50)
    expect(r.result.current.isDragging).toBe(false)
  })

  it('RG-GANTT-2001 — drag horizontal multi-cases → onCommit avec N changements', () => {
    const { setLocal, onCommit, r } = mount()
    act(() => {
      r.result.current.onCellMouseDown('row-A', '2026-06-15', 75)
      r.result.current.onCellEnter('row-A', '2026-06-16')
      r.result.current.onCellEnter('row-A', '2026-06-17')
    })
    // setLocal a été appelé 3 fois (la case de départ + 2 survols).
    expect(setLocal).toHaveBeenCalledTimes(3)
    expect(setLocal).toHaveBeenNthCalledWith(1, 'row-A', '2026-06-15', 75)
    expect(setLocal).toHaveBeenNthCalledWith(2, 'row-A', '2026-06-16', 75)
    expect(setLocal).toHaveBeenNthCalledWith(3, 'row-A', '2026-06-17', 75)
    fireMouseUp()
    expect(onCommit).toHaveBeenCalledTimes(1)
    const [, changes] = onCommit.mock.calls[0]
    expect(changes.size).toBe(3)
    expect(changes.get('2026-06-15')).toBe(75)
    expect(changes.get('2026-06-16')).toBe(75)
    expect(changes.get('2026-06-17')).toBe(75)
  })

  it('RG-GANTT-2001 — Q2 écrasement : la valeur du pinceau est appliquée même si la cellule était différente', () => {
    // La logique d'écrasement est dans le caller (`setLocal`) : le hook ne
    // connaît pas la valeur précédente, il pousse simplement `paintingValue`.
    // Ce test vérifie que le hook ne filtre PAS les cellules (pas de no-op
    // sur changement de valeur) — sauf si la même cellule a déjà été peinte
    // par CE drag (idempotence interne, voir test suivant).
    const { setLocal, r } = mount()
    act(() => {
      r.result.current.onCellMouseDown('row-A', '2026-06-15', 25)
      r.result.current.onCellEnter('row-A', '2026-06-16')
    })
    expect(setLocal).toHaveBeenCalledWith('row-A', '2026-06-16', 25)
  })

  it("RG-GANTT-2001 — idempotence : re-survol d'une cellule déjà peinte n'appelle pas setLocal", () => {
    const { setLocal, r } = mount()
    act(() => {
      r.result.current.onCellMouseDown('row-A', '2026-06-15', 50)
      r.result.current.onCellEnter('row-A', '2026-06-16')
      r.result.current.onCellEnter('row-A', '2026-06-16') // re-survol identique
    })
    // setLocal a été appelé 2 fois (mousedown + 1er enter), pas 3.
    expect(setLocal).toHaveBeenCalledTimes(2)
  })

  it('RG-GANTT-2006 — drag vertical désactivé : un onCellEnter sur une autre ligne est ignoré', () => {
    const { setLocal, onCommit, r } = mount()
    act(() => {
      r.result.current.onCellMouseDown('row-A', '2026-06-15', 100)
      // Survol d'une cellule sur une AUTRE ligne pendant le drag.
      r.result.current.onCellEnter('row-B', '2026-06-15')
      // Mais survol sur la même ligne fonctionne toujours.
      r.result.current.onCellEnter('row-A', '2026-06-16')
    })
    // setLocal n'a été appelé que pour row-A (mousedown + onCellEnter row-A).
    expect(setLocal).toHaveBeenCalledTimes(2)
    expect(setLocal).not.toHaveBeenCalledWith('row-B', '2026-06-15', 100)
    fireMouseUp()
    // Le commit final ne contient que les cellules row-A peintes.
    const [rowId, changes] = onCommit.mock.calls[0]
    expect(rowId).toBe('row-A')
    expect(changes.size).toBe(2)
    expect(changes.has('2026-06-15')).toBe(true)
    expect(changes.has('2026-06-16')).toBe(true)
  })

  it('hors drag, onCellEnter est un no-op', () => {
    const { setLocal, r } = mount()
    act(() => {
      r.result.current.onCellEnter('row-A', '2026-06-15')
    })
    expect(setLocal).not.toHaveBeenCalled()
  })

  it('mouseup sans aucun changement (cas dégénéré) → onCommit non appelé', () => {
    // Pas de mousedown préalable → mouseup global ne déclenche rien.
    const { onCommit } = mount()
    fireMouseUp()
    expect(onCommit).not.toHaveBeenCalled()
  })
})
