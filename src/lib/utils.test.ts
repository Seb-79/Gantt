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
  isoToDate,
  isWeekendDay,
  makeId,
  maxIso,
  mondayOnOrBefore,
  rangeToWidth,
  snapBackwardToWorkingDay,
  snapForwardToWorkingDay,
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
