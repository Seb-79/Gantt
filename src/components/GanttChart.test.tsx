// @vitest-environment jsdom
// =============================================================================
// TESTS — GanttChart (composant React)
// =============================================================================
// Vérifie le rendu de la colonne de gauche et de la grille :
//   • Header (mois + jours)
//   • Une ligne par tâche, libellé + icône selon le kind
//   • Indentation hiérarchique par profondeur (parent → enfant → petit-enfant)
//   • Clic sur une ligne → callback onTaskClick avec la bonne tâche
//   • Présence du SVG des flèches quand un prédécesseur existe
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import GanttChart from './GanttChart'
import type { Collaborator, Task } from '../lib/types'

/** Helper tâche. */
function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't',
    name: 'T',
    kind: 'task',
    start_date: '2026-05-01',
    end_date: '2026-05-05',
    progress: 0,
    collaborator_id: null,
    color: null,
    parent_id: null,
    predecessor_id: null,
    predecessor_lag: 0,
    position: 0,
    project_id: 'p_test',
    ...overrides,
  }
}

const COLLABS: Collaborator[] = [
  { id: 'c1', name: 'Alice', color: '#3b82f6', position: 0 },
]

describe('GanttChart — rendu de base', () => {
  it('affiche une ligne par tâche avec son nom', () => {
    const tasks = [
      mkTask({ id: 't1', name: 'Première' }),
      mkTask({ id: 't2', name: 'Deuxième' }),
    ]
    const { container } = render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
      />,
    )
    // Le nom peut apparaître 2 fois (label colonne gauche + libellé dans la
    // barre quand elle est assez large). On cible la ligne par son title.
    expect(
      container.querySelector('[draggable="true"][title="Première"]'),
    ).toBeTruthy()
    expect(
      container.querySelector('[draggable="true"][title="Deuxième"]'),
    ).toBeTruthy()
  })

  it('affiche le pictogramme correct selon le kind (◆ jalon, 🗂️ phase)', () => {
    const tasks = [
      mkTask({ id: 'p', name: 'Phase X', kind: 'phase' }),
      mkTask({ id: 'm', name: 'Jalon X', kind: 'milestone' }),
    ]
    const { container } = render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
      />,
    )
    expect(container.textContent).toContain('◆')
    expect(container.textContent).toContain('🗂️')
  })

  it('affiche la pastille collaborateur si la tâche en a un', () => {
    const tasks = [mkTask({ id: 't1', name: 'A', collaborator_id: 'c1' })]
    render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
      />,
    )
    expect(screen.getByText('Alice')).toBeInTheDocument()
  })
})

describe('GanttChart — indentation hiérarchique', () => {
  // v1.11 — Padding de base réduit de 12 → 8 px (compaction de la colonne
  // gauche), l'incrément d'indentation par niveau reste de 16 px.
  it('indente chaque niveau de 16 px (parent=8, enfant=24, petit-enfant=40)', () => {
    const tasks: Task[] = [
      mkTask({ id: 'p1', name: 'Phase A', kind: 'phase' }),
      mkTask({ id: 'p1a', name: 'Sous-phase', kind: 'phase', parent_id: 'p1' }),
      mkTask({ id: 't1', name: 'Activité', parent_id: 'p1a' }),
    ]
    const { container } = render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
      />,
    )
    // Récupère la ligne (élément draggable) de chaque tâche par son titre.
    const rowFor = (name: string) =>
      container.querySelector(
        `[draggable="true"][title="${name}"]`,
      ) as HTMLElement
    expect(rowFor('Phase A').style.paddingLeft).toBe('8px')
    expect(rowFor('Sous-phase').style.paddingLeft).toBe('24px')
    expect(rowFor('Activité').style.paddingLeft).toBe('40px')
  })
})

describe('GanttChart — interactions', () => {
  it('clic sur une ligne appelle onTaskClick avec la tâche', () => {
    const onTaskClick = vi.fn()
    const tasks = [mkTask({ id: 't1', name: 'Clique-moi' })]
    const { container } = render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
        onTaskClick={onTaskClick}
      />,
    )
    const row = container.querySelector(
      '[draggable="true"][title="Clique-moi"]',
    )!
    fireEvent.click(row)
    expect(onTaskClick).toHaveBeenCalledTimes(1)
    expect(onTaskClick.mock.calls[0][0].id).toBe('t1')
  })
})

