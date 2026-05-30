// @vitest-environment jsdom
// =============================================================================
// TESTS — TaskEditor (composant React)
// =============================================================================
// On exerce la logique métier du modal :
//   • Validation client : nom obligatoire, end_date ≥ start_date
//   • Prédécesseur : start_date initialisée mais éditable, borne MIN
//   • Phase / jalon / tâche : champs visibles ou cachés selon le type
//   • Couleur custom + retour à "Auto"
//   • Annulation + suppression (callbacks)
// Les tests utilisent React Testing Library (RTL) — on cible des rôles
// et libellés accessibles plutôt que des sélecteurs CSS internes.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TaskEditor from './TaskEditor'
import type { Collaborator, Task } from '../lib/types'
import { mkTask as mkTaskBase } from '../test/fixtures'

/**
 * Wrapper local : ce fichier veut une tâche par défaut nommée « Tâche A »
 * (id `t1`) avec une fenêtre [2026-05-01, 2026-05-10] — suffisamment large
 * pour exercer les contrôles d'édition (modifier `end_date`, déplacer
 * `start_date`, etc.). Les autres champs viennent de la fixture partagée.
 */
function mkTask(overrides: Partial<Task> = {}): Task {
  return mkTaskBase({
    id: 't1',
    name: 'Tâche A',
    end_date: '2026-05-10',
    ...overrides,
  })
}

const COLLABS: Collaborator[] = [
  { id: 'c1', name: 'Alice', color: '#3b82f6', position: 0 },
]

