// =============================================================================
// storage.test.ts — Tests du helper de persistance localStorage
// @vitest-environment jsdom
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  getAdvancePlanning,
  setAdvancePlanning,
  getAlertDisplay,
  setAlertDisplay,
} from './storage'

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

describe("storage — état d'affichage de l'alerte de cohérence", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("lit 'expanded' par défaut quand aucune valeur stockée", () => {
    expect(getAlertDisplay('p1')).toBe('expanded')
  })

  it('écrit et relit les trois états', () => {
    setAlertDisplay('p1', 'collapsed')
    expect(getAlertDisplay('p1')).toBe('collapsed')
    setAlertDisplay('p1', 'acknowledged')
    expect(getAlertDisplay('p1')).toBe('acknowledged')
    setAlertDisplay('p1', 'expanded')
    expect(getAlertDisplay('p1')).toBe('expanded')
  })

  it('isole les projets entre eux', () => {
    setAlertDisplay('p1', 'acknowledged')
    expect(getAlertDisplay('p2')).toBe('expanded')
    setAlertDisplay('p2', 'collapsed')
    expect(getAlertDisplay('p1')).toBe('acknowledged')
    expect(getAlertDisplay('p2')).toBe('collapsed')
  })

  it("retombe sur 'expanded' si la valeur stockée est invalide", () => {
    localStorage.setItem('gantt:alert-display:p1', 'n-importe-quoi')
    expect(getAlertDisplay('p1')).toBe('expanded')
  })

  it('utilise la clé attendue (gantt:alert-display:{projectId})', () => {
    setAlertDisplay('proj-XYZ', 'collapsed')
    expect(localStorage.getItem('gantt:alert-display:proj-XYZ')).toBe(
      'collapsed',
    )
  })
})
