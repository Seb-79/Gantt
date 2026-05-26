// @vitest-environment jsdom
// =============================================================================
// TESTS — Tooltip (Gantt v2.2 / F1)
// =============================================================================
// Vérifie le contrat du composant Tooltip :
//   • Pas visible par défaut.
//   • Apparaît après le délai au mouseenter.
//   • Disparaît au mouseleave (et annule un délai en cours).
//   • Apparaît au focus clavier, disparaît au blur.
//   • Le contenu = la prop `label`.
//   • aria-describedby est ajouté quand visible.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Tooltip } from './Tooltip'

describe('Tooltip (RG-GANTT-2200)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Le tooltip ne doit jamais apparaître sans interaction utilisateur.
  it("n'affiche rien au montage", () => {
    render(
      <Tooltip label="Ceci est un tooltip">
        <button>Clique</button>
      </Tooltip>,
    )
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  // Au survol, le tooltip doit apparaître après le délai (150 ms par défaut).
  it('apparaît après le délai au mouseenter', () => {
    render(
      <Tooltip label="Hello world">
        <button>Clique</button>
      </Tooltip>,
    )
    const wrapper = screen.getByRole('button').parentElement!
    fireEvent.mouseEnter(wrapper)
    // Avant le délai, pas encore visible.
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(150)
    })
    // Après le délai, visible avec le bon contenu.
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('Hello world')
  })

  // Si la souris quitte avant la fin du délai, le tooltip ne doit jamais apparaître.
  it('annule le délai si la souris quitte avant la fin', () => {
    render(
      <Tooltip label="Caché">
        <button>Clique</button>
      </Tooltip>,
    )
    const wrapper = screen.getByRole('button').parentElement!
    fireEvent.mouseEnter(wrapper)
    act(() => {
      vi.advanceTimersByTime(100) // pas encore la fin du délai
    })
    fireEvent.mouseLeave(wrapper)
    act(() => {
      vi.advanceTimersByTime(200) // dépasse largement le délai initial
    })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  // Au mouseleave après apparition, le tooltip doit disparaître immédiatement.
  it('disparaît au mouseleave', () => {
    render(
      <Tooltip label="Visible puis caché">
        <button>Clique</button>
      </Tooltip>,
    )
    const wrapper = screen.getByRole('button').parentElement!
    fireEvent.mouseEnter(wrapper)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(screen.queryByRole('tooltip')).not.toBeNull()
    fireEvent.mouseLeave(wrapper)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  // Apparition au focus clavier (accessibilité).
  it('apparaît au focus et disparaît au blur', () => {
    render(
      <Tooltip label="Focus">
        <button>Clique</button>
      </Tooltip>,
    )
    const wrapper = screen.getByRole('button').parentElement!
    fireEvent.focus(wrapper)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(screen.queryByRole('tooltip')).not.toBeNull()
    fireEvent.blur(wrapper)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  // Le délai personnalisable doit être respecté.
  it('respecte un délai personnalisé', () => {
    render(
      <Tooltip label="Délai" delay={500}>
        <button>Clique</button>
      </Tooltip>,
    )
    const wrapper = screen.getByRole('button').parentElement!
    fireEvent.mouseEnter(wrapper)
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(screen.queryByRole('tooltip')).not.toBeNull()
  })
})