describe('TaskEditor — création', () => {
  it('affiche le titre "Nouvelle tâche / jalon / phase" en mode création', () => {
    render(
      <TaskEditor
        task={null}
        defaults={{ start_date: '2026-05-01', end_date: '2026-05-01' }}
        collaborators={COLLABS}
        tasks={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('heading', { name: /Nouvelle tâche/ }),
    ).toBeInTheDocument()
  })

  it('RG-GANTT-0005 — refuse la sauvegarde si le nom est vide', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={null}
        defaults={{ start_date: '2026-05-01' }}
        collaborators={COLLABS}
        tasks={[]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Créer' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/nom est obligatoire/i)
  })

  it('RG-GANTT-0101 — appelle onSave avec les champs saisis (collaborateur unique)', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={null}
        defaults={{ start_date: '2026-05-01', end_date: '2026-05-01' }}
        collaborators={COLLABS}
        tasks={[]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Nom/), {
      target: { value: 'Ma tâche' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Créer' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    const patch = onSave.mock.calls[0][0]
    expect(patch.name).toBe('Ma tâche')
    expect(patch.kind).toBe('task')
    expect(patch.start_date).toBe('2026-05-01')
  })
})

describe('TaskEditor — édition', () => {
  it('pré-remplit le formulaire à partir de la tâche', () => {
    render(
      <TaskEditor
        task={mkTask({ name: 'Existante', progress: 42 })}
        collaborators={COLLABS}
        tasks={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByLabelText(/Nom/)).toHaveValue('Existante')
    expect(screen.getByLabelText(/Avancement/)).toHaveValue(42)
    // v2.1 / F2 — Le layout 2 colonnes introduit des <h3> de section (Identité,
    // Dates, Ressources, Dépendances) en plus du <h2> titre. On cible le h2.
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Modifier',
    )
  })

  it('RG-GANTT-0004 — refuse une end_date < start_date', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={mkTask()}
        collaborators={COLLABS}
        tasks={[]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    // v2.0 / F4 — Le label complet est « Fin (calculée) » pour kind='task'.
    // Un regex large `/calculée/` discrimine vs. les labels « Fin » (jalon)
    // et « Fin au plus tard » (FNLT), peu importe l'espacement DOM.
    fireEvent.change(screen.getByLabelText(/calculée/), {
      target: { value: '2026-04-01' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer/ }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/date de fin/i)
  })

  it('bouton Supprimer appelle onDelete (uniquement en édition)', () => {
    const onDelete = vi.fn()
    render(
      <TaskEditor
        task={mkTask()}
        collaborators={COLLABS}
        tasks={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
        onDelete={onDelete}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Supprimer/ }))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('Annuler appelle onClose sans onSave', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    render(
      <TaskEditor
        task={mkTask()}
        collaborators={COLLABS}
        tasks={[]}
        onSave={onSave}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('TaskEditor — prédécesseur (v1.22 picker arborescent)', () => {
  const PRED = mkTask({
    id: 'tA',
    name: 'Prédécesseur',
    start_date: '2026-05-01',
    end_date: '2026-05-15',
  })

  /** Ouvre le popover du PredecessorPicker (bouton « + Ajouter… »). */
  function openPicker() {
    fireEvent.click(
      screen.getByRole('button', { name: /ajouter un prédécesseur/i }),
    )
  }

  /** Clique dans le popover sur la ligne d'id donné pour l'ajouter. */
  function pickTask(id: string) {
    const row = document.querySelector(`[data-task-id="${id}"]`)
    if (!row) throw new Error(`Ligne tâche ${id} introuvable dans le picker`)
    fireEvent.click(row)
  }

  it("RG-GANTT-0204 / RG-GANTT-0409 — liste les jalons en plus des tâches dans l'arbre du picker", () => {
    const milestone = mkTask({
      id: 'mA',
      name: 'Jalon',
      kind: 'milestone',
      start_date: '2026-05-20',
      end_date: '2026-05-20',
    })
    render(
      <TaskEditor
        task={null}
        defaults={{ start_date: '2026-05-22', end_date: '2026-05-25' }}
        collaborators={COLLABS}
        tasks={[PRED, milestone]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    openPicker()
    // Les deux tâches sont rendues dans l'arbre, le jalon préfixé par ◆.
    expect(document.querySelector('[data-task-id="tA"]')).toBeInTheDocument()
    const mRow = document.querySelector('[data-task-id="mA"]')!
    expect(mRow.textContent).toMatch(/◆/)
  })

  it('initialise start_date sur la end_date du prédécesseur choisi', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={null}
        defaults={{
          name: 'Nouvelle',
          start_date: '2026-05-01',
          end_date: '2026-05-01',
        }}
        collaborators={COLLABS}
        tasks={[PRED]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Nom/), {
      target: { value: 'Nouvelle' },
    })
    openPicker()
    pickTask('tA')
    // La date de début est poussée à 2026-05-15 (fin du prédécesseur).
    expect(screen.getByLabelText(/^Début/)).toHaveValue('2026-05-15')
    fireEvent.click(screen.getByRole('button', { name: 'Créer' }))
    expect(onSave.mock.calls[0][0].start_date).toBe('2026-05-15')
    expect(onSave.mock.calls[0][0].predecessors).toEqual([{ id: 'tA', lag: 0 }])
  })

  it('RG-GANTT-0401 — refuse une start_date < borne basse (MAX prédécesseur)', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={null}
        defaults={{
          name: 'X',
          start_date: '2026-05-15',
          end_date: '2026-05-20',
        }}
        collaborators={COLLABS}
        tasks={[PRED]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Nom/), { target: { value: 'X' } })
    openPicker()
    pickTask('tA')
    fireEvent.change(screen.getByLabelText(/^Début/), {
      target: { value: '2026-05-10' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Créer' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      /max des fins de prédécesseurs/,
    )
  })

  it('autorise une start_date > borne basse (décalage volontaire)', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={null}
        defaults={{
          name: 'X',
          start_date: '2026-05-15',
          end_date: '2026-05-20',
        }}
        collaborators={COLLABS}
        tasks={[PRED]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Nom/), { target: { value: 'X' } })
    openPicker()
    pickTask('tA')
    fireEvent.change(screen.getByLabelText(/^Début/), {
      target: { value: '2026-05-20' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Créer' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0].start_date).toBe('2026-05-20')
  })

  it('multi-prédécesseurs : start_date alignée sur MAX et envoyée dans predecessors[]', () => {
    const PRED2 = mkTask({
      id: 'tB',
      name: 'Pred B',
      start_date: '2026-05-10',
      end_date: '2026-05-25',
    })
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={null}
        defaults={{ name: 'Multi', start_date: '2026-05-01' }}
        collaborators={COLLABS}
        tasks={[PRED, PRED2]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Nom/), {
      target: { value: 'Multi' },
    })
    openPicker()
    pickTask('tA')
    pickTask('tB')
    // MAX(15/05, 25/05) = 25/05 ; mais le 25/05/2026 est le lundi de
    // Pentecôte (férié FR) → snap forward au mardi 26/05.
    expect(screen.getByLabelText(/^Début/)).toHaveValue('2026-05-26')
    fireEvent.click(screen.getByRole('button', { name: 'Créer' }))
    expect(onSave.mock.calls[0][0].start_date).toBe('2026-05-26')
    expect(onSave.mock.calls[0][0].predecessors).toEqual([
      { id: 'tA', lag: 0 },
      { id: 'tB', lag: 0 },
    ])
  })
})

describe('TaskEditor — kinds spécifiques', () => {
  it('RG-GANTT-0200 / RG-GANTT-0201 — jalon : fin et avancement désactivés, end_date = start_date au save', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={null}
        defaults={{
          name: 'Jalon test',
          start_date: '2026-06-01',
          end_date: '2026-06-01',
        }}
        collaborators={COLLABS}
        tasks={[]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Nom/), {
      target: { value: 'Jalon test' },
    })
    fireEvent.change(screen.getByLabelText(/Type/), {
      target: { value: 'milestone' },
    })
    // v2.0 / F4 — Pour un jalon le label end_date est juste « Fin » (pas de
    // suffixe « (calculée) », qui n'apparaît que pour kind='task'). Le champ
    // « Fin au plus tard » coexiste donc on cible exactement « Fin ».
    expect(screen.getByLabelText('Fin')).toBeDisabled()
    expect(screen.getByLabelText(/Avancement/)).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Créer' }))
    const patch = onSave.mock.calls[0][0]
    expect(patch.kind).toBe('milestone')
    expect(patch.end_date).toBe(patch.start_date)
  })

  // v2.2 / RG-U (RG-GANTT-1909) — Pour kind='phase', le champ Avancement est
  // désactivé : la valeur affichée à l'utilisateur est dérivée des fils via
  // `derivePhaseProgress` (lecture seule, calculée côté GanttChart).
  it("v2.2 / RG-U — kind='phase' : champ Avancement désactivé (lecture dérivée)", () => {
    render(
      <TaskEditor
        task={null}
        defaults={{ start_date: '2026-06-01', end_date: '2026-06-30' }}
        collaborators={[]}
        memberIds={[]}
        memberAllocations={[]}
        tasks={[]}
        onSave={() => {}}
        onClose={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Type/), {
      target: { value: 'phase' },
    })
    expect(screen.getByLabelText(/Avancement/)).toBeDisabled()
  })

  it("RG-GANTT-0302 / RG-GANTT-0303 — phase : collaborateur et prédécesseur masqués, bandeau d'aide affiché", () => {
    render(
      <TaskEditor
        task={null}
        defaults={{
          name: 'P',
          start_date: '2026-06-01',
          end_date: '2026-06-30',
        }}
        collaborators={COLLABS}
        tasks={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Type/), {
      target: { value: 'phase' },
    })
    expect(screen.queryByLabelText(/Collaborateur/)).toBeNull()
    expect(screen.queryByLabelText(/Prédécesseur/)).toBeNull()
    expect(
      // v2.1 — Le bandeau d'aide phases a été raccourci à « dates calculées
      // automatiquement depuis les enfants » pour gagner de la hauteur.
      screen.getByText(/dates calculées automatiquement/),
    ).toBeInTheDocument()
  })
})

describe('TaskEditor — couleur', () => {
  it('bouton "↺ Auto" remet la couleur sur null', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={mkTask({ color: '#ff0000' })}
        collaborators={COLLABS}
        tasks={[]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }))
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer/ }))
    expect(onSave.mock.calls[0][0].color).toBeNull()
  })
})

