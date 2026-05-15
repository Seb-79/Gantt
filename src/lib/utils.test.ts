// =============================================================================
// TESTS — fonctions utilitaires Gantt (Vitest)
// =============================================================================

import { describe, it, expect } from 'vitest'
import {
  buildDateRange,
  clampDayWidth,
  dateToIso,
  dateToX,
  defaultWindow,
  effectiveTaskColor,
  groupByMonth,
  isoToDate,
  isWeekendDay,
  makeId,
  rangeToWidth,
  DEFAULT_DAY_WIDTH,
  DEFAULT_TASK_COLOR,
  MAX_DAY_WIDTH,
  MIN_DAY_WIDTH,
} from './utils'
import type { Collaborator, Task } from './types'

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
  const baseTask: Task = {
    id: 't1',
    name: 'x',
    kind: 'task',
    start_date: '2026-01-01',
    end_date: '2026-01-02',
    progress: 0,
    collaborator_id: null,
    color: null,
    parent_id: null,
    position: 0,
  }

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
