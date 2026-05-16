// =============================================================================
// TESTS — fonctions utilitaires Gantt (Vitest)
// =============================================================================

import { describe, it, expect } from 'vitest'
import {
  addDaysIso,
  addWorkingDays,
  buildDateRange,
  clampDayWidth,
  dateToIso,
  dateToX,
  daysBetweenIso,
  defaultWindow,
  descendantIds,
  effectiveTaskColor,
  groupByMonth,
  groupByWeek,
  computeWorkload,
  workloadCellStyle,
  isoToDate,
  isWeekendDay,
  makeId,
  maxIso,
  mondayOnOrBefore,
  rangeToWidth,
  snapBackwardToWorkingDay,
  snapForwardToWorkingDay,
  replanTasks,
  sortTasksHierarchically,
  todayIso,
  windowFromTasks,
  workingDaysBetween,
  DEFAULT_DAY_WIDTH,
  DEFAULT_TASK_COLOR,
  MAX_DAY_WIDTH,
  MIN_DAY_WIDTH,
} from './utils'
import type { Collaborator, Task } from './types'

/** Petit helper pour fabriquer une tâche minimale dans les tests. */
function mkTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name: id,
    kind: 'task',
    start_date: '2026-01-01',
    end_date: '2026-01-02',
    progress: 0,
    collaborator_id: null,
    color: null,
    parent_id: null,
    predecessor_id: null,
    predecessor_lag: 0,
    priority: null,
    position: 0,
    project_id: 'p_test',
    ...overrides,
  }
}

describe('isoToDate / dateToIso', () => {
  it('round-trip stable', () => {
    expect(dateToIso(isoToDate('2026-05-15'))).toBe('2026-05-15')
  })
})

describe('buildDateRange', () => {
  it('génère la plage inclusive', () => {
    const r = buildDateRange('2026-05-15', '2026-05-17')
    expect(r.map(dateToIso)).toEqual(['2026-05-15', '2026-05-16', '2026-05-17'])
  })

  it('fonctionne pour 1 seul jour', () => {
    expect(buildDateRange('2026-05-15', '2026-05-15')).toHaveLength(1)
  })
})

describe('defaultWindow', () => {
  it('renvoie 4 mois alignés sur le 1er', () => {
    const w = defaultWindow('2026-05-15', 4)
    expect(w.startIso).toBe('2026-05-01')
    // 1er mai + 4 mois - 1 jour = 31 août
    expect(w.endIso).toBe('2026-08-31')
  })

  it('paramétrable sur N mois', () => {
    const w = defaultWindow('2026-01-10', 6)
    expect(w.startIso).toBe('2026-01-01')
    expect(w.endIso).toBe('2026-06-30')
  })
})

describe('dateToX / rangeToWidth', () => {
  it('positionne correctement une date', () => {
    expect(dateToX('2026-05-03', '2026-05-01', 10)).toBe(20)
  })

  it("largeur d'1 jour = dayWidth", () => {
    expect(rangeToWidth('2026-05-01', '2026-05-01', 14)).toBe(14)
  })

  it('largeur de N jours = N * dayWidth', () => {
    expect(rangeToWidth('2026-05-01', '2026-05-05', 10)).toBe(50)
  })
})

describe('clampDayWidth', () => {
  it('borne aux extrêmes', () => {
    expect(clampDayWidth(0)).toBe(MIN_DAY_WIDTH)
    expect(clampDayWidth(9999)).toBe(MAX_DAY_WIDTH)
  })

  it('NaN → défaut', () => {
    expect(clampDayWidth(NaN)).toBe(DEFAULT_DAY_WIDTH)
  })
})

describe('effectiveTaskColor', () => {
  const collabs: Collaborator[] = [
    { id: 'c1', name: 'A', color: '#ff0000', position: 0 },
  ]
  const baseTask: Task = mkTask('t1')

  it('priorité couleur custom', () => {
    expect(effectiveTaskColor({ ...baseTask, color: '#abcdef' }, collabs)).toBe(
      '#abcdef',
    )
  })

  it('sinon couleur du collab', () => {
    expect(
      effectiveTaskColor({ ...baseTask, collaborator_id: 'c1' }, collabs),
    ).toBe('#ff0000')
  })

  it('sinon défaut', () => {
    expect(effectiveTaskColor(baseTask, collabs)).toBe(DEFAULT_TASK_COLOR)
  })
})