// =============================================================================
// v1.22 — Case « Replanifier après enregistrement »
// =============================================================================
// Vérifie que la case est cochée par défaut, visible UNIQUEMENT en mode
// édition, et qu'elle est transmise au caller via `options.replan` lors de
// l'appel à `onSave`.
// =============================================================================

describe('TaskEditor — case "Replanifier après enregistrement" (v1.22)', () => {
  it('affiche la case en mode édition, cochée par défaut', () => {
    render(
      <TaskEditor
        task={mkTask()}
        collaborators={COLLABS}
        tasks={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const checkbox = screen.getByRole('checkbox', {
      name: /Replanifier après enregistrement/,
    }) as HTMLInputElement
    expect(checkbox).toBeInTheDocument()
    expect(checkbox.checked).toBe(true)
  })

  it("ne s'affiche PAS en mode création", () => {
    render(
      <TaskEditor
        task={null}
        defaults={{ start_date: '2026-05-01' }}
        collaborators={COLLABS}
        tasks={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(
      screen.queryByRole('checkbox', {
        name: /Replanifier après enregistrement/,
      }),
    ).toBeNull()
  })

  it('transmet `replan: true` par défaut au caller', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={mkTask()}
        collaborators={COLLABS}
        tasks={[]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer/ }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][1]).toEqual({ replan: true })
  })

  it('transmet `replan: false` quand la case est décochée', () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={mkTask()}
        collaborators={COLLABS}
        tasks={[]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /Replanifier après enregistrement/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer/ }))
    expect(onSave.mock.calls[0][1]).toEqual({ replan: false })
  })

  it("ne passe PAS d'options en mode création (pas de case affichée)", () => {
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={null}
        defaults={{ start_date: '2026-05-01' }}
        collaborators={COLLABS}
        tasks={[]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Nom/), {
      target: { value: 'Nouvelle' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Créer' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][1]).toBeUndefined()
  })
})

