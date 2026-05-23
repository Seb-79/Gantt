// =============================================================================
// TESTS — fonctions utilitaires Gantt (Vitest)
// =============================================================================

import { describe, it, expect } from 'vitest'
import {
  addDaysIso,
  addWorkingDays,
  buildDateRange,
  computeAllocationShortfall,
  computeExtensionPlan,
  computeEndFromCharge,
  rebuildAllocationsForCollab,
  scanReplanShortfalls,
  checkCoherence,
  clampDayWidth,
  concernedTaskIds,
  dateToIso,
  dateToX,
  daysBetweenIso,
  defaultWindow,
  descendantIds,
  effectiveTaskColor,
  filterCollapsed,
  groupByMonth,
  groupByWeek,
  computeWorkload,
  getTotalCapacity,
  workloadCellStyle,
  workloadCellStyleNormalized,
  isFrenchHoliday,
  isNonWorkingDay,
  isoToDate,
  isWeekendDay,
  computeSuccessorStart,
  computeMaxStartFromPredecessors,
  flattenTaskTree,
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
import { mkTask as mkTaskBase } from '../test/fixtures'

/**
 * Wrapper local autour de la fixture partagée `mkTaskBase` pour conserver
 * la signature positionnelle historique `mkTask(id, overrides?)` utilisée
 * par ~100 cas de ce fichier.
 *
 * Spécificités de ce fichier de tests (vs la fixture par défaut) :
 *   • `name = id` (les assertions ciblent le libellé par l'id).
 *   • Fenêtre par défaut [2026-01-01, 2026-01-02] : on commence l'année,
 *     fenêtre courte → idéal pour exercer les calculs d'extension.
 */
function mkTask(id: string, overrides: Partial<Task> = {}): Task {
  return mkTaskBase({
    id,
    name: id,
    start_date: '2026-01-01',
    end_date: '2026-01-02',
    ...overrides,
  })
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
    // v1.23 — Semaine du 08/06/2026 (sans jour férié) pour rester sur la
    // démonstration pure « saute samedi/dimanche » (le 25/05 = Pentecôte
    // perturbait la version originale du test).
    expect(addWorkingDays('2026-06-08', 6)).toBe('2026-06-15')
  })

  it('charge=10 lundi → fin vendredi de la semaine suivante', () => {
    // v1.23 — Idem, sur la semaine du 08/06/2026.
    expect(addWorkingDays('2026-06-08', 10)).toBe('2026-06-19')
  })

  it('charge ≤ 0 → renvoie la date de début (clamp à 1 jour)', () => {
    expect(addWorkingDays('2026-05-18', 0)).toBe('2026-05-18')
  })

  it('démarrage un samedi : décompte commence au lundi suivant', () => {
    // 2026-05-16 = samedi, donc charge=3 → samedi (compte 0) + lundi(1) + mardi(2) + mercredi(3)
    expect(addWorkingDays('2026-05-16', 3)).toBe('2026-05-20')
  })
})