describe('makeId', () => {
  it('génère des IDs uniques avec préfixe', () => {
    const a = makeId('t')
    const b = makeId('t')
    expect(a).toMatch(/^t_/)
    expect(a).not.toBe(b)
  })
})

describe('isWeekendDay', () => {
  it('détecte samedi et dimanche', () => {
    expect(isWeekendDay(isoToDate('2026-05-16'))).toBe(true) // samedi
    expect(isWeekendDay(isoToDate('2026-05-17'))).toBe(true) // dimanche
    expect(isWeekendDay(isoToDate('2026-05-18'))).toBe(false) // lundi
  })
})

describe('groupByMonth', () => {
  it('agrège les jours par mois', () => {
    const dates = buildDateRange('2026-05-30', '2026-06-02')
    const groups = groupByMonth(dates)
    expect(groups).toHaveLength(2)
    expect(groups[0].span).toBe(2) // 30, 31 mai
    expect(groups[1].span).toBe(2) // 1, 2 juin
  })
})

describe('computeWorkload (v1.16)', () => {
  const COLLABS: Collaborator[] = [
    { id: 'alice', name: 'Alice', color: '#3b82f6', position: 0 },
    { id: 'bob', name: 'Bob', color: '#10b981', position: 1 },
  ]

  it('ignore les jalons, phases et tâches sans collaborateur', () => {
    const dates = buildDateRange('2026-05-11', '2026-05-15') // lun → ven
    const tasks: Task[] = [
      mkTask('milestone', {
        kind: 'milestone',
        collaborator_id: 'alice',
        start_date: '2026-05-12',
        end_date: '2026-05-12',
      }),
      mkTask('phase', {
        kind: 'phase',
        collaborator_id: 'alice',
        start_date: '2026-05-11',
        end_date: '2026-05-15',
      }),
      mkTask('orphan', {
        kind: 'task',
        collaborator_id: null,
        start_date: '2026-05-11',
        end_date: '2026-05-15',
      }),
    ]
    const wl = computeWorkload(tasks, COLLABS, dates)
    expect(wl.get('alice')).toEqual([0, 0, 0, 0, 0])
    expect(wl.get('bob')).toEqual([0, 0, 0, 0, 0])
  })

  it('cumule 1 par tâche-jour ouvré et saute les week-ends', () => {
    // Tâche Alice du vendredi au lundi : 1 j vendredi, 0 sam/dim, 1 j lundi.
    const dates = buildDateRange('2026-05-15', '2026-05-18')
    const tasks: Task[] = [
      mkTask('a', {
        collaborator_id: 'alice',
        start_date: '2026-05-15',
        end_date: '2026-05-18',
      }),
    ]
    const wl = computeWorkload(tasks, COLLABS, dates)
    expect(wl.get('alice')).toEqual([1, 0, 0, 1])
  })

  it('détecte la surcharge (2 tâches sur le même jour ouvré)', () => {
    const dates = buildDateRange('2026-05-11', '2026-05-12') // lun + mar
    const tasks: Task[] = [
      mkTask('t1', {
        collaborator_id: 'alice',
        start_date: '2026-05-11',
        end_date: '2026-05-12',
      }),
      mkTask('t2', {
        collaborator_id: 'alice',
        start_date: '2026-05-11',
        end_date: '2026-05-11',
      }),
    ]
    const wl = computeWorkload(tasks, COLLABS, dates)
    expect(wl.get('alice')).toEqual([2, 1]) // lundi surchargé, mardi plein
  })
})

