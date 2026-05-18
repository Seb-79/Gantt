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
    priority: null,
    not_before_date: null,
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
  // v1.19.3 — Padding de base réduit de 8 → 2 px pour gagner de la place
  // à gauche de la colonne Tâches ; l'incrément d'indentation par niveau
  // reste de 16 px (hiérarchie toujours visible).
  it('indente chaque niveau de 16 px (parent=2, enfant=18, petit-enfant=34)', () => {
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
    expect(rowFor('Phase A').style.paddingLeft).toBe('2px')
    expect(rowFor('Sous-phase').style.paddingLeft).toBe('18px')
    expect(rowFor('Activité').style.paddingLeft).toBe('34px')
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

describe('GanttChart — header semaines au dézoom (v1.14)', () => {
  // À dayWidth >= 12, on doit voir des numéros de jour (ex. "11", "15").
  // À dayWidth < 12, ces numéros disparaissent au profit de "S20", "S21".
  it('bascule jours → semaines (S{N}) sous le seuil de zoom 12', () => {
    const tasks = [mkTask({ id: 't1', name: 'T1' })]
    const baseProps = {
      windowStart: '2026-05-11',
      windowEnd: '2026-05-24',
      tasks,
      collaborators: COLLABS,
    }
    // Zoom large : jours visibles, pas de "S20".
    const { container, rerender } = render(
      <GanttChart {...baseProps} dayWidth={20} />,
    )
    expect(container.textContent).toContain('11')
    expect(container.textContent).not.toContain('S20')

    // Dézoom (< 12) : semaines visibles, pas de chiffres de jour orphelins.
    rerender(<GanttChart {...baseProps} dayWidth={8} />)
    expect(container.textContent).toContain('S20')
    expect(container.textContent).toContain('S21')
  })
})

describe('GanttChart — nom dans les barres (v1.13)', () => {
  // Par défaut le nom de la tâche est écrit dans la barre quand la largeur
  // est suffisante. Avec showBarNames={false}, le span de nom interne
  // disparaît (la barre reste rendue, ainsi que le `title` au survol).
  it('affiche le nom par défaut et le masque avec showBarNames={false}', () => {
    const tasks = [
      mkTask({
        id: 't1',
        name: 'Ma tâche très visible',
        start_date: '2026-05-04',
        end_date: '2026-05-20', // largeur largement > 60 px
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
    // Le span de nom interne (pointer-events-none, présent dans la barre)
    // contient le texte exact de la tâche.
    expect(
      container.querySelector('span.pointer-events-none')?.textContent,
    ).toBe('Ma tâche très visible')

    rerender(<GanttChart {...baseProps} showBarNames={false} />)
    expect(container.querySelector('span.pointer-events-none')).toBeNull()
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
    // v1.19.2 — couleur durcie (slate-600) pour le contraste sur les
    // cellules week-end et au-dessus des barres de phase.
    const arrowPath = Array.from(paths).find(
      (p) => p.getAttribute('stroke') === '#475569',
    )
    expect(arrowPath).toBeTruthy()
  })

  // v1.23 — F4 : clic sur une flèche pour supprimer le lien prédécesseur.
  describe("suppression d'un lien au clic sur la flèche (v1.23 / F4)", () => {
    const tasksWithLink: Task[] = [
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

    it('rend un path ghost cliquable par flèche quand onDeleteLink est fourni', () => {
      const { container } = render(
        <GanttChart
          windowStart="2026-05-01"
          windowEnd="2026-05-31"
          dayWidth={20}
          tasks={tasksWithLink}
          collaborators={COLLABS}
          onDeleteLink={vi.fn()}
        />,
      )
      const hits = container.querySelectorAll('[data-pred-link-hit]')
      expect(hits.length).toBe(1)
      expect(hits[0].getAttribute('data-pred-link-hit')).toBe('a->b')
    })

    it('sans onDeleteLink, aucun path ghost rendu (flèches statiques)', () => {
      const { container } = render(
        <GanttChart
          windowStart="2026-05-01"
          windowEnd="2026-05-31"
          dayWidth={20}
          tasks={tasksWithLink}
          collaborators={COLLABS}
        />,
      )
      expect(container.querySelectorAll('[data-pred-link-hit]').length).toBe(0)
    })

    it('clic sur le ghost + confirm OK → callback (sourceId, targetId)', () => {
      const onDeleteLink = vi.fn()
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
      const { container } = render(
        <GanttChart
          windowStart="2026-05-01"
          windowEnd="2026-05-31"
          dayWidth={20}
          tasks={tasksWithLink}
          collaborators={COLLABS}
          onDeleteLink={onDeleteLink}
        />,
      )
      fireEvent.click(container.querySelector('[data-pred-link-hit="a->b"]')!)
      expect(confirmSpy).toHaveBeenCalled()
      expect(onDeleteLink).toHaveBeenCalledWith('a', 'b')
      confirmSpy.mockRestore()
    })

    it('clic + confirm Annuler → callback NON appelé', () => {
      const onDeleteLink = vi.fn()
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const { container } = render(
        <GanttChart
          windowStart="2026-05-01"
          windowEnd="2026-05-31"
          dayWidth={20}
          tasks={tasksWithLink}
          collaborators={COLLABS}
          onDeleteLink={onDeleteLink}
        />,
      )
      fireEvent.click(container.querySelector('[data-pred-link-hit="a->b"]')!)
      expect(confirmSpy).toHaveBeenCalled()
      expect(onDeleteLink).not.toHaveBeenCalled()
      confirmSpy.mockRestore()
    })
  })

  // v1.23 — F2 : handles bleus de drag-to-link à droite des barres.
  describe('handles drag-to-link (v1.23)', () => {
    const baseTasks: Task[] = [
      mkTask({
        id: 'ph',
        name: 'Phase',
        kind: 'phase',
        start_date: '2026-05-01',
        end_date: '2026-05-20',
      }),
      mkTask({
        id: 'a',
        name: 'A',
        start_date: '2026-05-01',
        end_date: '2026-05-05',
        parent_id: 'ph',
      }),
      mkTask({
        id: 'm',
        name: 'M',
        kind: 'milestone',
        start_date: '2026-05-15',
        end_date: '2026-05-15',
        parent_id: 'ph',
      }),
    ]

    it('aucun handle quand onCreateLink est absent (feature désactivée)', () => {
      const { container } = render(
        <GanttChart
          windowStart="2026-05-01"
          windowEnd="2026-05-31"
          dayWidth={20}
          tasks={baseTasks}
          collaborators={COLLABS}
        />,
      )
      expect(container.querySelectorAll('[data-link-source]').length).toBe(0)
    })

    it('un handle par activité et jalon (jamais sur phase) quand onCreateLink fourni', () => {
      const { container } = render(
        <GanttChart
          windowStart="2026-05-01"
          windowEnd="2026-05-31"
          dayWidth={20}
          tasks={baseTasks}
          collaborators={COLLABS}
          onCreateLink={vi.fn()}
        />,
      )
      const handles = container.querySelectorAll('[data-link-source]')
      expect(handles.length).toBe(2)
      const ids = Array.from(handles).map((h) =>
        h.getAttribute('data-link-source'),
      )
      expect(ids).toContain('a')
      expect(ids).toContain('m')
      expect(ids).not.toContain('ph')
    })
  })

  // v1.21 — Multi-prédécesseurs : une tâche avec N prédécesseurs doit
  // afficher N flèches distinctes (une par lien).
  it('rend N flèches quand task.predecessors contient N entrées', () => {
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
        start_date: '2026-05-06',
        end_date: '2026-05-09',
      }),
      mkTask({
        id: 'c',
        name: 'C',
        start_date: '2026-05-12',
        end_date: '2026-05-15',
        predecessors: [
          { id: 'a', lag: 0 },
          { id: 'b', lag: 0 },
        ],
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
    // On filtre par l'attribut `data-pred-link` qu'on émet sur chaque
    // chemin de flèche (pas dans le marker des `<defs>`).
    const arrows = container.querySelectorAll('path[data-pred-link]')
    expect(arrows.length).toBe(2)
    // Les deux liens sont étiquetés a→c et b→c.
    const labels = Array.from(arrows).map((p) =>
      p.getAttribute('data-pred-link'),
    )
    expect(labels).toEqual(expect.arrayContaining(['a->c', 'b->c']))
  })
})

// =============================================================================
// v1.20 — Tests de non-régression MÉTIER : repli/dépli des phases
// =============================================================================

describe('GanttChart — repli/dépli des phases (v1.20)', () => {
  it('affiche un chevron ▼ sur une phase qui a des enfants ET un callback', () => {
    // Garantit que l'affordance « repliable » apparaît uniquement quand
    // l'app a effectivement activé la fonctionnalité.
    const tasks: Task[] = [
      mkTask({ id: 'p1', name: 'Pré-prod', kind: 'phase' }),
      mkTask({ id: 't1', name: 'Recherche', parent_id: 'p1' }),
    ]
    const { container } = render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
        onToggleCollapse={vi.fn()}
      />,
    )
    // Le chevron est un <button> avec aria-label "Replier".
    expect(container.querySelector('button[aria-label="Replier"]')).toBeTruthy()
  })

  it('PAS de chevron sur une phase SANS enfant (rien à replier)', () => {
    const tasks: Task[] = [
      mkTask({ id: 'p1', name: 'Phase vide', kind: 'phase' }),
    ]
    const { container } = render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
        onToggleCollapse={vi.fn()}
      />,
    )
    expect(container.querySelector('button[aria-label="Replier"]')).toBeNull()
    // Et le pictogramme 🗂️ reste affiché à la place.
    expect(container.textContent).toContain('🗂️')
  })

  it("clic sur le chevron appelle onToggleCollapse avec l'id de la phase", () => {
    // Règle clé : c'est l'app qui gère le state, le composant ne fait
    // que signaler le clic.
    const onToggleCollapse = vi.fn()
    const tasks: Task[] = [
      mkTask({ id: 'p1', name: 'Pré-prod', kind: 'phase' }),
      mkTask({ id: 't1', parent_id: 'p1' }),
    ]
    const { container } = render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
        onToggleCollapse={onToggleCollapse}
      />,
    )
    const chevron = container.querySelector(
      'button[aria-label="Replier"]',
    ) as HTMLElement
    fireEvent.click(chevron)
    expect(onToggleCollapse).toHaveBeenCalledTimes(1)
    expect(onToggleCollapse).toHaveBeenCalledWith('p1')
  })

  it("clic sur le chevron N'ouvre PAS l'éditeur de la phase", () => {
    // Le chevron stopPropagation : sinon, replier déclencherait aussi
    // l'éditeur (clic sur la ligne) — confus pour l'utilisateur.
    const onToggleCollapse = vi.fn()
    const onTaskClick = vi.fn()
    const tasks: Task[] = [
      mkTask({ id: 'p1', name: 'Pré-prod', kind: 'phase' }),
      mkTask({ id: 't1', parent_id: 'p1' }),
    ]
    const { container } = render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
        onTaskClick={onTaskClick}
        onToggleCollapse={onToggleCollapse}
      />,
    )
    const chevron = container.querySelector(
      'button[aria-label="Replier"]',
    ) as HTMLElement
    fireEvent.click(chevron)
    expect(onToggleCollapse).toHaveBeenCalledTimes(1)
    expect(onTaskClick).not.toHaveBeenCalled()
  })

  it('phase repliée → glyphe ▶ (et aria-label « Déplier »)', () => {
    // L'app retire l'enfant de `tasks` (filterCollapsed), mais en lui
    // passant la liste complète via allTasks, on continue à savoir que
    // la phase a un enfant → le chevron reste rendu.
    const allTasks: Task[] = [
      mkTask({ id: 'p1', name: 'Pré-prod', kind: 'phase' }),
      mkTask({ id: 't1', parent_id: 'p1' }),
    ]
    const visible = allTasks.filter((t) => t.id !== 't1') // phase repliée
    const { container } = render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={visible}
        allTasks={allTasks}
        collaborators={COLLABS}
        collapsedPhases={new Set(['p1'])}
        onToggleCollapse={vi.fn()}
      />,
    )
    expect(container.querySelector('button[aria-label="Déplier"]')).toBeTruthy()
    expect(
      container.querySelector('button[aria-label="Déplier"]')?.textContent,
    ).toBe('▶')
  })
})

// =============================================================================
// v1.19.2 — Tests de non-régression MÉTIER : click sur barre du planning
// =============================================================================
// Règle : cliquer sur la barre/le losange/la phase dans le planning ouvre
// l'éditeur (équivalent au clic dans la colonne gauche). Sans collision avec
// les autres gestes (drag pour redimensionner, pan parent).

describe("GanttChart — click sur barre du planning ouvre l'éditeur", () => {
  it('clic sur une barre tâche → onTaskClick avec la tâche', () => {
    // Garantit l'accessibilité par défaut depuis le planning (et plus
    // uniquement depuis la colonne de gauche).
    const onTaskClick = vi.fn()
    const tasks = [
      mkTask({
        id: 't1',
        name: 'Ouvre-moi',
        start_date: '2026-05-05',
        end_date: '2026-05-09',
      }),
    ]
    const { container } = render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
        onTaskClick={onTaskClick}
        onResizeTask={vi.fn()}
      />,
    )
    // La barre interactive est rendue dans la zone calendrier ; on la cible
    // via son title (≠ du libellé de la colonne gauche par sa string complète).
    const bars = container.querySelectorAll('[title^="Ouvre-moi — 2026-"]')
    expect(bars.length).toBeGreaterThan(0)
    // Cycle mousedown → mouseup sans mousemove (deltaDays reste à 0) = clic.
    fireEvent.mouseDown(bars[0], { clientX: 100 })
    fireEvent.mouseUp(window, { clientX: 100 })
    expect(onTaskClick).toHaveBeenCalledTimes(1)
    expect(onTaskClick.mock.calls[0][0].id).toBe('t1')
  })

  it('v1.21 — drag vers la GAUCHE (passé) déplace bien la tâche', () => {
    // Non-régression v1.21 : l'utilisateur peut désormais ramener une tâche
    // dans le passé par drag (la règle "rightward only" a été levée). La
    // cohérence sera signalée par le bandeau d'alerte au-dessus du planning.
    const onResizeTask = vi.fn()
    const tasks = [
      mkTask({
        id: 't1',
        name: 'Tire-moi en arrière',
        // Lundi 11 mai 2026 → vendredi 15 mai (5 jours ouvrés).
        start_date: '2026-05-11',
        end_date: '2026-05-15',
      }),
    ]
    const { container } = render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
        onResizeTask={onResizeTask}
      />,
    )
    const bar = container.querySelector(
      '[title^="Tire-moi en arrière — 2026-"]',
    ) as HTMLElement
    // jsdom renvoie un DOMRect tout-à-zéro par défaut, ce qui placerait
    // toujours la souris dans la « poignée droite » (= mode resize-end).
    // On force ici un rect large où l'on cliquera au MILIEU, pour que
    // `handleBarMouseDown` détecte le mode « move ».
    bar.getBoundingClientRect = () =>
      ({
        left: 100,
        right: 300,
        top: 0,
        bottom: 26,
        width: 200,
        height: 26,
      }) as DOMRect
    // Mousedown au milieu (clientX=200, à 100px du bord droit → mode 'move')
    // → mousemove de -80 px (-4 jours) → mouseup.
    fireEvent.mouseDown(bar, { clientX: 200 })
    fireEvent.mouseMove(window, { clientX: 120 })
    fireEvent.mouseUp(window, { clientX: 120 })
    expect(onResizeTask).toHaveBeenCalledTimes(1)
    const patch = onResizeTask.mock.calls[0][1]
    // Mode 'move' : start_date ET end_date sont décalés vers le passé.
    expect(patch.start_date).toBeDefined()
    expect(patch.start_date < '2026-05-11').toBe(true)
    expect(patch.end_date).toBeDefined()
  })

  it("drag horizontal > 1 jour → PAS d'ouverture éditeur, c'est un déplacement", () => {
    // Sépare clairement le clic (édition) du drag (move/resize) : si l'user
    // fait un déplacement, l'éditeur ne doit PAS apparaître.
    const onTaskClick = vi.fn()
    const onResizeTask = vi.fn()
    const tasks = [
      mkTask({
        id: 't1',
        name: 'Drag-moi',
        start_date: '2026-05-05',
        end_date: '2026-05-07',
      }),
    ]
    const { container } = render(
      <GanttChart
        windowStart="2026-05-01"
        windowEnd="2026-05-31"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
        onTaskClick={onTaskClick}
        onResizeTask={onResizeTask}
      />,
    )
    const bar = container.querySelector(
      '[title^="Drag-moi — 2026-"]',
    ) as HTMLElement
    // Mousedown au milieu → mousemove de plus de dayWidth → mouseup.
    fireEvent.mouseDown(bar, { clientX: 50 })
    fireEvent.mouseMove(window, { clientX: 130 }) // +80 px = +4 jours
    fireEvent.mouseUp(window, { clientX: 130 })
    expect(onTaskClick).not.toHaveBeenCalled()
    expect(onResizeTask).toHaveBeenCalled()
  })

  it('clic sur un jalon (losange) → onTaskClick avec le jalon', () => {
    const onTaskClick = vi.fn()
    const tasks = [
      mkTask({
        id: 'm1',
        name: 'Mon jalon',
        kind: 'milestone',
        start_date: '2026-05-10',
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
        onTaskClick={onTaskClick}
      />,
    )
    // Le losange est l'élément avec rotate(45deg).
    const all = container.querySelectorAll('[title^="Mon jalon"]')
    const diamond = Array.from(all).find(
      (el) => (el as HTMLElement).style.transform === 'rotate(45deg)',
    )!
    fireEvent.click(diamond)
    expect(onTaskClick).toHaveBeenCalledTimes(1)
    expect(onTaskClick.mock.calls[0][0].id).toBe('m1')
  })

  it('clic sur une phase (barre dark) → onTaskClick avec la phase', () => {
    const onTaskClick = vi.fn()
    const tasks = [
      mkTask({
        id: 'p1',
        name: 'Ma phase',
        kind: 'phase',
        start_date: '2026-05-05',
        end_date: '2026-05-15',
      }),
    ]
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
    // Le conteneur de la phase est l'élément avec le title commençant par
    // "Phase « Ma phase »…".
    const phase = container.querySelector(
      '[title^="Phase « Ma phase »"]',
    ) as HTMLElement
    fireEvent.click(phase)
    expect(onTaskClick).toHaveBeenCalledTimes(1)
    expect(onTaskClick.mock.calls[0][0].id).toBe('p1')
  })
})

// =============================================================================
// v1.24 — Tests dédiés aux règles métier RG-GANTT-XXXX (cf.
// docs/regles-metier.md). Chaque test cite la règle qu'il garantit.
// =============================================================================

describe('v1.24 — RG-GANTT-0708 — triangle SNET dans le diagramme', () => {
  it('rend un triangle (élément avec tooltip "Ne doit pas démarrer avant le ...")', () => {
    // Garantit la présence d'un repère visuel pour la contrainte « Ne doit
    // pas démarrer avant le » sur les activités et les jalons qui en portent.
    const tasks = [
      mkTask({
        id: 't_snet',
        name: 'Avec SNET',
        start_date: '2026-05-20',
        end_date: '2026-05-25',
        not_before_date: '2026-05-15',
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
    const marker = container.querySelector(
      '[title^="Ne doit pas démarrer avant le"]',
    )
    expect(marker).not.toBeNull()
    expect(marker?.getAttribute('title')).toContain('2026-05-15')
  })

  it("n'affiche AUCUN triangle pour une activité sans contrainte SNET", () => {
    // Cas négatif : sans not_before_date, aucun repère visuel ne doit
    // apparaître.
    const tasks = [
      mkTask({
        id: 't_no_snet',
        name: 'Sans SNET',
        start_date: '2026-05-20',
        end_date: '2026-05-25',
        not_before_date: null,
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
    expect(
      container.querySelector('[title^="Ne doit pas démarrer avant le"]'),
    ).toBeNull()
  })

  it("n'affiche AUCUN triangle pour une phase (règle RG-GANTT-0309)", () => {
    // Une phase ne porte jamais de SNET — même avec une valeur résiduelle,
    // le triangle est masqué côté UI.
    const tasks = [
      mkTask({
        id: 'p_snet',
        name: 'Phase pollution',
        kind: 'phase',
        start_date: '2026-05-05',
        end_date: '2026-05-25',
        not_before_date: '2026-05-15',
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
    expect(
      container.querySelector('[title^="Ne doit pas démarrer avant le"]'),
    ).toBeNull()
  })
})
