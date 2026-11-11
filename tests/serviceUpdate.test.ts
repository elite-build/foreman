// The service's Foreman updating itself on trial (src/main/serviceUpdate.ts; docs/server.md, "As a service"): what each
// start does about a trial, and the snapshot, putting it back and the outcome, on a real data folder with a real
// foreman.db.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ForemanDb } from '../src/main/db'
import {
  commitTrial,
  failTrial,
  MAX_TRIES,
  OUTCOME_FILE,
  parseOutcome,
  parseRetry,
  parseTrial,
  readOutcome,
  readTrial,
  RETRY_FLAG,
  SNAPSHOT_DIR,
  startTrial,
  takeSnapshot,
  trialStep,
  type UpdateTrial
} from '../src/main/serviceUpdate'
import { tempDir } from './helpers'

const NOW = Date.UTC(2026, 10, 10, 15, 0)
const trial = (over: Partial<UpdateTrial> = {}): UpdateTrial => ({ from: '1.0.22', to: '1.0.23', at: NOW, files: ['foreman.db', 'state.json'], tries: 0, dirty: false, ...over })

describe('what a start does about a trial', () => {
  const on = (version: string, human = false, now = NOW + 60_000) => ({ version, human, now })

  it('starts as usual with no trial', () => {
    expect(trialStep(null, on('1.0.23'))).toEqual({ action: 'start', restore: false })
  })

  it('tries the new version, putting the data back first when an earlier try didn’t finish', () => {
    expect(trialStep(trial(), on('1.0.23'))).toEqual({ action: 'try', restore: false, trial: trial({ tries: 1, dirty: true }) })
    expect(trialStep(trial({ tries: 1, dirty: true }), on('1.0.23'))).toEqual({ action: 'try', restore: true, trial: trial({ tries: 2, dirty: true }) })
    // Put back already (a stop, then a start): nothing to put back again.
    expect(trialStep(trial({ tries: 1, dirty: false }), on('1.0.23'))).toMatchObject({ action: 'try', restore: false })
  })

  it('after every try failed, puts the data back and stops, unless someone opened Foreman, who gets fresh tries', () => {
    const spent = trial({ tries: MAX_TRIES, dirty: true, error: 'no such column' })
    expect(trialStep(spent, on('1.0.23'))).toEqual({
      action: 'stop',
      restore: true,
      trial: { ...spent, dirty: false },
      outcome: { from: '1.0.22', to: '1.0.23', at: NOW + 60_000, outcome: 'rolled-back', tries: MAX_TRIES, error: 'no such column' }
    })
    expect(trialStep(spent, on('1.0.23', true))).toMatchObject({ action: 'try', restore: true, trial: { tries: 1, dirty: true } })
  })

  it('ends the trial when another version starts, putting the data back only if the new one touched it', () => {
    // The install failed: the old version is back and the new one never ran.
    expect(trialStep(trial(), on('1.0.22'))).toEqual({ action: 'start', restore: false })
    // Someone went back to the old version after a try: the data goes back, and that counts as rolled back.
    expect(trialStep(trial({ tries: 2, dirty: true }), on('1.0.22'))).toMatchObject({ action: 'start', restore: true, outcome: { outcome: 'rolled-back', tries: 2 } })
  })

  it('never puts back a snapshot the new version first sees long after it was taken', () => {
    expect(trialStep(trial(), on('1.0.23', false, NOW + 31 * 60_000))).toEqual({ action: 'start', restore: false })
    // Once a try has begun, time doesn't matter: what it half did must go.
    expect(trialStep(trial({ tries: 1, dirty: true }), on('1.0.23', false, NOW + 24 * 3600_000))).toMatchObject({ action: 'try', restore: true })
  })

  it('reads only notes that add up, and the retry flag after the executable', () => {
    expect(parseTrial(JSON.stringify(trial()))).toEqual(trial())
    expect(parseTrial(JSON.stringify({ ...trial(), files: ['foreman.db', '../../etc/passwd'] }))?.files).toEqual(['foreman.db'])
    for (const bad of [null, '', '{', '[]', JSON.stringify({ ...trial(), tries: '1' }), JSON.stringify({ ...trial(), dirty: undefined })]) expect(parseTrial(bad), String(bad)).toBeNull()
    expect(parseOutcome(JSON.stringify({ from: 'a', to: 'b', at: 1, outcome: 'kept', tries: 1 }))).toMatchObject({ outcome: 'kept' })
    expect(parseOutcome(JSON.stringify({ from: 'a', to: 'b', at: 1, outcome: 'maybe', tries: 1 }))).toBeNull()
    expect(parseRetry(['Foreman.exe', '--headless', RETRY_FLAG])).toBe(true)
    expect(parseRetry([RETRY_FLAG])).toBe(false)
  })
})

/** A data folder with a real foreman.db holding `value`, state.json and no vault. */
async function dataFolder(value: string) {
  const dir = await tempDir('foreman-update-')
  const db = new ForemanDb(path.join(dir, 'foreman.db'))
  db.setMeta('probe', value)
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ probe: value }))
  return { dir, db }
}

const probe = (dir: string) => {
  const db = new ForemanDb(path.join(dir, 'foreman.db'))
  try {
    return { db: db.getMeta('probe'), state: (JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')) as { probe: string }).probe }
  } finally {
    db.close()
  }
}

/** What the new version does to the data on a try: changes the database and preferences, and leaves a write-ahead log. */
function halfDo(dir: string, log = true) {
  const db = new ForemanDb(path.join(dir, 'foreman.db'))
  db.setMeta('probe', 'half-migrated')
  db.close()
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ probe: 'half-migrated' }))
  if (log) writeFileSync(path.join(dir, 'foreman.db-wal'), 'stale log')
}