describe('workloadCellStyle (v1.16)', () => {
  it('mappe les charges sur les classes du code couleur', () => {
    expect(workloadCellStyle(0)).toContain('text-slate-300')
    expect(workloadCellStyle(0.25)).toContain('bg-blue-100')
    expect(workloadCellStyle(0.5)).toContain('bg-blue-200')
    expect(workloadCellStyle(0.9)).toContain('bg-blue-400')
    expect(workloadCellStyle(1)).toContain('bg-emerald-300')
    expect(workloadCellStyle(2)).toContain('bg-red-500')
  })

  // v1.17 — highlightUnderload : toutes les charges < 1 basculent au jaune
  // (sans toucher aux états plein (= 1) et surcharge (> 1)).
  it('highlightUnderload → sous-charges en jaune, sans toucher au plein/rouge', () => {
    expect(workloadCellStyle(0, true)).toContain('bg-yellow-200')
    expect(workloadCellStyle(0.5, true)).toContain('bg-yellow-400')
    expect(workloadCellStyle(0.99, true)).toContain('bg-yellow-400')
    // 1 et 2 restent inchangés malgré le flag.
    expect(workloadCellStyle(1, true)).toContain('bg-emerald-300')
    expect(workloadCellStyle(2, true)).toContain('bg-red-500')
  })
})

describe('groupByWeek', () => {
  // ISO 8601 : la semaine 20 de 2026 va du lundi 11 mai au dimanche 17 mai.
  it('regroupe une plage qui chevauche 2 semaines avec spans partiels', () => {
    const dates = buildDateRange('2026-05-15', '2026-05-19') // ven → mar
    const groups = groupByWeek(dates)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual({ label: 'S20', span: 3 }) // 15, 16, 17
    expect(groups[1]).toEqual({ label: 'S21', span: 2 }) // 18, 19
  })

  it('renvoie une seule semaine pour une plage qui ne déborde pas', () => {
    const dates = buildDateRange('2026-05-11', '2026-05-17') // semaine complète
    expect(groupByWeek(dates)).toEqual([{ label: 'S20', span: 7 }])
  })
})

describe('sortTasksHierarchically', () => {
  it('place chaque enfant juste après son parent', () => {
    const tasks: Task[] = [
      mkTask('A', { position: 0 }),
      mkTask('B', { position: 1 }),
      mkTask('A1', { position: 2, parent_id: 'A' }),
      mkTask('B1', { position: 3, parent_id: 'B' }),
      mkTask('A2', { position: 4, parent_id: 'A' }),
    ]
    const out = sortTasksHierarchically(tasks).map((t) => t.id)
    expect(out).toEqual(['A', 'A1', 'A2', 'B', 'B1'])
  })

  it('descend récursivement (petits-enfants)', () => {
    const tasks: Task[] = [
      mkTask('A'),
      mkTask('A1', { parent_id: 'A' }),
      mkTask('A1a', { parent_id: 'A1' }),
    ]
    const out = sortTasksHierarchically(tasks).map((t) => t.id)
    expect(out).toEqual(['A', 'A1', 'A1a'])
  })

  it('rattache à la racine les enfants orphelins', () => {
    const tasks: Task[] = [mkTask('orphan', { parent_id: 'inconnu' })]
    const out = sortTasksHierarchically(tasks)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('orphan')
  })

  it("respecte l'ordre `position` au sein d'un même parent", () => {
    const tasks: Task[] = [
      mkTask('A'),
      mkTask('A2', { position: 2, parent_id: 'A' }),
      mkTask('A1', { position: 1, parent_id: 'A' }),
    ]
    const out = sortTasksHierarchically(tasks).map((t) => t.id)
    expect(out).toEqual(['A', 'A1', 'A2'])
  })
})

