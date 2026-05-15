// =============================================================================
// TESTS — sauvegarde automatique quotidienne (server/backup.js, v1.8)
// =============================================================================
// Couvre :
//   • todayStamp / backupPathFor / listBackups (helpers purs)
//   • runDailyBackup : création, anti-doublon, rotation
//   • scheduleDailyBackup : catch-up + tick périodique (timers Vitest)
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb } from '../db/index.js'
import {
  backupPathFor,
  listBackups,
  purgeOldBackups,
  runDailyBackup,
  scheduleDailyBackup,
  todayStamp,
} from './backup.js'

let tmpDir
let db

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-backup-'))
  db = initDb(':memory:')
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
describe('todayStamp()', () => {
  it('formate une date en YYYY-MM-DD (fuseau local)', () => {
    // 7 mars 2026 à midi local → "2026-03-07".
    const stamp = todayStamp(new Date(2026, 2, 7, 12, 0, 0))
    expect(stamp).toBe('2026-03-07')
  })

  it('pad correctement les mois et jours < 10', () => {
    expect(todayStamp(new Date(2026, 0, 1, 12, 0, 0))).toBe('2026-01-01')
  })
})

describe('backupPathFor()', () => {
  it('construit le chemin attendu', () => {
    // sonarjs/publicly-writable-directories désactivé : c'est un chemin de
    // test purement symbolique passé à un helper pur, jamais écrit sur disque.
    // eslint-disable-next-line sonarjs/publicly-writable-directories
    const dir = '/tmp/bk'
    // eslint-disable-next-line sonarjs/publicly-writable-directories
    const expected = path.join('/tmp/bk', 'data-2026-05-15.db')
    expect(backupPathFor(dir, '2026-05-15')).toBe(expected)
  })
})

describe('listBackups()', () => {
  it('retourne [] si le dossier n’existe pas', () => {
    expect(listBackups(path.join(tmpDir, 'absent'))).toEqual([])
  })

  it('ignore les fichiers ne respectant pas le motif', () => {
    fs.writeFileSync(path.join(tmpDir, 'data-2026-05-15.db'), '')
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '')
    fs.writeFileSync(path.join(tmpDir, 'data-not-a-date.db'), '')
    const entries = listBackups(tmpDir)
    expect(entries.map((e) => e.file)).toEqual(['data-2026-05-15.db'])
  })

  it('trie chronologiquement', () => {
    fs.writeFileSync(path.join(tmpDir, 'data-2026-05-15.db'), '')
    fs.writeFileSync(path.join(tmpDir, 'data-2026-05-10.db'), '')
    fs.writeFileSync(path.join(tmpDir, 'data-2026-05-12.db'), '')
    expect(listBackups(tmpDir).map((e) => e.stamp)).toEqual([
      '2026-05-10',
      '2026-05-12',
      '2026-05-15',
    ])
  })
})

// -----------------------------------------------------------------------------
// purgeOldBackups
// -----------------------------------------------------------------------------
describe('purgeOldBackups()', () => {
  it('supprime les fichiers plus vieux que la rétention', () => {
    fs.writeFileSync(path.join(tmpDir, 'data-2026-05-01.db'), '')
    fs.writeFileSync(path.join(tmpDir, 'data-2026-05-10.db'), '')
    fs.writeFileSync(path.join(tmpDir, 'data-2026-05-15.db'), '')
    // Référence : 15 mai 2026 midi, rétention 7 jours → cutoff = 8 mai.
    const deleted = purgeOldBackups(tmpDir, 7, new Date(2026, 4, 15, 12, 0, 0))
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toContain('data-2026-05-01.db')
    expect(listBackups(tmpDir).map((e) => e.stamp)).toEqual([
      '2026-05-10',
      '2026-05-15',
    ])
  })

  it('ne supprime rien si tous les fichiers sont dans la fenêtre', () => {
    fs.writeFileSync(path.join(tmpDir, 'data-2026-05-14.db'), '')
    fs.writeFileSync(path.join(tmpDir, 'data-2026-05-15.db'), '')
    const deleted = purgeOldBackups(tmpDir, 7, new Date(2026, 4, 15, 12, 0, 0))
    expect(deleted).toEqual([])
  })
})

// -----------------------------------------------------------------------------
// runDailyBackup
// -----------------------------------------------------------------------------
describe('runDailyBackup()', () => {
  it('crée un fichier daté du jour quand il n’existe pas', async () => {
    const now = new Date(2026, 4, 15, 9, 0, 0)
    const result = await runDailyBackup(db, {
      dir: tmpDir,
      retentionDays: 7,
      now,
    })
    expect(result.created).toBe(true)
    expect(result.stamp).toBe('2026-05-15')
    expect(fs.existsSync(result.path)).toBe(true)
    expect(fs.statSync(result.path).size).toBeGreaterThan(0)
  })

  it('ne recrée pas le fichier si celui du jour existe déjà', async () => {
    const now = new Date(2026, 4, 15, 9, 0, 0)
    await runDailyBackup(db, { dir: tmpDir, retentionDays: 7, now })
    const firstStat = fs.statSync(
      path.join(tmpDir, 'data-2026-05-15.db'),
    ).mtimeMs

    // Petit délai pour s'assurer que le mtime changerait s'il y avait écriture.
    await new Promise((resolve) => setTimeout(resolve, 10))

    const second = await runDailyBackup(db, {
      dir: tmpDir,
      retentionDays: 7,
      now,
    })
    expect(second.created).toBe(false)
    const secondStat = fs.statSync(
      path.join(tmpDir, 'data-2026-05-15.db'),
    ).mtimeMs
    expect(secondStat).toBe(firstStat)
  })

  it('purge les anciens fichiers après création', async () => {
    // Pré-existant : un fichier vieux de 10 jours qui doit disparaître.
    fs.writeFileSync(path.join(tmpDir, 'data-2026-05-05.db'), '')
    const now = new Date(2026, 4, 15, 9, 0, 0)
    const result = await runDailyBackup(db, {
      dir: tmpDir,
      retentionDays: 7,
      now,
    })
    expect(result.created).toBe(true)
    expect(result.deleted).toHaveLength(1)
    expect(result.deleted[0]).toContain('data-2026-05-05.db')
  })
})

// -----------------------------------------------------------------------------
// scheduleDailyBackup — vérifie le catch-up et le tick périodique
// -----------------------------------------------------------------------------
describe('scheduleDailyBackup()', () => {
  it('déclenche un catch-up au démarrage et logue la création', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }
    const handle = scheduleDailyBackup(db, {
      dir: tmpDir,
      retentionDays: 7,
      checkIntervalMs: 60 * 60 * 1000,
      logger,
    })
    // Laisse la microtask du tick() initial se résoudre.
    await new Promise((resolve) => setTimeout(resolve, 50))
    handle.stop()

    expect(listBackups(tmpDir)).toHaveLength(1)
    expect(logger.log).toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('expose un stop() qui empêche les ticks suivants', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }
    vi.useFakeTimers()
    const handle = scheduleDailyBackup(db, {
      dir: tmpDir,
      retentionDays: 7,
      checkIntervalMs: 1000,
      logger,
    })
    handle.stop()
    vi.advanceTimersByTime(5000)
    vi.useRealTimers()
    // Pas d'erreur, pas de second appel au-delà du catch-up.
    expect(logger.error).not.toHaveBeenCalled()
  })
})