describe('the trial on a data folder', () => {
  it('copies the database while it is open, and the files that exist, with the note last', async () => {
    const { dir, db } = await dataFolder('before')
    const made = takeSnapshot(dir, { from: '1.0.22', to: '1.0.23', now: NOW, copyDb: (file) => db.backupTo(file) })
    db.close()
    expect(made).toEqual(trial({ files: ['foreman.db', 'state.json'] }))
    expect(readTrial(dir)).toEqual(made)
    expect(existsSync(path.join(dir, SNAPSHOT_DIR, 'secrets.bin'))).toBe(false)
  })

  it('leaves no snapshot when one can’t be made', async () => {
    const { dir, db } = await dataFolder('before')
    db.close()
    expect(() => takeSnapshot(dir, { from: '1.0.22', to: '1.0.23', now: NOW, copyDb: () => { throw new Error('disk full') } })).toThrow('disk full')
    expect(existsSync(path.join(dir, SNAPSHOT_DIR))).toBe(false)
    expect(startTrial(dir, { version: '1.0.23', human: false, now: NOW })).toEqual({ step: { action: 'start', restore: false } })
  })

  it('puts the data back before each retry, and after the last one stops with it as the old version left it', async () => {
    const { dir, db } = await dataFolder('before')
    takeSnapshot(dir, { from: '1.0.22', to: '1.0.23', now: NOW, copyDb: (file) => db.backupTo(file) })
    db.close()
    // The new version's first try: nothing to put back yet.
    let start = startTrial(dir, { version: '1.0.23', human: false, now: NOW + 60_000 })
    expect(start.step).toMatchObject({ action: 'try', restore: false })
    for (let n = 1; n < MAX_TRIES; n++) {
      halfDo(dir)
      failTrial(dir, start.trial!, 'no such column: x')
      start = startTrial(dir, { version: '1.0.23', human: false, now: NOW + 60_000 })
      expect(start.step).toMatchObject({ action: 'try', restore: true, trial: { tries: n + 1 } })
      expect(probe(dir)).toEqual({ db: 'before', state: 'before' })
      expect(existsSync(path.join(dir, 'foreman.db-wal'))).toBe(false)
    }
    halfDo(dir)
    failTrial(dir, start.trial!, 'no such column: x')
    expect(startTrial(dir, { version: '1.0.23', human: false, now: NOW + 120_000 }).step).toMatchObject({ action: 'stop', restore: true })
    expect(probe(dir)).toEqual({ db: 'before', state: 'before' })
    expect(readOutcome(dir)).toEqual({ from: '1.0.22', to: '1.0.23', at: NOW + 120_000, outcome: 'rolled-back', tries: MAX_TRIES, error: 'no such column: x' })
    // The service starting it again at the next login stops at once; someone opening it gets fresh tries.
    expect(startTrial(dir, { version: '1.0.23', human: false, now: NOW + 3600_000 }).step).toMatchObject({ action: 'stop', restore: false })
    expect(startTrial(dir, { version: '1.0.23', human: true, now: NOW + 3600_000 }).step).toMatchObject({ action: 'try', restore: false, trial: { tries: 1 } })
  })

  it('keeps the update once it serves: the copy goes, and nothing is put back after', async () => {
    const { dir, db } = await dataFolder('before')
    takeSnapshot(dir, { from: '1.0.22', to: '1.0.23', now: NOW, copyDb: (file) => db.backupTo(file) })
    db.close()
    const start = startTrial(dir, { version: '1.0.23', human: false, now: NOW + 60_000 })
    halfDo(dir, false)
    expect(commitTrial(dir, start.trial!, NOW + 90_000)).toEqual({ from: '1.0.22', to: '1.0.23', at: NOW + 90_000, outcome: 'kept', tries: 1 })
    expect(existsSync(path.join(dir, SNAPSHOT_DIR))).toBe(false)
    expect(JSON.parse(readFileSync(path.join(dir, OUTCOME_FILE), 'utf8'))).toMatchObject({ outcome: 'kept' })
    expect(startTrial(dir, { version: '1.0.23', human: false, now: NOW + 120_000 }).step).toEqual({ action: 'start', restore: false })
    expect(probe(dir).db).toBe('half-migrated')
  })

  it('puts the data back when the old version starts after the new one tried, so it can open it again', async () => {
    const { dir, db } = await dataFolder('before')
    takeSnapshot(dir, { from: '1.0.22', to: '1.0.23', now: NOW, copyDb: (file) => db.backupTo(file) })
    db.close()
    startTrial(dir, { version: '1.0.23', human: false, now: NOW + 60_000 })
    halfDo(dir)
    expect(startTrial(dir, { version: '1.0.22', human: true, now: NOW + 90_000 }).step).toMatchObject({ action: 'start', restore: true })
    expect(probe(dir)).toEqual({ db: 'before', state: 'before' })
    expect(existsSync(path.join(dir, SNAPSHOT_DIR))).toBe(false)
    expect(readOutcome(dir)).toMatchObject({ outcome: 'rolled-back', to: '1.0.23' })
  })

  it('throws away a snapshot whose install never happened, without putting it back', async () => {
    const { dir, db } = await dataFolder('before')
    takeSnapshot(dir, { from: '1.0.22', to: '1.0.23', now: NOW, copyDb: (file) => db.backupTo(file) })
    db.setMeta('probe', 'later')
    db.close()
    expect(startTrial(dir, { version: '1.0.22', human: true, now: NOW + 60_000 }).step).toEqual({ action: 'start', restore: false })
    expect(probe(dir).db).toBe('later')
    expect(existsSync(path.join(dir, SNAPSHOT_DIR))).toBe(false)
    expect(readOutcome(dir)).toBeNull()
  })
})