// =============================================================================
// v1.24 — Tests dédiés aux règles métier RG-GANTT-XXXX (cf.
// docs/regles-metier.md). Chaque test cite la règle qu'il garantit.
// =============================================================================

describe('v1.24 — RG-GANTT-0400 — anti-cycle sur le picker prédécesseur', () => {
  it("un descendant de la tâche éditée est grisé (non-cliquable) dans l'arbre", () => {
    // Garantit qu'une tâche ne peut pas avoir l'un de ses descendants comme
    // prédécesseur (sinon cycle infini). En v1.22 l'arbre AFFICHE la tâche
    // mais la marque `aria-disabled="true"` (grisée + tooltip explicatif).
    const parent = mkTask({
      id: 'p',
      name: 'Parent',
      start_date: '2026-06-01',
      end_date: '2026-06-10',
    })
    const child = mkTask({
      id: 'c',
      name: 'Enfant',
      parent_id: 'p',
      start_date: '2026-06-02',
      end_date: '2026-06-05',
    })
    const grandChild = mkTask({
      id: 'gc',
      name: 'Petit-enfant',
      parent_id: 'c',
      start_date: '2026-06-03',
      end_date: '2026-06-04',
    })
    render(
      <TaskEditor
        task={parent}
        collaborators={COLLABS}
        tasks={[parent, child, grandChild]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /ajouter un prédécesseur/i }),
    )
    // Le parent (lui-même), l'enfant et le petit-enfant sont aria-disabled.
    for (const id of ['p', 'c', 'gc']) {
      const row = document.querySelector(`[data-task-id="${id}"]`)!
      expect(row.getAttribute('aria-disabled')).toBe('true')
    }
  })
})

describe('v1.24 — RG-GANTT-0305 — le picker prédécesseur grise les phases', () => {
  it("une phase est rendue dans l'arbre mais reste non-cliquable", () => {
    // Garantit la règle RG-GANTT-0305 : une phase ne peut pas servir de
    // prédécesseur à une autre tâche. En v1.22 elle apparaît dans l'arbre
    // pour donner le contexte de hiérarchie mais reste grisée.
    const phase = mkTask({
      id: 'ph1',
      name: 'PhaseA',
      kind: 'phase',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
    })
    const task = mkTask({
      id: 't_other',
      name: 'TâcheB',
      start_date: '2026-06-15',
      end_date: '2026-06-20',
    })
    render(
      <TaskEditor
        task={null}
        defaults={{ start_date: '2026-07-01' }}
        collaborators={COLLABS}
        tasks={[phase, task]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /ajouter un prédécesseur/i }),
    )
    const phaseRow = document.querySelector('[data-task-id="ph1"]')!
    const taskRow = document.querySelector('[data-task-id="t_other"]')!
    expect(phaseRow.getAttribute('aria-disabled')).toBe('true')
    expect(taskRow.getAttribute('aria-disabled')).not.toBe('true')
  })
})

describe('v1.24 — RG-GANTT-0706 — blocage saisie si start_date < SNET', () => {
  it("refuse l'enregistrement avec un message d'erreur explicite", () => {
    // L'utilisateur a tenté de placer le début 5 jours avant la contrainte
    // « Ne doit pas démarrer avant le » → le formulaire bloque.
    const onSave = vi.fn()
    render(
      <TaskEditor
        task={mkTask({
          start_date: '2026-06-10',
          end_date: '2026-06-12',
          not_before_date: '2026-06-15',
        })}
        collaborators={COLLABS}
        tasks={[]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer/ }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Ne doit pas démarrer avant le/i,
    )
  })
})

describe('v1.24 — RG-GANTT-0705 — avertissement non-bloquant si SNET non ouvré', () => {
  it('affiche un avertissement quand la date saisie tombe un week-end', () => {
    // 2026-05-16 = samedi → le système le reportera au prochain jour ouvré
    // au moment de l'enregistrement, mais on prévient l'utilisateur AVANT.
    render(
      <TaskEditor
        task={mkTask({
          start_date: '2026-05-20',
          end_date: '2026-05-20',
          not_before_date: '2026-05-16',
        })}
        collaborators={COLLABS}
        tasks={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText(/week-end ou un jour férié/i)).toBeInTheDocument()
  })

  it('n`affiche aucun avertissement quand la date tombe un jour ouvré ordinaire', () => {
    // 2026-05-19 = mardi ouvré.
    render(
      <TaskEditor
        task={mkTask({
          start_date: '2026-05-20',
          end_date: '2026-05-20',
          not_before_date: '2026-05-19',
        })}
        collaborators={COLLABS}
        tasks={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByText(/week-end ou un jour férié/i)).toBeNull()
  })
})
