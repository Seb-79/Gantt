// @vitest-environment jsdom
// =============================================================================
// TESTS — Hook useLinkDrag (v1.23 / F2)
// =============================================================================
// Hooks React testés via `renderHook` (Testing Library). On simule les
// événements mousemove / mouseup / keydown attendus sur `document`.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useLinkDrag } from './useLinkDrag'

/** Construit un faux DOMRect minimal pour le panneau scrollable. */
function fakePanelRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 600,
    width: 1000,
    height: 600,
    toJSON: () => ({}),
  } as DOMRect
}

describe('useLinkDrag', () => {
  it("startLink stocke l'origine et passe en mode linking", () => {
    const onCreateLink = vi.fn()
    const { result } = renderHook(() => useLinkDrag({ onCreateLink }))
    expect(result.current.isLinking).toBe(false)
    act(() => {
      result.current.startLink({
        sourceId: 'A',
        sourceX: 100,
        sourceY: 50,
        clientX: 105,
        clientY: 52,
        panelRect: fakePanelRect(),
        scrollLeft: 0,
      })
    })
    expect(result.current.isLinking).toBe(true)
    expect(result.current.state?.sourceId).toBe('A')
    expect(result.current.state?.sourceX).toBe(100)
    expect(result.current.state?.currentX).toBe(105)
  })

  it('dropOnTarget cible ≠ source → callback appelé, drag fermé', () => {
    const onCreateLink = vi.fn()
    const { result } = renderHook(() => useLinkDrag({ onCreateLink }))
    act(() => {
      result.current.startLink({
        sourceId: 'A',
        sourceX: 0,
        sourceY: 0,
        clientX: 0,
        clientY: 0,
        panelRect: fakePanelRect(),
        scrollLeft: 0,
      })
    })
    act(() => {
      result.current.dropOnTarget('B')
    })
    expect(onCreateLink).toHaveBeenCalledWith('A', 'B')
    expect(result.current.isLinking).toBe(false)
  })

  it('dropOnTarget sur soi-même → pas de callback (drop silencieux)', () => {
    const onCreateLink = vi.fn()
    const { result } = renderHook(() => useLinkDrag({ onCreateLink }))
    act(() => {
      result.current.startLink({
        sourceId: 'A',
        sourceX: 0,
        sourceY: 0,
        clientX: 0,
        clientY: 0,
        panelRect: fakePanelRect(),
        scrollLeft: 0,
      })
    })
    act(() => {
      result.current.dropOnTarget('A')
    })
    expect(onCreateLink).not.toHaveBeenCalled()
    expect(result.current.isLinking).toBe(false)
  })

  it('Escape pendant un drag annule sans appeler le callback', () => {
    const onCreateLink = vi.fn()
    const { result } = renderHook(() => useLinkDrag({ onCreateLink }))
    act(() => {
      result.current.startLink({
        sourceId: 'A',
        sourceX: 0,
        sourceY: 0,
        clientX: 0,
        clientY: 0,
        panelRect: fakePanelRect(),
        scrollLeft: 0,
      })
    })
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(result.current.isLinking).toBe(false)
    expect(onCreateLink).not.toHaveBeenCalled()
  })

  it('sans onCreateLink, startLink est no-op (feature désactivée)', () => {
    const { result } = renderHook(() => useLinkDrag({}))
    act(() => {
      result.current.startLink({
        sourceId: 'A',
        sourceX: 0,
        sourceY: 0,
        clientX: 0,
        clientY: 0,
        panelRect: fakePanelRect(),
        scrollLeft: 0,
      })
    })
    expect(result.current.isLinking).toBe(false)
  })
})
