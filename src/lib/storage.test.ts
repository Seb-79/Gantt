// =============================================================================
// storage.test.ts — Tests du helper de persistance localStorage
// @vitest-environment jsdom
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest'
import { getAdvancePlanning, setAdvancePlanning } from './storage'

describe('storage — advance planning toggle (v2.2 / RG-V)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('lit false par défaut quand aucune valeur stockée', () => {
    expect(getAdvancePlanning('p1')).toBe(false)
  })

  it('écrit et relit la valeur', () => {
    setAdvancePlanning('p1', true)
    expect(getAdvancePlanning('p1')).toBe(true)
    setAdvancePlanning('p1', false)
    expect(getAdvancePlanning('p1')).toBe(false)
  })

  it('isole les projets entre eux', () => {
    setAdvancePlanning('p1', true)
    expect(getAdvancePlanning('p2')).toBe(false)
    setAdvancePlanning('p2', true)
    expect(getAdvancePlanning('p1')).toBe(true)
    expect(getAdvancePlanning('p2')).toBe(true)
  })

  it('utilise la clé attendue (gantt:advance-planning:{projectId})', () => {
    setAdvancePlanning('proj-XYZ', true)
    expect(localStorage.getItem('gantt:advance-planning:proj-XYZ')).toBe('true')
  })
})
