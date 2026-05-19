// @vitest-environment jsdom
// =============================================================================
// TESTS — WorkloadChart (v1.16)
// =============================================================================
// Vérifie les bases du rendu :
//   • Une ligne par collaborateur (même sans tâche).
//   • Charge cumulée affichée dans la cellule du bon jour.
//   • Cellule en surcharge → fond rouge (bg-red-500).
//   • Cellule pleine (= 1) → fond vert (bg-emerald-300).
//   • Week-ends → cellule grisée + jamais de chiffre.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import WorkloadChart from './WorkloadChart'
import type { Collaborator, Task } from '../lib/types'
import { mkTask as mkTaskBase } from '../test/fixtures'

/**
 * Wrapper local : ce fichier veut une fenêtre lundi-mardi (2026-05-11/12)
 * pour exercer la grille de charge sans tomber sur un WE. Les autres
 * champs viennent de la fixture partagée.
 */
function mkTask(overrides: Partial<Task> = {}): Task {
  return mkTaskBase({
    start_date: '2026-05-11',
    end_date: '2026-05-12',
    ...overrides,
  })
}

const COLLABS: Collaborator[] = [
  { id: 'alice', name: 'Alice', color: '#3b82f6', position: 0 },
  { id: 'bob', name: 'Bob', color: '#10b981', position: 1 },
]

describe('WorkloadChart — rendu de base', () => {
  it('rend une ligne par collaborateur, même sans tâche', () => {
    const { getByText } = render(
      <WorkloadChart
        windowStart="2026-05-11"
        windowEnd="2026-05-15"
        dayWidth={20}
        tasks={[]}
        collaborators={COLLABS}
      />,
    )
    expect(getByText('Alice')).toBeInTheDocument()
    expect(getByText('Bob')).toBeInTheDocument()
  })

  it('met en évidence la surcharge en rouge', () => {
    // Alice : 2 tâches le lundi 11/05 → surcharge
    const tasks: Task[] = [
      mkTask({
        id: 't1',
        collaborator_id: 'alice',
        start_date: '2026-05-11',
        end_date: '2026-05-11',
      }),
      mkTask({
        id: 't2',
        collaborator_id: 'alice',
        start_date: '2026-05-11',
        end_date: '2026-05-11',
      }),
    ]
    const { container } = render(
      <WorkloadChart
        windowStart="2026-05-11"
        windowEnd="2026-05-11"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
      />,
    )
    // La cellule chargée à 2 doit afficher "2" et porter le fond rouge.
    const red = container.querySelector('.bg-red-500')
    expect(red).toBeTruthy()
    expect(red?.textContent).toBe('2')
  })

  it('affiche le vert sur une journée pleine (charge = 1)', () => {
    const tasks: Task[] = [
      mkTask({
        id: 't',
        collaborator_id: 'alice',
        start_date: '2026-05-11',
        end_date: '2026-05-11',
      }),
    ]
    const { container } = render(
      <WorkloadChart
        windowStart="2026-05-11"
        windowEnd="2026-05-11"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
      />,
    )
    expect(container.querySelector('.bg-emerald-300')?.textContent).toBe('1')
  })

  it('highlightUnderload met les jours libres (sum < 1) en jaune (v1.17)', () => {
    // Alice n'a aucune tâche → tous ses jours ouvrés affichables sont à 0.
    // Lundi 11/05 et mardi 12/05 sont ouvrés et doivent passer au jaune.
    const { container } = render(
      <WorkloadChart
        windowStart="2026-05-11"
        windowEnd="2026-05-12"
        dayWidth={20}
        tasks={[]}
        collaborators={COLLABS}
        highlightUnderload
      />,
    )
    // Au moins 2 cellules jaune-pâle (une par collaborateur × jour ouvré).
    const yellowCells = container.querySelectorAll('.bg-yellow-200')
    expect(yellowCells.length).toBeGreaterThanOrEqual(2)
  })

  it('grise les week-ends sans y mettre de chiffre', () => {
    // Tâche qui couvre samedi 16/05 et dimanche 17/05.
    const tasks: Task[] = [
      mkTask({
        id: 't',
        collaborator_id: 'alice',
        start_date: '2026-05-15',
        end_date: '2026-05-18',
      }),
    ]
    const { container } = render(
      <WorkloadChart
        windowStart="2026-05-16"
        windowEnd="2026-05-17"
        dayWidth={20}
        tasks={tasks}
        collaborators={COLLABS}
      />,
    )
    // Les cellules CORPS de week-end ont la combinaison
    // `bg-slate-50 text-slate-300` (distincte du header qui n'a que
    // bg-slate-50 sur le parent). On vérifie qu'au moins une est présente
    // (les 2 cellules d'Alice, et 2 de Bob).
    const weekendCells = container.querySelectorAll(
      '.bg-slate-50.text-slate-300',
    )
    expect(weekendCells.length).toBeGreaterThanOrEqual(2)
    Array.from(weekendCells).forEach((c) => {
      expect(c.textContent).toBe('')
    })
  })
})