describe('GanttChart — rendu spécifique aux kinds', () => {
  it('phase : barre épaisse foncée avec chevrons', () => {
    const tasks = [
      mkTask({
        id: 'p',
        name: 'Phase X',
        kind: 'phase',
        start_date: '2026-05-01',
        end_date: '2026-05-10',
      }),
    ]
    const { container } = render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
      />,
    )
    expect(container.querySelector('[title^="Phase « Phase X »"]')).toBeTruthy()
  })

  it('jalon : losange centré (élément avec rotate 45deg)', () => {
    const tasks = [
      mkTask({
        id: 'm',
        name: 'Jalon X',
        kind: 'milestone',
        start_date: '2026-05-05',
        end_date: '2026-05-05',
      }),
    ]
    const { container } = render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
      />,
    )
    // Plusieurs éléments ont le title (ligne gauche + barre) — on filtre
    // sur celui qui a la transformation rotation (= la barre losange).
    const all = container.querySelectorAll('[title^="Jalon X"]')
    const milestone = Array.from(all).find(
      (el) => (el as HTMLElement).style.transform === 'rotate(45deg)',
    )
    expect(milestone).toBeTruthy()
  })
})

describe('GanttChart — drag & drop', () => {
  it("onDragStart pose l'id, onDrop appelle onMoveTask", () => {
    const onMoveTask = vi.fn()
    const tasks = [
      mkTask({ id: 't1', name: 'A' }),
      mkTask({ id: 't2', name: 'B' }),
    ]
    const { container } = render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
        onMoveTask={onMoveTask}
      />,
    )
    const rowA = container.querySelector('[title="A"]') as HTMLElement
    const rowB = container.querySelector('[title="B"]') as HTMLElement

    // Simule un dataTransfer minimaliste pour driver les handlers.
    const storage: Record<string, string> = {}
    const dataTransfer = {
      setData: (k: string, v: string) => {
        storage[k] = v
      },
      getData: (k: string) => storage[k],
      effectAllowed: '',
      dropEffect: '',
    }

    fireEvent.dragStart(rowA, { dataTransfer })
    // Position du curseur "tiers haut" → zone 'before'.
    // getBoundingClientRect renvoie 0 sous jsdom → ratio NaN, on saute la
    // logique de zone et on cible directement le drop avec zone calculée
    // via spy : on s'assure simplement que le callback est invoqué.
    fireEvent.dragOver(rowB, { dataTransfer, clientY: 0 })
    fireEvent.drop(rowB, { dataTransfer, clientY: 0 })
    expect(onMoveTask).toHaveBeenCalled()
    expect(onMoveTask.mock.calls[0][0]).toBe('t1')
  })
})

describe('GanttChart — affichage des dates (v1.11)', () => {
  // Quand showDates est faux ou absent, aucun libellé 'dd/MM' ne doit
  // apparaître à droite des barres. Quand il est vrai, on doit retrouver
  // au moins les bornes de la tâche au format jour/mois (sans année).
  it('masque les dates par défaut et les affiche avec showDates=true', () => {
    const tasks = [
      mkTask({
        id: 't1',
        name: 'T1',
        start_date: '2026-05-04',
        end_date: '2026-05-08',
      }),
    ]
    const baseProps = {
      windowStart: '2026-05-01',
      windowEnd: '2026-05-31',
      dayWidth: 20,
      tasks,
      collaborators: COLLABS,
    }
    const { container, rerender } = render(<GanttChart {...baseProps} />)
    expect(container.textContent ?? '').not.toContain('04/05')
    expect(container.textContent ?? '').not.toContain('08/05')

    rerender(<GanttChart {...baseProps} showDates />)
    expect(container.textContent ?? '').toContain('04/05')
    expect(container.textContent ?? '').toContain('08/05')
  })
})

describe('GanttChart — flèches prédécesseurs', () => {
  it('rend un <path> dans le SVG pour chaque prédécesseur référencé', () => {
    const tasks: Task[] = [
      mkTask({
        id: 'a',
        name: 'A',
        start_date: '2026-05-01',
        end_date: '2026-05-05',
      }),
      mkTask({
        id: 'b',
        name: 'B',
        start_date: '2026-05-10',
        end_date: '2026-05-15',
        predecessor_id: 'a',
      }),
    ]
    const { container } = render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
      />,
    )
    const paths = container.querySelectorAll('svg path')
    // 1 path = la flèche prédécesseur (les markers `<defs>` n'en contiennent
    // qu'un autre identifié via id="gantt-arrow" mais c'est dans <defs>).
    const arrowPath = Array.from(paths).find(
      (p) => p.getAttribute('stroke') === '#94a3b8',
    )
    expect(arrowPath).toBeTruthy()
  })
})
