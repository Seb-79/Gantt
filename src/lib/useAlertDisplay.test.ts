// @vitest-environment jsdom
// =============================================================================
// TESTS — useAlertDisplay (Gantt v2.4)
// =============================================================================
// Vérifie la mémoire par projet de l'état d'affichage du bandeau de cohérence :
//   • défaut 'expanded' sans valeur stockée ;
//   • setDisplay met à jour + persiste pour le projet courant ;
//   • réhydratation depuis localStorage au changement de projet ;
//   • pas de fuite d'un projet à l'autre.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAlertDisplay } from './useAlertDisplay'
import { getAlertDisplay } from './storage'

describe('useAlertDisplay (v2.4)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("démarre à 'expanded' sans valeur stockée", () => {
    const { result } = renderHook(() => useAlertDisplay('p1'))
    expect(result.current.display).toBe('expanded')
  })

  it('setDisplay met à jour le state ET persiste pour le projet courant', () => {
    const { result } = renderHook(() => useAlertDisplay('p1'))
    act(() => result.current.setDisplay('acknowledged'))
    expect(result.current.display).toBe('acknowledged')
    expect(getAlertDisplay('p1')).toBe('acknowledged')
  })

  it('réhydrate depuis localStorage au changement de projet (mémoire)', () => {
    setStored('p1', 'collapsed')
    setStored('p2', 'acknowledged')
    const { result, rerender } = renderHook(({ pid }) => useAlertDisplay(pid), {
      initialProps: { pid: 'p1' },
    })
    expect(result.current.display).toBe('collapsed')
    rerender({ pid: 'p2' })
    expect(result.current.display).toBe('acknowledged')
    // Retour sur p1 → on retrouve son état exact.
    rerender({ pid: 'p1' })
    expect(result.current.display).toBe('collapsed')
  })

  it("repart à 'expanded' sur un projet jamais vu (pas de fuite)", () => {
    const { result, rerender } = renderHook(({ pid }) => useAlertDisplay(pid), {
      initialProps: { pid: 'p1' },
    })
    act(() => result.current.setDisplay('acknowledged'))
    rerender({ pid: 'p2' })
    expect(result.current.display).toBe('expanded')
  })
})

/** Helper : écrit directement la clé localStorage attendue par le hook. */
function setStored(projectId: string, value: string): void {
  localStorage.setItem(`gantt:alert-display:${projectId}`, value)
}