describe('todayIso', () => {
  it('renvoie une date ISO YYYY-MM-DD valide', () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('maxIso', () => {
  it('renvoie la plus tardive', () => {
    expect(maxIso('2026-05-15', '2026-05-20')).toBe('2026-05-20')
    expect(maxIso('2026-05-20', '2026-05-15')).toBe('2026-05-20')
  })

  it('gère les chaînes vides', () => {
    expect(maxIso('', '2026-05-15')).toBe('2026-05-15')
    expect(maxIso('2026-05-15', '')).toBe('2026-05-15')
    expect(maxIso('', '')).toBe('')
  })
})

describe('mondayOnOrBefore', () => {
  it('renvoie le lundi pour un mardi (recul de 1 j)', () => {
    // 2026-05-12 est un mardi → lundi de la même semaine = 2026-05-11
    expect(mondayOnOrBefore('2026-05-12')).toBe('2026-05-11')
  })

  it('un lundi reste inchangé', () => {
    expect(mondayOnOrBefore('2026-05-11')).toBe('2026-05-11')
  })

  it('un dimanche recule au lundi de la semaine en cours', () => {
    // 2026-05-17 est un dimanche → lundi 2026-05-11 (semaine ISO)
    expect(mondayOnOrBefore('2026-05-17')).toBe('2026-05-11')
  })
})

describe('windowFromTasks', () => {
  it('démarre au lundi de la tâche la plus précoce', () => {
    const tasks = [
      { start_date: '2026-05-15' }, // vendredi
      { start_date: '2026-05-20' },
      { start_date: '2026-05-12' }, // mardi → la plus précoce
      { start_date: '2026-06-01' },
    ]
    const w = windowFromTasks(tasks, 4)
    expect(w.startIso).toBe('2026-05-11') // lundi de la semaine du 2026-05-12
    // start + 4 mois - 1 jour
    expect(w.endIso).toBe('2026-09-10')
  })

  it("liste vide → retombe sur defaultWindow autour d'aujourd'hui", () => {
    const w = windowFromTasks([], 4)
    expect(w.startIso).toMatch(/^\d{4}-\d{2}-01$/)
    expect(w.endIso).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('paramétrable sur N mois', () => {
    const w = windowFromTasks([{ start_date: '2026-05-12' }], 6)
    expect(w.startIso).toBe('2026-05-11')
    expect(w.endIso).toBe('2026-11-10')
  })
})

describe('addWorkingDays (v1.9)', () => {
  // Repère : 2026-05-18 est un LUNDI ; 2026-05-22 vendredi ; 23/24 = w-e.
  it('charge=1 → fin = début (1 seul jour ouvré)', () => {
    expect(addWorkingDays('2026-05-18', 1)).toBe('2026-05-18')
  })

  it('charge=3 lundi → fin mercredi (exemple de la spec)', () => {
    expect(addWorkingDays('2026-05-18', 3)).toBe('2026-05-20')
  })

  it('charge=5 lundi → fin vendredi de la même semaine', () => {
    expect(addWorkingDays('2026-05-18', 5)).toBe('2026-05-22')
  })

  it('charge=6 lundi → fin lundi suivant (saute samedi/dimanche)', () => {
    expect(addWorkingDays('2026-05-18', 6)).toBe('2026-05-25')
  })

  it('charge=10 lundi → fin vendredi de la semaine suivante', () => {
    expect(addWorkingDays('2026-05-18', 10)).toBe('2026-05-29')
  })

  it('charge ≤ 0 → renvoie la date de début (clamp à 1 jour)', () => {
    expect(addWorkingDays('2026-05-18', 0)).toBe('2026-05-18')
  })

  it('démarrage un samedi : décompte commence au lundi suivant', () => {
    // 2026-05-16 = samedi, donc charge=3 → samedi (compte 0) + lundi(1) + mardi(2) + mercredi(3)
    expect(addWorkingDays('2026-05-16', 3)).toBe('2026-05-20')
  })
})

describe('workingDaysBetween (v1.9)', () => {
  it('exemple direct lundi → mercredi = 3 jours ouvrés', () => {
    expect(workingDaysBetween('2026-05-18', '2026-05-20')).toBe(3)
  })

  it('semaine pleine lundi → dimanche = 5 jours ouvrés', () => {
    expect(workingDaysBetween('2026-05-18', '2026-05-24')).toBe(5)
  })

  it('même jour ouvré = 1', () => {
    expect(workingDaysBetween('2026-05-18', '2026-05-18')).toBe(1)
  })

  it('même jour week-end = 0', () => {
    expect(workingDaysBetween('2026-05-23', '2026-05-23')).toBe(0)
  })

  it('intervalle inverse → 0', () => {
    expect(workingDaysBetween('2026-05-20', '2026-05-18')).toBe(0)
  })

  it('round-trip avec addWorkingDays : workingDaysBetween(s, addWorkingDays(s,n)) = n', () => {
    for (const n of [1, 2, 3, 5, 7, 12]) {
      const end = addWorkingDays('2026-05-18', n)
      expect(workingDaysBetween('2026-05-18', end)).toBe(n)
    }
  })
})

describe('addDaysIso (v1.9)', () => {
  it('avance de 3 jours calendaires', () => {
    expect(addDaysIso('2026-05-18', 3)).toBe('2026-05-21')
  })

  it('recule avec valeur négative', () => {
    expect(addDaysIso('2026-05-18', -3)).toBe('2026-05-15')
  })

  it('traverse le changement de mois', () => {
    expect(addDaysIso('2026-05-30', 5)).toBe('2026-06-04')
  })
})

describe('snapBackwardToWorkingDay (v1.9)', () => {
  it('jour ouvré inchangé', () => {
    expect(snapBackwardToWorkingDay('2026-05-18')).toBe('2026-05-18') // lundi
    expect(snapBackwardToWorkingDay('2026-05-22')).toBe('2026-05-22') // vendredi
  })

  it('samedi → vendredi précédent', () => {
    expect(snapBackwardToWorkingDay('2026-05-23')).toBe('2026-05-22')
  })

  it('dimanche → vendredi précédent', () => {
    expect(snapBackwardToWorkingDay('2026-05-24')).toBe('2026-05-22')
  })
})

describe('daysBetweenIso (v1.9)', () => {
  it('intervalle positif', () => {
    expect(daysBetweenIso('2026-05-18', '2026-05-20')).toBe(2)
  })

  it('intervalle négatif', () => {
    expect(daysBetweenIso('2026-05-20', '2026-05-18')).toBe(-2)
  })

  it('même jour = 0', () => {
    expect(daysBetweenIso('2026-05-18', '2026-05-18')).toBe(0)
  })
})

describe('snapForwardToWorkingDay (v1.9)', () => {
  it('jour ouvré inchangé', () => {
    expect(snapForwardToWorkingDay('2026-05-18')).toBe('2026-05-18') // lundi
    expect(snapForwardToWorkingDay('2026-05-22')).toBe('2026-05-22') // vendredi
  })

  it('samedi → lundi suivant', () => {
    expect(snapForwardToWorkingDay('2026-05-23')).toBe('2026-05-25')
  })

  it('dimanche → lundi suivant', () => {
    expect(snapForwardToWorkingDay('2026-05-24')).toBe('2026-05-25')
  })
})

describe('descendantIds', () => {
  it('renvoie tous les descendants (récursif)', () => {
    const tasks: Task[] = [
      mkTask('A'),
      mkTask('A1', { parent_id: 'A' }),
      mkTask('A1a', { parent_id: 'A1' }),
      mkTask('B'),
    ]
    const ids = [...descendantIds('A', tasks)]
    expect(ids.sort()).toEqual(['A1', 'A1a'])
  })

  it('set vide pour une feuille', () => {
    const tasks: Task[] = [mkTask('A')]
    expect(descendantIds('A', tasks).size).toBe(0)
  })
})

// =============================================================================
// REPLAN (v1.18)
// =============================================================================

describe('replanTasks (v1.18)', () => {
  it('aucun déplacement si aucune surcharge', () => {
    const tasks: Task[] = [
      mkTask('A', {
        collaborator_id: 'c1',
        start_date: '2026-05-18', // lundi
        end_date: '2026-05-22', // vendredi (5 j ouvrés)
      }),
      mkTask('B', {
        collaborator_id: 'c1',
        start_date: '2026-05-25',
        end_date: '2026-05-29',
      }),
    ]
    expect(replanTasks(tasks)).toEqual([])
  })

  it('pousse la 2e tâche après la 1re quand elles se chevauchent pour le même collab', () => {
    // Scénario du brief : Alice est en surcharge 25→29 mai ; la 2e tâche
    // (« Définir le message » 25 mai → 5 juin) doit être décalée pour
    // démarrer dès qu'Alice est libre, soit le 1er juin.
    const tasks: Task[] = [
      mkTask('A', {
        // « Recherche audience » : seule tâche prioritaire (haut de liste).
        collaborator_id: 'c1',
        start_date: '2026-05-15', // ven 15 mai
        end_date: '2026-05-29', // ven 29 mai (11 j ouvrés)
      }),
      mkTask('B', {
        // « Définir le message » : démarre alors qu'A occupe encore Alice.
        collaborator_id: 'c1',
        start_date: '2026-05-25', // lun 25 mai
        end_date: '2026-06-05', // ven 5 juin (10 j ouvrés)
      }),
    ]
    const moves = replanTasks(tasks)
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({
      id: 'B',
      newStart: '2026-06-01', // lundi suivant la fin de A (ven 29 → lun 1er)
    })
    // La charge (jours ouvrés) est préservée : 10 j → 1er juin → ven 12 juin.
    expect(workingDaysBetween(moves[0].newStart, moves[0].newEnd)).toBe(10)
  })

  it('la priorité 1 gagne sur une tâche sans priorité (top-of-list ignoré)', () => {
    // B est plus bas dans la liste mais a priorité 1 → B garde sa place,
    // A (sans priorité) est décalée.
    const tasks: Task[] = [
      mkTask('A', {
        collaborator_id: 'c1',
        start_date: '2026-05-18',
        end_date: '2026-05-22',
      }),
      mkTask('B', {
        collaborator_id: 'c1',
        start_date: '2026-05-18',
        end_date: '2026-05-20', // chevauche A
        priority: 1,
      }),
    ]
    const moves = replanTasks(tasks)
    expect(moves.map((m) => m.id)).toEqual(['A'])
    // A part au lundi suivant la fin de B (mer 20 → jeu 21 = jour ouvré).
    expect(moves[0].newStart).toBe('2026-05-21')
  })

  it('tie-break sur la position dans la liste (top wins)', () => {
    // Aucune priorité saisie, pas de lien : la 1re de la liste gagne.
    const tasks: Task[] = [
      mkTask('TOP', {
        collaborator_id: 'c1',
        start_date: '2026-05-18',
        end_date: '2026-05-22',
      }),
      mkTask('BOTTOM', {
        collaborator_id: 'c1',
        start_date: '2026-05-18',
        end_date: '2026-05-20',
      }),
    ]
    const moves = replanTasks(tasks)
    expect(moves.map((m) => m.id)).toEqual(['BOTTOM'])
  })

  it('le prédécesseur est prioritaire sur le successeur même si moins prioritaire en numérique', () => {
    // A prédécesseur de B. A n'a pas de priorité, B a priorité 1. La topo
    // impose A d'abord ; B est traité après et adapte ses dates.
    const tasks: Task[] = [
      mkTask('A', {
        collaborator_id: 'c1',
        start_date: '2026-05-18',
        end_date: '2026-05-22', // ven 22 mai
      }),
      mkTask('B', {
        collaborator_id: 'c1',
        start_date: '2026-05-18',
        end_date: '2026-05-20',
        predecessor_id: 'A',
        priority: 1,
      }),
    ]
    const moves = replanTasks(tasks)
    // A reste sur place ; B démarre dès la fin de A (lun 25 mai).
    expect(moves.map((m) => m.id)).toEqual(['B'])
    expect(moves[0].newStart).toBe('2026-05-25')
  })

  it('ne touche pas aux tâches de collabs différents', () => {
    const tasks: Task[] = [
      mkTask('A', {
        collaborator_id: 'c1',
        start_date: '2026-05-18',
        end_date: '2026-05-22',
      }),
      mkTask('B', {
        collaborator_id: 'c2',
        start_date: '2026-05-18',
        end_date: '2026-05-22',
      }),
    ]
    expect(replanTasks(tasks)).toEqual([])
  })

  it('ignore les jalons et les phases', () => {
    const tasks: Task[] = [
      mkTask('phase', {
        kind: 'phase',
        start_date: '2026-05-18',
        end_date: '2026-05-29',
      }),
      mkTask('jalon', {
        kind: 'milestone',
        collaborator_id: 'c1',
        start_date: '2026-05-22',
        end_date: '2026-05-22',
      }),
      mkTask('A', {
        collaborator_id: 'c1',
        start_date: '2026-05-18',
        end_date: '2026-05-22',
      }),
    ]
    // Aucune surcharge sur tâche réelle → aucun déplacement.
    expect(replanTasks(tasks)).toEqual([])
  })
})