// v2.0 — RG-GANTT-0100 : `computeEndFromCharge` est le wrapper sémantique
// utilisé partout où on dérive la date de fin depuis la charge (source de
// vérité). En F0 le calcul est identique à `addWorkingDays` ; les tests
// servent de filet pour les évolutions F2 (allocations) et F3 (congés)
// qui changeront l'algo SANS toucher au contrat.
describe('computeEndFromCharge (v2.0)', () => {
  it('alias d`addWorkingDays en F0 : charge=5 lundi → vendredi', () => {
    expect(computeEndFromCharge('2026-05-18', 5)).toBe('2026-05-22')
  })

  it('saute les fériés FR : jeudi 30/04 + 3 → mardi 5/05 (1er mai férié)', () => {
    expect(computeEndFromCharge('2026-04-30', 3)).toBe('2026-05-05')
  })

  it('charge=1 → fin = début (convention 1 jour de présence)', () => {
    expect(computeEndFromCharge('2026-05-18', 1)).toBe('2026-05-18')
  })

  // v2.0 / F2 — Alloc 100 % : équivalent à F0 (1 j-personne par jour ouvré).
  it('v2.0 / RG-GANTT-1310 — alloc 100 % sur toute la période : fin identique à F0', () => {
    const allocations = [
      {
        id: 'a1',
        project_id: 'pA',
        collaborator_id: 'c1',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        allocation_pct: 100,
      },
    ]
    expect(
      computeEndFromCharge('2026-06-08', 5, {
        projectId: 'pA',
        collaboratorId: 'c1',
        allocations,
      }),
    ).toBe('2026-06-12') // 5 jours ouvrés depuis lundi 08/06
  })

  // v2.0 / F2 — Alloc 50 % : il faut 2× plus de jours pour consommer la charge.
  // Charge 5 j @ 50 % :
  //   J1 08/06 → 0.5, J2 09 → 1.0, J3 10 → 1.5, J4 11 → 2.0, J5 12 → 2.5,
  //   J6 15 → 3.0, J7 16 → 3.5, J8 17 → 4.0, J9 18 → 4.5, J10 19 → 5.0
  // → fin = 19/06 (vendredi semaine suivante).
  it('v2.0 / RG-GANTT-1310 — alloc 50 % : charge 5 j → 10 jours ouvrés', () => {
    const allocations = [
      {
        id: 'a1',
        project_id: 'pA',
        collaborator_id: 'c1',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        allocation_pct: 50,
      },
    ]
    expect(
      computeEndFromCharge('2026-06-08', 5, {
        projectId: 'pA',
        collaboratorId: 'c1',
        allocations,
      }),
    ).toBe('2026-06-19')
  })

  // v2.0 / F2 — Sans collab affecté : pas de pondération, fallback F0.
  it('v2.0 / RG-GANTT-1311 — ctx sans collab : fallback F0', () => {
    expect(
      computeEndFromCharge('2026-06-08', 5, {
        projectId: 'pA',
        collaboratorId: null,
        allocations: [],
      }),
    ).toBe('2026-06-12')
  })

  // v2.0 / F3 — Absence d'une journée complète + alloc 100 % : capacité 0
  // ce jour-là, la tâche est décalée d'un jour.
  // Charge 3 j, alloc 100 %, congé complet le mardi 09/06 :
  //   J1 lun 08/06 → 1.0 (cumul 1.0)
  //   J2 mar 09/06 → 0 (congé) — sauté
  //   J3 mer 10/06 → 1.0 (cumul 2.0)
  //   J4 jeu 11/06 → 1.0 (cumul 3.0) → fin = 11/06
  it('v2.0 / RG-GANTT-1402 — congé 1 j décale d`un jour la fin (alloc 100 %)', () => {
    const allocations = [
      {
        id: 'a1',
        project_id: 'pA',
        collaborator_id: 'c1',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        allocation_pct: 100,
      },
    ]
    const absences = [
      { collaborator_id: 'c1', date: '2026-06-09', fraction: 1 },
    ]
    expect(
      computeEndFromCharge('2026-06-08', 3, {
        projectId: 'pA',
        collaboratorId: 'c1',
        allocations,
        absences,
      }),
    ).toBe('2026-06-11')
  })

  // v2.0 / F3 — Multiplicatif : alloc 50 % + congé 0,5 j → capacité 25 %
  // le jour concerné (pas 0 et pas 50 %).
  it('v2.0 / RG-GANTT-1402 — alloc 50 % + congé 0,5 j = 25 % effectif', () => {
    const allocations = [
      {
        id: 'a1',
        project_id: 'pA',
        collaborator_id: 'c1',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        allocation_pct: 50,
      },
    ]
    const absences = [
      { collaborator_id: 'c1', date: '2026-06-08', fraction: 0.5 },
    ]
    // Cumul jour par jour pour charge 1 :
    //   08/06 → 0.5 × 0.5 = 0.25 (cumul 0.25)
    //   09/06 → 0.5            (cumul 0.75)
    //   10/06 → 0.5            (cumul 1.25) → atteint → fin = 10/06
    expect(
      computeEndFromCharge('2026-06-08', 1, {
        projectId: 'pA',
        collaboratorId: 'c1',
        allocations,
        absences,
      }),
    ).toBe('2026-06-10')
  })

  // v2.0 / F3 — Absences d'un AUTRE collab ne décalent pas la tâche.
  it('v2.0 / RG-GANTT-1402 — absence d`un autre collab : aucun effet', () => {
    const allocations = [
      {
        id: 'a1',
        project_id: 'pA',
        collaborator_id: 'c1',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        allocation_pct: 100,
      },
    ]
    const absences = [
      // Absence sur c2 (qui n'est pas affecté à la tâche).
      { collaborator_id: 'c2', date: '2026-06-09', fraction: 1 },
    ]
    expect(
      computeEndFromCharge('2026-06-08', 5, {
        projectId: 'pA',
        collaboratorId: 'c1',
        allocations,
        absences,
      }),
    ).toBe('2026-06-12') // inchangé (5 jours ouvrés depuis lundi)
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
    // v1.23 — Le 25/05/2026 est désormais férié (Lundi de Pentecôte), donc
    // on utilise la semaine du 13/06/2026 pour tester le saut « propre ».
    expect(snapForwardToWorkingDay('2026-06-13')).toBe('2026-06-15')
  })

  it('dimanche → lundi suivant', () => {
    expect(snapForwardToWorkingDay('2026-06-14')).toBe('2026-06-15')
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
// FILTER COLLAPSED (v1.20)
// =============================================================================

describe('filterCollapsed (v1.20)', () => {
  it('renvoie la liste inchangée si aucune phase repliée', () => {
    const tasks: Task[] = [
      mkTask('p1', { kind: 'phase' }),
      mkTask('t1', { parent_id: 'p1' }),
    ]
    expect(filterCollapsed(tasks, new Set())).toEqual(tasks)
  })

  it("masque les enfants directs d'une phase repliée", () => {
    // Règle clé : la phase elle-même reste visible (l\'utilisateur doit
    // pouvoir la déplier), mais ses enfants disparaissent du rendu.
    const tasks: Task[] = [
      mkTask('p1', { kind: 'phase' }),
      mkTask('t1', { parent_id: 'p1' }),
      mkTask('t2', { parent_id: 'p1' }),
      mkTask('other'),
    ]
    const visible = filterCollapsed(tasks, new Set(['p1']))
    expect(visible.map((t) => t.id)).toEqual(['p1', 'other'])
  })

  it('masque les petits-enfants (récursif)', () => {
    const tasks: Task[] = [
      mkTask('p1', { kind: 'phase' }),
      mkTask('p1a', { kind: 'phase', parent_id: 'p1' }),
      mkTask('t1', { parent_id: 'p1a' }),
    ]
    const visible = filterCollapsed(tasks, new Set(['p1']))
    // Phase repliée → on ne voit ni la sous-phase ni la tâche.
    expect(visible.map((t) => t.id)).toEqual(['p1'])
  })

  it('plusieurs phases repliées simultanément', () => {
    const tasks: Task[] = [
      mkTask('pA', { kind: 'phase' }),
      mkTask('tA1', { parent_id: 'pA' }),
      mkTask('pB', { kind: 'phase' }),
      mkTask('tB1', { parent_id: 'pB' }),
      mkTask('orphan'),
    ]
    const visible = filterCollapsed(tasks, new Set(['pA', 'pB']))
    expect(visible.map((t) => t.id)).toEqual(['pA', 'pB', 'orphan'])
  })

  it('un id inconnu dans le Set est ignoré silencieusement', () => {
    // Robustesse : une phase supprimée mais dont l\'id reste en localStorage
    // ne doit pas casser le rendu.
    const tasks: Task[] = [mkTask('p1', { kind: 'phase' }), mkTask('t1')]
    const visible = filterCollapsed(tasks, new Set(['p1', 'ghost-id']))
    expect(visible.map((t) => t.id)).toEqual(['p1', 't1'])
  })
})

// =============================================================================
// REPLAN (v1.18)
// =============================================================================

describe('replanTasks (v1.18)', () => {
  it('aucun déplacement si aucune surcharge', () => {
    // v1.23 — Scénario shifté sur la semaine du 08/06/2026 pour éviter le
    // Lundi de Pentecôte (25/05/2026) qui rend le test fragile.
    const tasks: Task[] = [
      mkTask('A', {
        collaborator_id: 'c1',
        start_date: '2026-06-08', // lundi
        end_date: '2026-06-12', // vendredi (5 j ouvrés)
      }),
      mkTask('B', {
        collaborator_id: 'c1',
        start_date: '2026-06-15',
        end_date: '2026-06-19',
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
    // v1.23 — 25/05/2026 = Lundi de Pentecôte (férié) → la charge initiale
    // de B (du 25 mai au 5 juin) ne contient plus que 9 jours ouvrés au lieu
    // de 10. Le replan préserve cette charge effective.
    expect(workingDaysBetween(moves[0].newStart, moves[0].newEnd)).toBe(9)
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
    // v1.23 — A reste sur place ; B démarre dès la fin de A en sautant les
    // jours non ouvrés : lun 25/05 est désormais férié (Pentecôte), donc B
    // démarre le mardi 26/05.
    expect(moves.map((m) => m.id)).toEqual(['B'])
    expect(moves[0].newStart).toBe('2026-05-26')
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

// =============================================================================
// v1.21 — Tests de cohérence et de replan partiel
// =============================================================================
// Encodent les RÈGLES MÉTIER ajoutées avec la possibilité de déplacer une
// tâche dans le passé (drag bidirectionnel). Chaque test isole une règle
// pour parler de lui-même au prochain mainteneur en cas de régression.
// =============================================================================

describe('checkCoherence — détection des incohérences', () => {
  it('aucune incohérence sur un planning sain → liste vide', () => {
    const tasks: Task[] = [
      mkTask('A', {
        collaborator_id: 'c1',
        start_date: '2026-05-18',
        end_date: '2026-05-22',
      }),
      mkTask('B', {
        collaborator_id: 'c1',
        start_date: '2026-05-25',
        end_date: '2026-05-29',
      }),
    ]
    expect(checkCoherence(tasks)).toEqual([])
  })

  it('détecte une SURCHARGE entre 2 tâches du même collaborateur', () => {
    const tasks: Task[] = [
      mkTask('A', {
        name: 'Audience',
        collaborator_id: 'c1',
        start_date: '2026-05-15',
        end_date: '2026-05-29',
      }),
      mkTask('B', {
        name: 'Message',
        collaborator_id: 'c1',
        start_date: '2026-05-25',
        end_date: '2026-06-05',
      }),
    ]
    const issues = checkCoherence(tasks)
    expect(issues).toHaveLength(1)
    expect(issues[0].kind).toBe('overload')
    expect(issues[0].severity).toBe('error')
    expect(issues[0].taskIds.sort()).toEqual(['A', 'B'])
    expect(issues[0].message).toMatch(/Audience.*Message|Message.*Audience/)
  })

  it('ne signale PAS deux tâches qui se touchent sans se chevaucher', () => {
    // A = lun→ven, B = lundi suivant : pas de chevauchement.
    const tasks: Task[] = [
      mkTask('A', {
        collaborator_id: 'c1',
        start_date: '2026-05-18',
        end_date: '2026-05-22',
      }),
      mkTask('B', {
        collaborator_id: 'c1',
        start_date: '2026-05-25',
        end_date: '2026-05-29',
      }),
    ]
    expect(checkCoherence(tasks)).toEqual([])
  })

  it('ne signale pas une surcharge entre collabs différents', () => {
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
    expect(checkCoherence(tasks)).toEqual([])
  })

  it('détecte une violation de PRÉDÉCESSEUR (Y avant fin X)', () => {
    const tasks: Task[] = [
      mkTask('X', {
        start_date: '2026-05-18',
        end_date: '2026-05-22',
      }),
      mkTask('Y', {
        predecessor_id: 'X',
        start_date: '2026-05-15', // commence AVANT la fin de X
        end_date: '2026-05-19',
      }),
    ]
    const issues = checkCoherence(tasks)
    const pred = issues.find((i) => i.kind === 'predecessor')
    expect(pred).toBeDefined()
    expect(pred?.severity).toBe('error')
    expect(pred?.taskIds[0]).toBe('Y')
    expect(pred?.taskIds[1]).toBe('X')
  })

  it('détecte une violation de PRIORITÉ (faible avant haute, même collab)', () => {
    const tasks: Task[] = [
      mkTask('Important', {
        collaborator_id: 'c1',
        priority: 1,
        start_date: '2026-05-25',
        end_date: '2026-05-29',
      }),
      mkTask('Secondaire', {
        collaborator_id: 'c1',
        priority: 3,
        start_date: '2026-05-18', // commence AVANT « Important » alors que moins prio
        end_date: '2026-05-22',
      }),
    ]
    const issues = checkCoherence(tasks)
    expect(issues).toHaveLength(1)
    expect(issues[0].kind).toBe('priority')
    expect(issues[0].severity).toBe('warning')
  })

  it("n'inflige pas de faux positif quand une seule tâche a une priorité", () => {
    const tasks: Task[] = [
      mkTask('A', {
        collaborator_id: 'c1',
        priority: 1,
        start_date: '2026-05-25',
        end_date: '2026-05-29',
      }),
      mkTask('B', {
        collaborator_id: 'c1',
        priority: null,
        not_before_date: null,
        start_date: '2026-05-18',
        end_date: '2026-05-22',
      }),
    ]
    expect(checkCoherence(tasks)).toEqual([])
  })

  it('agrège plusieurs incohérences dans le même appel', () => {
    const tasks: Task[] = [
      mkTask('A', {
        name: 'A',
        collaborator_id: 'c1',
        start_date: '2026-05-18',
        end_date: '2026-05-25',
      }),
      mkTask('B', {
        name: 'B',
        collaborator_id: 'c1',
        start_date: '2026-05-22',
        end_date: '2026-05-29',
      }),
      mkTask('X', {
        start_date: '2026-06-01',
        end_date: '2026-06-05',
      }),
      mkTask('Y', {
        predecessor_id: 'X',
        start_date: '2026-05-29',
        end_date: '2026-06-01',
      }),
    ]
    const issues = checkCoherence(tasks)
    expect(issues.some((i) => i.kind === 'overload')).toBe(true)
    expect(issues.some((i) => i.kind === 'predecessor')).toBe(true)
  })
})

// =============================================================================
// v1.23 — Jours fériés français + sémantique « lag = délai minimum »
// =============================================================================

describe('isFrenchHoliday (v1.23)', () => {
  it('Fête nationale fixe : 14/07 chaque année', () => {
    expect(isFrenchHoliday(isoToDate('2026-07-14'))).toBe(true)
    expect(isFrenchHoliday(isoToDate('2027-07-14'))).toBe(true)
    expect(isFrenchHoliday(isoToDate('2030-07-14'))).toBe(true)
  })

  it('jours fixes connus : Fête du Travail, Noël, Toussaint', () => {
    expect(isFrenchHoliday(isoToDate('2026-05-01'))).toBe(true)
    expect(isFrenchHoliday(isoToDate('2026-12-25'))).toBe(true)
    expect(isFrenchHoliday(isoToDate('2026-11-01'))).toBe(true)
  })

  it('jours mobiles 2026 : Lundi de Pâques (06/04), Ascension (14/05), Pentecôte (25/05)', () => {
    expect(isFrenchHoliday(isoToDate('2026-04-06'))).toBe(true) // Lundi de Pâques
    expect(isFrenchHoliday(isoToDate('2026-05-14'))).toBe(true) // Ascension
    expect(isFrenchHoliday(isoToDate('2026-05-25'))).toBe(true) // Lundi de Pentecôte
  })

  it("calcul algorithmique au-delà de 2026 : Lundi de Pâques varie d'une année à l'autre", () => {
    // Cas connus historiquement (Wikipedia / éphémérides) :
    //   2027 : Pâques 28 mars → Lundi 29 mars
    //   2024 : Pâques 31 mars → Lundi 1er avril
    expect(isFrenchHoliday(isoToDate('2027-03-29'))).toBe(true)
    expect(isFrenchHoliday(isoToDate('2024-04-01'))).toBe(true)
  })

  it('un jour ordinaire (mar 07/07/2026) → false', () => {
    expect(isFrenchHoliday(isoToDate('2026-07-07'))).toBe(false)
  })
})

describe('isNonWorkingDay (v1.23) — week-end OU férié', () => {
  it('samedi → true', () => {
    expect(isNonWorkingDay(isoToDate('2026-06-13'))).toBe(true)
  })

  it('jour férié en semaine → true (14/07/2026 = mardi férié)', () => {
    expect(isNonWorkingDay(isoToDate('2026-07-14'))).toBe(true)
  })

  it('jour ouvré ordinaire → false', () => {
    expect(isNonWorkingDay(isoToDate('2026-07-15'))).toBe(false)
  })
})

describe('computeSuccessorStart (v1.23) — délai = minimum + saute fériés', () => {
  it('scénario du bug v1.22 : pred=ven 03/07, lag=6 ⇒ start = mer 15/07 (saute 14/07 férié)', () => {
    // Référence exacte du brief utilisateur :
    //   • Storyboard finit le ven 03/07/2026
    //   • Test délai a un délai de 6 jours ouvrés
    //   • 14/07 = Fête nationale → non ouvré → start = mer 15/07
    expect(computeSuccessorStart('2026-07-03', 6)).toBe('2026-07-15')
  })

  it('lag=0 → start = base (= pred.end snappé sur jour ouvré)', () => {
    expect(computeSuccessorStart('2026-06-12', 0)).toBe('2026-06-12') // ven
  })

  it('lag=1 → 1 jour ouvré strictement entre pred.end et start', () => {
    // ven 12/06 → lag=1 → start = mar 16/06 (entre : lun 15/06 = 1 j ouvré)
    expect(computeSuccessorStart('2026-06-12', 1)).toBe('2026-06-16')
  })

  it('inverse : start saisie par utilisateur, lag inféré reste cohérent', () => {
    // Si l'utilisateur saisit start = 15/07, le serveur doit retrouver
    // lag=6 (= jours ouvrés strictement entre 03/07 et 15/07, en sautant
    // 14/07 férié). Couvert par `workingDaysBetween - 2` côté serveur.
    expect(workingDaysBetween('2026-07-03', '2026-07-15')).toBe(8)
    // 8 - 2 = 6 ✓
  })
})

describe('addWorkingDays / workingDaysBetween (v1.23) — sautent les fériés', () => {
  it('addWorkingDays saute 14/07/2026 (Fête nationale)', () => {
    // Du lundi 13/07 (1 j ouvré), 14/07 férié sauté, mer 15/07 = 2.
    expect(addWorkingDays('2026-07-13', 2)).toBe('2026-07-15')
  })

  it('workingDaysBetween ignore les fériés (semaine du 14/07)', () => {
    // Lun-Ven 13→17 juillet 2026 : 13 (lun), 14 (FÉRIÉ), 15, 16, 17 = 4 j ouvrés.
    expect(workingDaysBetween('2026-07-13', '2026-07-17')).toBe(4)
  })

  it('round-trip avec fériés : workingDaysBetween(s, addWorkingDays(s, n)) = n', () => {
    // Vérifie la cohérence des deux helpers en présence de fériés.
    const start = '2026-07-13' // lundi, semaine du 14/07
    for (const n of [1, 2, 3, 5, 7]) {
      const end = addWorkingDays(start, n)
      expect(workingDaysBetween(start, end)).toBe(n)
    }
  })
})

describe('replanTasks — variante PARTIELLE (concernedIds)', () => {
  it('replan complet sans `concernedIds` : comportement v1.18 inchangé', () => {
    // Référence : surcharge identique au scénario du brief Replan v1.18.
    const tasks: Task[] = [
      mkTask('t1a', {
        name: 'Recherche audience',
        collaborator_id: 'c1',
        start_date: '2026-05-15',
        end_date: '2026-05-29',
      }),
      mkTask('t1b', {
        name: 'Définir le message',
        collaborator_id: 'c1',
        start_date: '2026-05-25',
        end_date: '2026-06-05',
      }),
    ]
    const moves = replanTasks(tasks)
    expect(moves.map((m) => m.id)).toEqual(['t1b'])
    expect(moves[0].newStart).toBe('2026-06-01')
  })

  it('`concernedIds` vide ⇒ aucun déplacement (toutes les tâches lockées)', () => {
    const tasks: Task[] = [
      mkTask('A', {
        collaborator_id: 'c1',
        start_date: '2026-05-15',
        end_date: '2026-05-29',
      }),
      mkTask('B', {
        collaborator_id: 'c1',
        start_date: '2026-05-25',
        end_date: '2026-06-05',
      }),
    ]
    expect(replanTasks(tasks, new Set())).toEqual([])
  })

  it('replan partiel : SEULES les tâches listées peuvent être déplacées', () => {
    // 3 tâches s'empilent sur c1 : A (15→29), B (25→6/5), C (1/6→10/6).
    // Si concerned = {B}, seule B doit bouger. A et C restent figées.
    const tasks: Task[] = [
      mkTask('A', {
        collaborator_id: 'c1',
        start_date: '2026-05-15',
        end_date: '2026-05-29',
      }),
      mkTask('B', {
        collaborator_id: 'c1',
        start_date: '2026-05-25',
        end_date: '2026-06-05',
      }),
      mkTask('C', {
        collaborator_id: 'c1',
        start_date: '2026-06-01',
        end_date: '2026-06-10',
      }),
    ]
    const moves = replanTasks(tasks, new Set(['B']))
    // Seule B est listée. A et C restent en place, font OBSTACLE.
    expect(moves.map((m) => m.id)).toEqual(['B'])
    // B doit attendre la fin de C (= 10/06, jour ouvré suivant = 11/06).
    expect(moves[0].newStart).toBe('2026-06-11')
  })

  it('replan partiel : un descendant transitif (successeur) bouge si concerné', () => {
    // X → Y (Y a X comme prédécesseur). Si on inclut Y dans concerned mais pas X,
    // Y peut bouger pour satisfaire la contrainte.
    const tasks: Task[] = [
      mkTask('X', {
        start_date: '2026-05-18',
        end_date: '2026-05-22',
      }),
      mkTask('Y', {
        predecessor_id: 'X',
        start_date: '2026-05-15',
        end_date: '2026-05-19',
      }),
    ]
    const moves = replanTasks(tasks, new Set(['Y']))
    expect(moves.map((m) => m.id)).toEqual(['Y'])
    // Y doit démarrer au plus tôt à X.end (= 22/05, vendredi).
    expect(moves[0].newStart >= '2026-05-22').toBe(true)
  })
})

describe('concernedTaskIds — fermeture transitive', () => {
  it('inclut les tâches mentionnées dans les issues', () => {
    const tasks: Task[] = [mkTask('A'), mkTask('B'), mkTask('C')]
    const issues: ReturnType<typeof checkCoherence> = [
      {
        kind: 'overload',
        severity: 'error',
        taskIds: ['A', 'B'],
        message: 'x',
      },
    ]
    const set = concernedTaskIds(issues, tasks)
    expect([...set].sort()).toEqual(['A', 'B'])
  })

  it('propage aux successeurs transitifs (chaîne X → Y → Z)', () => {
    const tasks: Task[] = [
      mkTask('X'),
      mkTask('Y', { predecessor_id: 'X' }),
      mkTask('Z', { predecessor_id: 'Y' }),
    ]
    const set = concernedTaskIds(
      [
        {
          kind: 'overload',
          severity: 'error',
          taskIds: ['X'],
          message: 'x',
        },
      ],
      tasks,
    )
    expect([...set].sort()).toEqual(['X', 'Y', 'Z'])
  })
})

// =============================================================================
// v1.24 — Tests dédiés couvrant les règles métier RG-GANTT-XXXX (cf.
// docs/regles-metier.md). Chaque test cite explicitement la règle
// qu'il garantit pour faciliter la traçabilité « règle ↔ test ».
// =============================================================================

describe('v1.24 — RG-GANTT-0503 — priorité sans effet visuel ni sur la charge', () => {
  it('changer la priorité d`une activité ne modifie PAS sa charge journalière', () => {
    // Garantit que la priorité (1..5) sert UNIQUEMENT à arbitrer le Replan
    // et la détection d'incohérences ; elle n'a aucun effet sur le plan de
    // charge (1 jour-personne par jour ouvré, quelle que soit la priorité).
    const collabs: Collaborator[] = [
      { id: 'c1', name: 'Léa', color: '#3b82f6', position: 0 },
    ]
    const taskP1 = mkTask('a', {
      collaborator_id: 'c1',
      priority: 1,
      start_date: '2026-06-08', // lundi
      end_date: '2026-06-12', // vendredi
    })
    const taskP5 = mkTask('b', {
      collaborator_id: 'c1',
      priority: 5,
      start_date: '2026-06-08',
      end_date: '2026-06-12',
    })
    const dates = buildDateRange('2026-06-08', '2026-06-12')
    // Avec une seule des deux affectée : charge journalière = 1.
    const chargeP1 = computeWorkload([taskP1], collabs, dates).get('c1')
    const chargeP5 = computeWorkload([taskP5], collabs, dates).get('c1')
    expect(chargeP1).toEqual(chargeP5)
    expect(chargeP1).toEqual([1, 1, 1, 1, 1])
  })

  it('couleur effective d`une activité indépendante de sa priorité', () => {
    // La couleur ne dépend que de (couleur custom > couleur du collab > défaut).
    // La priorité n'a aucun impact, quel que soit son niveau.
    const collabs: Collaborator[] = [
      { id: 'c1', name: 'Léa', color: '#ff0000', position: 0 },
    ]
    const tP1 = mkTask('x', { collaborator_id: 'c1', priority: 1 })
    const tP5 = mkTask('y', { collaborator_id: 'c1', priority: 5 })
    expect(effectiveTaskColor(tP1, collabs)).toBe(
      effectiveTaskColor(tP5, collabs),
    )
  })
})

describe('v1.24 — RG-GANTT-0206 — effectiveTaskColor ignore le collab pour un jalon', () => {
  it('un jalon avec un collaborator_id résiduel ne hérite PAS de la couleur du collab', () => {
    // Garde-fou : même si la base contient encore un jalon « pollué » par un
    // ancien collaborator_id (cf. migration J3 v1.24), la couleur affichée
    // reste neutre — seule la couleur custom ou le défaut s'appliquent.
    const collabs: Collaborator[] = [
      { id: 'c1', name: 'Léa', color: '#ff0000', position: 0 },
    ]
    const milestone = mkTask('m1', {
      kind: 'milestone',
      collaborator_id: 'c1', // résiduel hypothétique
    })
    expect(effectiveTaskColor(milestone, collabs)).toBe(DEFAULT_TASK_COLOR)
  })

  it('une activité avec le même collab continue d`hériter de sa couleur', () => {
    // Contre-test : la règle ne doit affecter QUE les jalons, pas les
    // activités (qui restent peintes à la couleur du collab par défaut).
    const collabs: Collaborator[] = [
      { id: 'c1', name: 'Léa', color: '#ff0000', position: 0 },
    ]
    const task = mkTask('t1', { collaborator_id: 'c1' })
    expect(effectiveTaskColor(task, collabs)).toBe('#ff0000')
  })
})

describe('v1.24 — RG-GANTT-0903 — Replan ne déplace jamais une activité vers le passé', () => {
  it('une activité isolée et libre n`est PAS ramenée en arrière par le replan', () => {
    // Aucune surcharge, aucun prédécesseur : il n'y a rien à corriger. Le
    // replan ne doit pas proposer de déplacer la tâche vers une date plus
    // ancienne pour « optimiser » le planning.
    const t = mkTask('seule', {
      collaborator_id: 'c1',
      start_date: '2026-07-15', // mercredi
      end_date: '2026-07-17',
    })
    const moves = replanTasks([t])
    expect(moves).toEqual([])
  })

  it('après replan, la borne basse de chaque activité est >= sa start_date d`origine', () => {
    // Garantie générale : même quand le replan déplace une tâche (à cause
    // d'une surcharge), il NE LA RAMÈNE JAMAIS en deçà de sa start_date
    // initiale. Le mouvement est unidirectionnel (vers le futur).
    const a = mkTask('a', {
      collaborator_id: 'c1',
      start_date: '2026-06-08',
      end_date: '2026-06-12',
    })
    const b = mkTask('b', {
      collaborator_id: 'c1',
      start_date: '2026-06-10', // chevauche A → surcharge
      end_date: '2026-06-15',
    })
    const moves = replanTasks([a, b])
    for (const m of moves) {
      const orig = [a, b].find((t) => t.id === m.id)!
      expect(m.newStart >= orig.start_date).toBe(true)
    }
  })
})

describe('v1.24 — RG-GANTT-0703 / 0709 — replan respecte la borne basse SNET', () => {
  it('SNET > pred.end + lag → la borne basse de replan est le SNET', () => {
    // Scénario : prédécesseur X finit le mercredi 10/06/2026, lag = 0 (Y peut
    // démarrer dès le 10/06). Mais Y porte une contrainte « Ne doit pas
    // démarrer avant le » au 22/06. Le replan doit proposer Y au 22/06.
    const X = mkTask('X', {
      kind: 'task',
      start_date: '2026-06-08',
      end_date: '2026-06-10',
      collaborator_id: 'c1',
    })
    const Y = mkTask('Y', {
      kind: 'task',
      start_date: '2026-06-10',
      end_date: '2026-06-12',
      collaborator_id: 'c1',
      predecessor_id: 'X',
      predecessor_lag: 0,
      not_before_date: '2026-06-22', // borne SNET plus tardive
    })
    const moves = replanTasks([X, Y])
    // Y doit être proposé à partir du 22/06 (lundi).
    const moveY = moves.find((m) => m.id === 'Y')
    expect(moveY).toBeDefined()
    expect(moveY!.newStart).toBe('2026-06-22')
  })

  it('SNET < pred.end + lag → le prédécesseur gagne (SNET silencieusement satisfait)', () => {
    // Scénario inverse : Y a un SNET au 01/06 mais X finit le 10/06. Le
    // prédécesseur étant plus tardif, c'est lui qui dicte le démarrage.
    const X = mkTask('X', {
      kind: 'task',
      start_date: '2026-06-08',
      end_date: '2026-06-10',
      collaborator_id: 'c1',
    })
    const Y = mkTask('Y', {
      kind: 'task',
      start_date: '2026-06-08',
      end_date: '2026-06-10',
      collaborator_id: 'c1',
      predecessor_id: 'X',
      predecessor_lag: 0,
      not_before_date: '2026-06-01', // borne SNET plus ancienne, sans effet
    })
    const moves = replanTasks([X, Y])
    const moveY = moves.find((m) => m.id === 'Y')
    // Y commence APRÈS la fin de X, conformément à la règle prédécesseur.
    expect(moveY?.newStart || Y.start_date >= X.end_date).toBeTruthy()
    if (moveY) expect(moveY.newStart >= X.end_date).toBe(true)
  })
})

describe('v1.24 — RG-GANTT-0805 — detectNotBeforeViolations lève une erreur', () => {
  it('une activité qui démarre avant son SNET déclenche une issue not_before', () => {
    // Scénario : Léa a placé sa tâche au 05/06 mais sa contrainte « Ne doit
    // pas démarrer avant le » est au 15/06. Une incohérence rouge doit
    // apparaître dans le bandeau d'alertes.
    const t = mkTask('t1', {
      start_date: '2026-06-05',
      end_date: '2026-06-08',
      not_before_date: '2026-06-15',
    })
    const issues = checkCoherence([t])
    const issue = issues.find((i) => i.kind === 'not_before')
    expect(issue).toBeDefined()
    expect(issue!.severity).toBe('error')
    expect(issue!.taskIds).toContain('t1')
    expect(issue!.message).toContain('Ne doit pas démarrer avant le')
  })

  it('une activité qui démarre PILE à son SNET ne déclenche aucune issue', () => {
    // Cas limite : start_date = SNET (snappé jour ouvré) → règle satisfaite.
    const t = mkTask('t1', {
      start_date: '2026-06-15',
      end_date: '2026-06-15',
      not_before_date: '2026-06-15',
    })
    const issues = checkCoherence([t])
    expect(issues.some((i) => i.kind === 'not_before')).toBe(false)
  })

  it('une phase ne déclenche jamais d`issue SNET, même avec un not_before_date', () => {
    // Bien que le système force not_before_date à null pour les phases, on
    // garantit la robustesse de la détection si une valeur résiduelle traîne.
    const phase = mkTask('p1', {
      kind: 'phase',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      not_before_date: '2026-12-31', // ne devrait jamais arriver, garde-fou
    })
    const issues = checkCoherence([phase])
    expect(issues.some((i) => i.kind === 'not_before')).toBe(false)
  })
})

// =============================================================================
// v1.21 / v1.22 — multi-prédécesseurs (helpers purs côté client)
// =============================================================================
describe('computeMaxStartFromPredecessors (v1.21)', () => {
  // Trois tâches sources : ven 12/06, mar 16/06, ven 19/06.
  const allTasks = [
    { id: 'A', end_date: '2026-06-12' },
    { id: 'B', end_date: '2026-06-16' },
    { id: 'C', end_date: '2026-06-19' },
  ]

  it('liste vide → renvoie ""', () => {
    expect(computeMaxStartFromPredecessors([], allTasks)).toBe('')
  })

  it('1 prédécesseur, lag 0 → start = pred.end snappé jour ouvré', () => {
    expect(
      computeMaxStartFromPredecessors([{ id: 'A', lag: 0 }], allTasks),
    ).toBe('2026-06-12')
  })

  it('2 prédécesseurs sans lag → MAX des fins', () => {
    expect(
      computeMaxStartFromPredecessors(
        [
          { id: 'A', lag: 0 },
          { id: 'B', lag: 0 },
        ],
        allTasks,
      ),
    ).toBe('2026-06-16')
  })

  it('lag par lien : le pred + lag le plus tardif gagne', () => {
    // A.end=12/06 + lag=5 → lun 22/06 ; C.end=19/06 + lag=0 → ven 19/06 ; MAX = 22/06.
    expect(
      computeMaxStartFromPredecessors(
        [
          { id: 'A', lag: 5 },
          { id: 'C', lag: 0 },
        ],
        allTasks,
      ),
    ).toBe('2026-06-22')
  })

  it('id inconnu ignoré silencieusement', () => {
    expect(
      computeMaxStartFromPredecessors(
        [
          { id: 'INCONNU', lag: 0 },
          { id: 'A', lag: 0 },
        ],
        allTasks,
      ),
    ).toBe('2026-06-12')
  })
})

describe('flattenTaskTree (v1.22)', () => {
  // Hiérarchie :
  //   P1 (pos 0)
  //     A (pos 0)
  //     B (pos 1)
  //   P2 (pos 1)
  //     C (pos 0)
  //       D (pos 0)
  //   E (pos 2, racine)
  const tasks = [
    { id: 'P1', parent_id: null, position: 0 },
    { id: 'A', parent_id: 'P1', position: 0 },
    { id: 'B', parent_id: 'P1', position: 1 },
    { id: 'P2', parent_id: null, position: 1 },
    { id: 'C', parent_id: 'P2', position: 0 },
    { id: 'D', parent_id: 'C', position: 0 },
    { id: 'E', parent_id: null, position: 2 },
  ]

  it('parcours préfixe : parent avant enfants, ordre par position', () => {
    expect(flattenTaskTree(tasks)).toEqual([
      { id: 'P1', depth: 0 },
      { id: 'A', depth: 1 },
      { id: 'B', depth: 1 },
      { id: 'P2', depth: 0 },
      { id: 'C', depth: 1 },
      { id: 'D', depth: 2 },
      { id: 'E', depth: 0 },
    ])
  })

  it('parent_id pointant vers un id inconnu → traité comme racine', () => {
    expect(
      flattenTaskTree([
        { id: 'X', parent_id: 'FANTOME', position: 0 },
        { id: 'Y', parent_id: null, position: 1 },
      ]),
    ).toEqual([
      { id: 'X', depth: 0 },
      { id: 'Y', depth: 0 },
    ])
  })

  it('liste vide → liste vide', () => {
    expect(flattenTaskTree([])).toEqual([])
  })
})

// =============================================================================
// v2.0 / F4 — Détection FNLT dépassée
// =============================================================================

describe('checkCoherence — FNLT (v2.0 / F4)', () => {
  // RG-GANTT-1510 — Une activité dont la fin calculée dépasse sa FNLT doit
  // être remontée comme `fnlt_overrun` avec severity 'warning' (non bloquant).
  it('v2.0 / RG-GANTT-1510 — activité dépassant sa FNLT → warning', () => {
    const tasks: Task[] = [
      mkTask('A', {
        name: 'Retardée',
        start_date: '2026-06-08',
        end_date: '2026-06-25',
        not_later_than_date: '2026-06-12',
      }),
    ]
    const issues = checkCoherence(tasks)
    const fnlt = issues.filter((i) => i.kind === 'fnlt_overrun')
    expect(fnlt).toHaveLength(1)
    expect(fnlt[0].severity).toBe('warning')
    expect(fnlt[0].taskIds).toEqual(['A'])
    expect(fnlt[0].message).toMatch(/Fin au plus tard/)
  })

  // RG-GANTT-1510 — Fin pile sur la FNLT → pas d'alerte (>= signifie OK).
  it('v2.0 / RG-GANTT-1510 — fin = FNLT exacte → pas d`alerte', () => {
    const tasks: Task[] = [
      mkTask('A', {
        name: 'Pile dans les temps',
        start_date: '2026-06-08',
        end_date: '2026-06-12',
        not_later_than_date: '2026-06-12',
      }),
    ]
    expect(
      checkCoherence(tasks).filter((i) => i.kind === 'fnlt_overrun'),
    ).toHaveLength(0)
  })

  // RG-GANTT-1510 — Sans FNLT, aucune alerte FNLT.
  it('v2.0 / RG-GANTT-1510 — sans FNLT, aucune alerte', () => {
    const tasks: Task[] = [
      mkTask('A', {
        name: 'Pas de deadline',
        start_date: '2026-06-08',
        end_date: '2026-06-25',
        not_later_than_date: null,
      }),
    ]
    expect(
      checkCoherence(tasks).filter((i) => i.kind === 'fnlt_overrun'),
    ).toHaveLength(0)
  })

  // RG-GANTT-1510 — Jalon : sa date dépasse sa FNLT → alerte aussi.
  it('v2.0 / RG-GANTT-1510 — jalon dépassant sa FNLT → warning', () => {
    const tasks: Task[] = [
      mkTask('M', {
        name: 'Jalon raté',
        kind: 'milestone',
        start_date: '2026-07-10',
        end_date: '2026-07-10',
        not_later_than_date: '2026-06-30',
      }),
    ]
    const issues = checkCoherence(tasks).filter(
      (i) => i.kind === 'fnlt_overrun',
    )
    expect(issues).toHaveLength(1)
  })

  // RG-GANTT-1510 — Phase : pas d'alerte FNLT même si end > FNLT.
  it('v2.0 / RG-GANTT-1510 — phase : pas d`alerte FNLT (dates dérivées)', () => {
    const tasks: Task[] = [
      mkTask('P', {
        name: 'Phase',
        kind: 'phase',
        start_date: '2026-06-08',
        end_date: '2026-06-25',
        not_later_than_date: '2026-06-12',
      }),
    ]
    expect(
      checkCoherence(tasks).filter((i) => i.kind === 'fnlt_overrun'),
    ).toHaveLength(0)
  })
})

// =============================================================================
// v2.0 / F5 — Capacité totale + seuils normalisés
// =============================================================================

describe('getTotalCapacity (v2.0 / F5)', () => {
  // RG-GANTT-1600 — Pas d'allocation = capacité 0.
  it('v2.0 / RG-GANTT-1600 — sans allocation : capacité 0', () => {
    expect(getTotalCapacity('2026-06-08', [], 'c1', [])).toBe(0)
  })

  // RG-GANTT-1600 — Allocation 50 % sur un seul projet = capacité 0,5.
  it('v2.0 / RG-GANTT-1600 — 50 % sur 1 projet → 0,5', () => {
    const allocs = [
      {
        id: 'a1',
        project_id: 'pA',
        collaborator_id: 'c1',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        allocation_pct: 50,
      },
    ]
    expect(getTotalCapacity('2026-06-08', allocs, 'c1', [])).toBe(0.5)
  })

  // RG-GANTT-1601 — Σ tous projets : 50 % A + 50 % B = capacité 1,0.
  it('v2.0 / RG-GANTT-1601 — 50 % A + 50 % B → 1', () => {
    const allocs = [
      {
        id: 'a1',
        project_id: 'pA',
        collaborator_id: 'c1',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        allocation_pct: 50,
      },
      {
        id: 'a2',
        project_id: 'pB',
        collaborator_id: 'c1',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        allocation_pct: 50,
      },
    ]
    expect(getTotalCapacity('2026-06-08', allocs, 'c1', [])).toBe(1)
  })

  // RG-GANTT-1602 — Absence multiplicative : 100 % + congé 0,5 j → 0,5.
  it('v2.0 / RG-GANTT-1602 — alloc 100 % + congé 0,5 j → 0,5', () => {
    const allocs = [
      {
        id: 'a1',
        project_id: 'pA',
        collaborator_id: 'c1',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        allocation_pct: 100,
      },
    ]
    const absences = [
      { collaborator_id: 'c1', date: '2026-06-08', fraction: 0.5 },
    ]
    expect(getTotalCapacity('2026-06-08', allocs, 'c1', absences)).toBe(0.5)
  })

  // RG-GANTT-1602 — Congé complet : capacité 0 quelle que soit l'allocation.
  it('v2.0 / RG-GANTT-1602 — congé 1 j → 0 même si 100 % alloué', () => {
    const allocs = [
      {
        id: 'a1',
        project_id: 'pA',
        collaborator_id: 'c1',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        allocation_pct: 100,
      },
    ]
    const absences = [
      { collaborator_id: 'c1', date: '2026-06-08', fraction: 1 },
    ]
    expect(getTotalCapacity('2026-06-08', allocs, 'c1', absences)).toBe(0)
  })

  // Week-end / férié : capacité 0.
  it('v2.0 / RG-GANTT-1600 — week-end : capacité 0', () => {
    const allocs = [
      {
        id: 'a1',
        project_id: 'pA',
        collaborator_id: 'c1',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        allocation_pct: 100,
      },
    ]
    expect(getTotalCapacity('2026-06-06', allocs, 'c1', [])).toBe(0) // samedi
  })
})

describe('workloadCellStyleNormalized (v2.0 / F5)', () => {
  // RG-GANTT-1610 — workload = 0 : neutre par défaut, jaune pâle si highlight.
  it('v2.0 / RG-GANTT-1610 — workload 0 : slate par défaut', () => {
    expect(workloadCellStyleNormalized(0, 1)).toMatch(/text-slate-300/)
  })

  it('v2.0 / RG-GANTT-1610 — workload 0 + highlightUnderload : jaune pâle', () => {
    expect(workloadCellStyleNormalized(0, 1, true)).toMatch(/bg-yellow-200/)
  })

  // RG-GANTT-1611 — workload = capacité : vert (journée pleine).
  it('v2.0 / RG-GANTT-1611 — workload = capacité 0,5 → vert', () => {
    expect(workloadCellStyleNormalized(0.5, 0.5)).toMatch(/bg-emerald-300/)
  })

  // RG-GANTT-1611 — workload < capacité : bleu (sous-charge).
  it('v2.0 / RG-GANTT-1611 — workload 0,25 sur capacité 0,5 = ratio 0,5 → bleu moyen', () => {
    expect(workloadCellStyleNormalized(0.25, 0.5)).toMatch(/bg-blue-200/)
  })

  // RG-GANTT-1611 — workload > capacité : rouge (surcharge).
  it('v2.0 / RG-GANTT-1611 — workload 0,75 sur capacité 0,5 → rouge', () => {
    expect(workloadCellStyleNormalized(0.75, 0.5)).toMatch(/bg-red-500/)
  })

  // RG-GANTT-1611 — capacité 0 + workload > 0 : anomalie, surcharge brute.
  it('v2.0 / RG-GANTT-1611 — capacité 0 mais workload > 0 → rouge (anomalie)', () => {
    expect(workloadCellStyleNormalized(0.5, 0)).toMatch(/bg-red-500/)
  })
})

// =============================================================================
// v2.1 / F2.9 — computeAllocationShortfall
// =============================================================================
// Vérifie que le helper détecte correctement les cas où la charge d'une
// activité ne peut PAS être absorbée par les allocations existantes des
// collaborateurs affectés. Sert de fondation au blocage de sauvegarde
// (TaskEditor) et au blocage de replan (App).
// =============================================================================

describe('computeAllocationShortfall (v2.1 / F2.9)', () => {
  // Fixture commune : projet "p", collab "alice".
  const PROJ = 'p'
  const ALICE = 'alice'
  const BOB = 'bob'

  it('sans collaborateur affecté → toute la charge manque', () => {
    const r = computeAllocationShortfall({
      startDate: '2026-06-01', // lundi
      charge: 5,
      collaboratorIds: [],
      projectId: PROJ,
      allocations: [],
    })
    expect(r.absorbed).toBe(0)
    expect(r.missing).toBe(5)
    expect(r.lastCoveredDay).toBeNull()
    expect(r.horizon).toBeNull()
  })

  it('aucune allocation pertinente → toute la charge manque', () => {
    const r = computeAllocationShortfall({
      startDate: '2026-06-01',
      charge: 3,
      collaboratorIds: [ALICE],
      projectId: PROJ,
      // Allocation existe mais pour un AUTRE projet.
      allocations: [
        {
          id: 'a1',
          project_id: 'autre',
          collaborator_id: ALICE,
          start_date: '2026-06-01',
          end_date: '2026-06-30',
          allocation_pct: 100,
        },
      ],
    })
    expect(r.absorbed).toBe(0)
    expect(r.missing).toBe(3)
    expect(r.horizon).toBeNull()
  })

  it('allocation 100% suffisante → missing = 0', () => {
    const r = computeAllocationShortfall({
      startDate: '2026-06-01', // lundi
      charge: 5,
      collaboratorIds: [ALICE],
      projectId: PROJ,
      allocations: [
        {
          id: 'a1',
          project_id: PROJ,
          collaborator_id: ALICE,
          start_date: '2026-06-01',
          end_date: '2026-06-30',
          allocation_pct: 100,
        },
      ],
    })
    expect(r.absorbed).toBe(5)
    expect(r.missing).toBe(0)
    // lundi 1er + mardi 2 + mercredi 3 + jeudi 4 + vendredi 5 = 5 jours ouvrés.
    expect(r.lastCoveredDay).toBe('2026-06-05')
  })

  it('Q1 — 2 collabs Alice 1j (alloc finit tôt) + Bob 9j → missing = 0', () => {
    // Tâche de 10j à partir du 20/07 lundi.
    // Alice : 100% jusqu'au 20/07 inclus → contribue 1 jour.
    // Bob   : 100% du 20/07 au 30/12 → contribue tout le reste.
    const r = computeAllocationShortfall({
      startDate: '2026-07-20',
      charge: 10,
      collaboratorIds: [ALICE, BOB],
      projectId: PROJ,
      allocations: [
        {
          id: 'a1',
          project_id: PROJ,
          collaborator_id: ALICE,
          start_date: '2026-07-20',
          end_date: '2026-07-20',
          allocation_pct: 100,
        },
        {
          id: 'a2',
          project_id: PROJ,
          collaborator_id: BOB,
          start_date: '2026-07-20',
          end_date: '2026-12-30',
          allocation_pct: 100,
        },
      ],
    })
    expect(r.missing).toBe(0)
    // Jour 1 : Alice=1 + Bob=1 = 2. Total après jour 1 : 2 jours absorbés.
    // Jour 2 → 9 : Bob=1 par jour → +8. Charge atteinte au jour 9 (28/07).
    // En 9 jours calendaires, lundi 20 → mardi 28 (les week-ends comptent 0).
  })

  it("Q2 — trou d'allocation au milieu : charge absorbée sur les jours dispos", () => {
    // Camille : 100% du 20/07 au 23/07 (Lun-Jeu, 4j) puis 100% à partir du 01/09.
    // Tâche : 5j à partir du 20/07.
    // → Absorbé : 4j en juillet + 1j le 01/09 = 5j. missing = 0.
    const r = computeAllocationShortfall({
      startDate: '2026-07-20',
      charge: 5,
      collaboratorIds: [ALICE],
      projectId: PROJ,
      allocations: [
        {
          id: 'a1',
          project_id: PROJ,
          collaborator_id: ALICE,
          start_date: '2026-07-20',
          end_date: '2026-07-23',
          allocation_pct: 100,
        },
        {
          id: 'a2',
          project_id: PROJ,
          collaborator_id: ALICE,
          start_date: '2026-09-01',
          end_date: '2026-09-30',
          allocation_pct: 100,
        },
      ],
    })
    expect(r.missing).toBe(0)
    // 01/09 est un mardi en 2026 → jour ouvré.
    expect(r.lastCoveredDay).toBe('2026-09-01')
  })

  it('tâche démarre APRÈS la fin de toute allocation → toute la charge manque', () => {
    // Bug d'origine : "Tournage extérieur" 8j affecté à Camille dont
    // l'allocation se termine le 23/07. Tâche commence le 24/07 → 0 capacité.
    const r = computeAllocationShortfall({
      startDate: '2026-07-24', // après la fin de l'allocation
      charge: 8,
      collaboratorIds: [ALICE],
      projectId: PROJ,
      allocations: [
        {
          id: 'a1',
          project_id: PROJ,
          collaborator_id: ALICE,
          start_date: '2026-06-01',
          end_date: '2026-07-23',
          allocation_pct: 100,
        },
      ],
    })
    expect(r.absorbed).toBe(0)
    expect(r.missing).toBe(8)
    expect(r.lastCoveredDay).toBeNull()
    // Horizon = dernière fin d'allocation pertinente, même si la tâche
    // démarre après — utile au dialog pour proposer une extension.
    expect(r.horizon).toBe('2026-07-23')
  })

  it('allocation 50% insuffisante → missing = charge / 2 (positifs)', () => {
    // Alice 50% sur juin (~20 jours ouvrés × 0.5 = ~10j capacité).
    // Charge 12j → manque ~2j.
    const r = computeAllocationShortfall({
      startDate: '2026-06-01',
      charge: 12,
      collaboratorIds: [ALICE],
      projectId: PROJ,
      allocations: [
        {
          id: 'a1',
          project_id: PROJ,
          collaborator_id: ALICE,
          start_date: '2026-06-01',
          end_date: '2026-06-30',
          allocation_pct: 50,
        },
      ],
    })
    expect(r.missing).toBeGreaterThan(0)
    expect(r.missing).toBeLessThan(12)
    expect(r.horizon).toBe('2026-06-30')
    // 11 jours ouvrés en juin si on compte de 01 à 30 (22 ouvrés × 0.5 = 11).
    // Le scan s'arrête au 30/06.
  })
})

// =============================================================================
// v2.1 / F2.9.B — computeExtensionPlan
// =============================================================================
// Vérifie que le helper de planification d'extension calcule correctement la
// date cible et les opérations (patch vs create selon Q5=C).
// =============================================================================

describe('computeExtensionPlan (v2.1 / F2.9.B)', () => {
  const PROJ = 'p'
  const ALICE = 'alice'
  const BOB = 'bob'

  it('1 collab, allocation 100% existante, manque 3j à 100% → PATCH end_date', () => {
    const plan = computeExtensionPlan({
      startDate: '2026-07-20', // lundi
      missing: 3,
      collaboratorIds: [ALICE],
      projectId: PROJ,
      allocations: [
        {
          id: 'a1',
          project_id: PROJ,
          collaborator_id: ALICE,
          start_date: '2026-06-01',
          end_date: '2026-07-23', // jeudi
          allocation_pct: 100,
        },
      ],
      pct: 100,
    })
    // Une seule opération : PATCH de a1, end_date repoussée.
    expect(plan.operations).toHaveLength(1)
    expect(plan.operations[0].kind).toBe('patch')
    expect(plan.operations[0].allocationId).toBe('a1')
    expect(plan.operations[0].collaboratorId).toBe(ALICE)
    expect(plan.operations[0].pct).toBe(100)
    // Scan démarre le 24/07 (vendredi), 3 jours ouvrés : 24, 27, 28.
    expect(plan.targetEndDate).toBe('2026-07-28')
    expect(plan.feasible).toBe(true)
  })

  it('Q5=C — changement de % → CREATE nouvelle allocation', () => {
    // Allocation existante à 100%, on demande une extension à 50%.
    // Q5=C : pct différent → CREATE (pas PATCH).
    const plan = computeExtensionPlan({
      startDate: '2026-07-20',
      missing: 2,
      collaboratorIds: [ALICE],
      projectId: PROJ,
      allocations: [
        {
          id: 'a1',
          project_id: PROJ,
          collaborator_id: ALICE,
          start_date: '2026-06-01',
          end_date: '2026-07-23',
          allocation_pct: 100,
        },
      ],
      pct: 50,
    })
    expect(plan.operations).toHaveLength(1)
    expect(plan.operations[0].kind).toBe('create')
    expect(plan.operations[0].pct).toBe(50)
    // Nouvelle alloc démarre le lendemain de l'existante (24/07 = vendredi).
    expect(plan.operations[0].startDate).toBe('2026-07-24')
    expect(plan.feasible).toBe(true)
  })

  it('aucune allocation existante → CREATE depuis startDate', () => {
    const plan = computeExtensionPlan({
      startDate: '2026-07-20',
      missing: 5,
      collaboratorIds: [ALICE],
      projectId: PROJ,
      allocations: [],
      pct: 100,
    })
    expect(plan.operations).toHaveLength(1)
    expect(plan.operations[0].kind).toBe('create')
    expect(plan.operations[0].startDate).toBe('2026-07-20')
  })

  it('2 collabs affectés → 2 opérations (1 par collab)', () => {
    const plan = computeExtensionPlan({
      startDate: '2026-07-20',
      missing: 4,
      collaboratorIds: [ALICE, BOB],
      projectId: PROJ,
      allocations: [
        {
          id: 'a1',
          project_id: PROJ,
          collaborator_id: ALICE,
          start_date: '2026-06-01',
          end_date: '2026-07-23',
          allocation_pct: 100,
        },
        // Bob n'a aucune allocation antérieure.
      ],
      pct: 100,
    })
    expect(plan.operations).toHaveLength(2)
    const aliceOp = plan.operations.find((o) => o.collaboratorId === ALICE)
    const bobOp = plan.operations.find((o) => o.collaboratorId === BOB)
    expect(aliceOp?.kind).toBe('patch')
    expect(bobOp?.kind).toBe('create')
    // Tous deux contribuent → on absorbe 2j/jour ouvré, donc 4j en 2 jours ouvrés.
    // Scan démarre le 24/07 (vendredi : 2/jour) puis 27/07 (lundi : 2/jour) = 4j atteint.
    expect(plan.targetEndDate).toBe('2026-07-27')
  })

  it('pct = 0 → infeasible (garde-fou)', () => {
    const plan = computeExtensionPlan({
      startDate: '2026-07-20',
      missing: 3,
      collaboratorIds: [ALICE],
      projectId: PROJ,
      allocations: [],
      pct: 0,
    })
    expect(plan.feasible).toBe(false)
  })

  it('missing = 0 → rien à étendre, feasible=true', () => {
    const plan = computeExtensionPlan({
      startDate: '2026-07-20',
      missing: 0,
      collaboratorIds: [ALICE],
      projectId: PROJ,
      allocations: [],
      pct: 100,
    })
    expect(plan.feasible).toBe(true)
  })
})

// =============================================================================
// v2.1 / F2.9.C — scanReplanShortfalls
// =============================================================================
// Vérifie le scan multi-tâches qui prépare le récap du dialog F2.9.D.
// =============================================================================

describe('scanReplanShortfalls (v2.1 / F2.9.C)', () => {
  const PROJ = 'p'
  const ALICE = 'alice'

  it('phases et jalons ignorés (kind != task)', () => {
    const tasks = [
      mkTask('phase1', { kind: 'phase' }),
      mkTask('milestone1', { kind: 'milestone' }),
    ]
    const r = scanReplanShortfalls(tasks, PROJ, [], [])
    expect(r).toEqual([])
  })

  it('activités sans collaborateur ignorées', () => {
    const tasks = [mkTask('t1', { collaborator_id: null, charge_jours: 5 })]
    const r = scanReplanShortfalls(tasks, PROJ, [], [])
    expect(r).toEqual([])
  })

  it('activités sans charge ignorées', () => {
    const tasks = [mkTask('t1', { collaborator_id: ALICE, charge_jours: 0 })]
    const r = scanReplanShortfalls(tasks, PROJ, [], [])
    expect(r).toEqual([])
  })

  it('activité absorbable → exclue du résultat', () => {
    const tasks = [
      mkTask('t1', {
        collaborator_id: ALICE,
        charge_jours: 3,
        start_date: '2026-06-01',
      }),
    ]
    const r = scanReplanShortfalls(
      tasks,
      PROJ,
      [
        {
          id: 'a1',
          project_id: PROJ,
          collaborator_id: ALICE,
          start_date: '2026-06-01',
          end_date: '2026-06-30',
          allocation_pct: 100,
        },
      ],
      [],
    )
    expect(r).toEqual([])
  })

  it('activité non absorbable → présente avec son shortfall', () => {
    const tasks = [
      mkTask('t1', {
        name: 'Tournage extérieur',
        collaborator_id: ALICE,
        charge_jours: 8,
        start_date: '2026-07-24', // après fin allocation
      }),
    ]
    const r = scanReplanShortfalls(
      tasks,
      PROJ,
      [
        {
          id: 'a1',
          project_id: PROJ,
          collaborator_id: ALICE,
          start_date: '2026-06-01',
          end_date: '2026-07-23',
          allocation_pct: 100,
        },
      ],
      [],
    )
    expect(r).toHaveLength(1)
    expect(r[0].taskId).toBe('t1')
    expect(r[0].taskName).toBe('Tournage extérieur')
    expect(r[0].charge).toBe(8)
    expect(r[0].shortfall.missing).toBe(8)
    expect(r[0].shortfall.horizon).toBe('2026-07-23')
  })

  it('plusieurs activités : seules les non absorbables sont retournées', () => {
    const tasks = [
      mkTask('ok', {
        collaborator_id: ALICE,
        charge_jours: 2,
        start_date: '2026-06-01',
      }),
      mkTask('ko', {
        collaborator_id: ALICE,
        charge_jours: 5,
        start_date: '2026-08-01',
      }),
    ]
    const r = scanReplanShortfalls(
      tasks,
      PROJ,
      [
        {
          id: 'a1',
          project_id: PROJ,
          collaborator_id: ALICE,
          start_date: '2026-06-01',
          end_date: '2026-06-30',
          allocation_pct: 100,
        },
      ],
      [],
    )
    expect(r).toHaveLength(1)
    expect(r[0].taskId).toBe('ko')
  })
})

// =============================================================================
// v2.1 / F4 — rebuildAllocationsForCollab
// =============================================================================
// Vérifie le helper de réécriture des allocations après édition jour-par-jour
// dans la grille « Affectation » (clic / drag-paint).
// =============================================================================

describe('rebuildAllocationsForCollab (v2.1 / F4)', () => {
  const PROJ = 'p'
  const ALICE = 'alice'
  const BOB = 'bob'

  /** Helper local : construit une allocation MemberAllocation. */
  function alloc(
    id: string,
    start: string,
    end: string,
    pct: number,
    collab = ALICE,
    proj = PROJ,
  ) {
    return {
      id,
      project_id: proj,
      collaborator_id: collab,
      start_date: start,
      end_date: end,
      allocation_pct: pct,
    }
  }

  it('aucun changement, aucune allocation → vide', () => {
    const r = rebuildAllocationsForCollab({
      projectId: PROJ,
      collaboratorId: ALICE,
      existing: [],
      changes: new Map(),
    })
    expect(r.toDelete).toEqual([])
    expect(r.toCreate).toEqual([])
  })

  it("ajoute 1 jour isolé → 1 nouvelle alloc d'1 jour", () => {
    const r = rebuildAllocationsForCollab({
      projectId: PROJ,
      collaboratorId: ALICE,
      existing: [],
      changes: new Map([['2026-06-15', 50]]),
    })
    expect(r.toDelete).toEqual([])
    expect(r.toCreate).toHaveLength(1)
    expect(r.toCreate[0]).toEqual({
      start_date: '2026-06-15',
      end_date: '2026-06-15',
      allocation_pct: 50,
    })
  })

  it('compacte plusieurs jours contigus de même pct en 1 seul run', () => {
    const r = rebuildAllocationsForCollab({
      projectId: PROJ,
      collaboratorId: ALICE,
      existing: [],
      changes: new Map([
        ['2026-06-15', 100],
        ['2026-06-16', 100],
        ['2026-06-17', 100],
      ]),
    })
    expect(r.toCreate).toHaveLength(1)
    expect(r.toCreate[0]).toEqual({
      start_date: '2026-06-15',
      end_date: '2026-06-17',
      allocation_pct: 100,
    })
  })

  it('change le pct du milieu → split en 3 runs (pct différents)', () => {
    // 5 jours à 100 % au départ, on bascule le jour central à 50 %.
    const existing = [alloc('a1', '2026-06-15', '2026-06-19', 100)]
    const r = rebuildAllocationsForCollab({
      projectId: PROJ,
      collaboratorId: ALICE,
      existing,
      changes: new Map([['2026-06-17', 50]]),
    })
    expect(r.toDelete).toEqual(['a1'])
    expect(r.toCreate).toEqual([
      { start_date: '2026-06-15', end_date: '2026-06-16', allocation_pct: 100 },
      { start_date: '2026-06-17', end_date: '2026-06-17', allocation_pct: 50 },
      { start_date: '2026-06-18', end_date: '2026-06-19', allocation_pct: 100 },
    ])
  })

  it('retire un jour du milieu (pct=0) → split en 2 runs', () => {
    const existing = [alloc('a1', '2026-06-15', '2026-06-19', 100)]
    const r = rebuildAllocationsForCollab({
      projectId: PROJ,
      collaboratorId: ALICE,
      existing,
      changes: new Map([['2026-06-17', 0]]),
    })
    expect(r.toDelete).toEqual(['a1'])
    expect(r.toCreate).toEqual([
      { start_date: '2026-06-15', end_date: '2026-06-16', allocation_pct: 100 },
      { start_date: '2026-06-18', end_date: '2026-06-19', allocation_pct: 100 },
    ])
  })

  it('ignore les allocations des autres collabs / projets', () => {
    const existing = [
      alloc('a1', '2026-06-15', '2026-06-19', 100), // Alice / PROJ
      alloc('b1', '2026-06-15', '2026-06-19', 75, BOB), // Bob / PROJ
      alloc('a2', '2026-06-15', '2026-06-19', 100, ALICE, 'autre'), // Alice / autre projet
    ]
    const r = rebuildAllocationsForCollab({
      projectId: PROJ,
      collaboratorId: ALICE,
      existing,
      changes: new Map(),
    })
    // toDelete doit contenir UNIQUEMENT a1.
    expect(r.toDelete).toEqual(['a1'])
    // toCreate doit reconstruire l'alloc a1 telle quelle (aucun change).
    expect(r.toCreate).toEqual([
      { start_date: '2026-06-15', end_date: '2026-06-19', allocation_pct: 100 },
    ])
  })
})
