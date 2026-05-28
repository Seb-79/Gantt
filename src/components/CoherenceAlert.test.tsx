// @vitest-environment jsdom
// =============================================================================
// TESTS — CoherenceAlert (Gantt v2.4 / masquage par état)
// =============================================================================
// Vérifie le contrat d'affichage du bandeau selon la prop `display` :
//   • issues vide → rend null (quel que soit `display`).
//   • 'expanded'     → messages + bouton Replan + contrôles replier/acquitter.
//   • 'collapsed'    → pastille seule (pas de message) ; clic → onExpand.
//   • 'acknowledged' → rend null.
// Et que les callbacks (onCollapse / onExpand / onAcknowledge) sont appelés.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import CoherenceAlert from './CoherenceAlert'
import type { CoherenceIssue } from '../lib/utils'

const ISSUES: CoherenceIssue[] = [
  {
    kind: 'overload',
    severity: 'error',
    taskIds: ['t1', 't2'],
    message: 'Surcharge détectée sur Alice',
  },
]

/** Props par défaut : tous les handlers sont des spies. */
function makeProps(over: Partial<Parameters<typeof CoherenceAlert>[0]> = {}) {
  return {
    issues: ISSUES,
    display: 'expanded' as const,
    onReplan: vi.fn(),
    onCollapse: vi.fn(),
    onExpand: vi.fn(),
    onAcknowledge: vi.fn(),
    ...over,
  }
}

describe('CoherenceAlert — masquage par état', () => {
  it('ne rend rien quand issues est vide', () => {
    render(<CoherenceAlert {...makeProps({ issues: [] })} />)
    expect(screen.queryByTestId('coherence-alert')).toBeNull()
    expect(screen.queryByTestId('coherence-alert-pill')).toBeNull()
  })

  it("'expanded' : affiche les messages, le Replan et les contrôles", () => {
    render(<CoherenceAlert {...makeProps()} />)
    expect(screen.getByTestId('coherence-alert')).toBeTruthy()
    expect(screen.getByText('Surcharge détectée sur Alice')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Replan complet/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Replier/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Acquitter/i })).toBeTruthy()
  })

  it("'expanded' : clic Replier appelle onCollapse", () => {
    const props = makeProps()
    render(<CoherenceAlert {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Replier/i }))
    expect(props.onCollapse).toHaveBeenCalledOnce()
  })

  it("'expanded' : clic Acquitter appelle onAcknowledge", () => {
    const props = makeProps()
    render(<CoherenceAlert {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Acquitter/i }))
    expect(props.onAcknowledge).toHaveBeenCalledOnce()
  })

  it("'collapsed' : affiche la pastille seule, sans les messages", () => {
    render(<CoherenceAlert {...makeProps({ display: 'collapsed' })} />)
    expect(screen.getByTestId('coherence-alert-pill')).toBeTruthy()
    expect(screen.queryByTestId('coherence-alert')).toBeNull()
    expect(screen.queryByText('Surcharge détectée sur Alice')).toBeNull()
  })

  it("'collapsed' : clic sur la pastille appelle onExpand", () => {
    const props = makeProps({ display: 'collapsed' })
    render(<CoherenceAlert {...props} />)
    fireEvent.click(screen.getByTestId('coherence-alert-pill'))
    expect(props.onExpand).toHaveBeenCalledOnce()
  })

  it("'acknowledged' : ne rend rien", () => {
    render(<CoherenceAlert {...makeProps({ display: 'acknowledged' })} />)
    expect(screen.queryByTestId('coherence-alert')).toBeNull()
    expect(screen.queryByTestId('coherence-alert-pill')).toBeNull()
  })
})
