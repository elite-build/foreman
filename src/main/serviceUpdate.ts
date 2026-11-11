// The service's Foreman updating itself on trial (docs/server.md, "As a service"; elite-build/foreman#165). Before it
// installs a downloaded update, the service's Foreman copies its data aside. The new version keeps the update only once
// it has opened the data (foreman.db's migrations) and is serving the command line. A new version that fails before
// then puts the data back as it was, so the version before it can open it again: foreman.db refuses a schema newer
// than its own. Only the data goes back; the new version stays installed.
//
// The data is put back by the next start, never by the Foreman that failed: that one may still hold foreman.db open,
// and Windows won't replace an open file. So a try that fails starts Foreman again (RETRY_FLAG), which puts the data
// back and tries again, up to MAX_TRIES; then it puts the data back and stops. A crash is caught the same way, by
// whatever starts Foreman next. The decisions are pure and tested; the file work runs before anything opens the data.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { renameSyncWithRetry } from './store'

/** The data folder's copy of the data, and the trial note that goes with it. */
export const SNAPSHOT_DIR = 'update-snapshot'
const TRIAL_FILE = 'trial.json'
/** How the last update went, for `foreman service` and for the service not to install a version that failed again. */
export const OUTCOME_FILE = 'update-outcome.json'
/** What a snapshot holds: the database (copied consistently by the caller while Foreman runs), preferences and the vault. */
export const SNAPSHOT_FILES = ['foreman.db', 'state.json', 'secrets.bin'] as const
/** Starts of the new version, one after another, before the service gives up on it. */
export const MAX_TRIES = 3
/** A try that hasn't started serving in this long has hung: it fails like one that threw. */
export const TRIAL_TIMEOUT_MS = 10 * 60_000
// The new version starts a minute or two after the snapshot. A snapshot older than this when the new version first
// starts is from an install that never happened: the data has moved on since, so it is thrown away, never put back.
const FIRST_START_MS = 30 * 60_000
/** On the command line of a start after a failed try: not someone opening Foreman, so it doesn't earn fresh tries. */
export const RETRY_FLAG = '--update-retry'

export interface UpdateTrial {
  // The version that took the snapshot, and the one being installed.
  from: string
  to: string
  // When the snapshot was taken.
  at: number
  // The SNAPSHOT_FILES that existed and were copied.
  files: string[]
  // Starts of `to` since the snapshot.
  tries: number
  // A try began since the data was last put back: the data folder may hold what `to` half did.
  dirty: boolean
  // Why the last try failed.
  error?: string
}

export interface UpdateOutcome {
  from: string
  to: string
  at: number
  // Kept: the new version opened the data and served. Rolled back: it didn't, and the data is as `from` left it.
  outcome: 'kept' | 'rolled-back'
  tries: number
  error?: string
}

export function parseRetry(argv: readonly string[]): boolean {
  return argv.slice(1).includes(RETRY_FLAG)
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The trial note, or null when there is none or it doesn't add up (a trial that can't be read is never acted on). */
export function parseTrial(text: string | null): UpdateTrial | null {
  if (!text) return null
  try {
    const t = JSON.parse(text) as Partial<UpdateTrial>
    if (!isString(t.from) || !isString(t.to) || !isNumber(t.at) || !isNumber(t.tries) || typeof t.dirty !== 'boolean' || !Array.isArray(t.files)) return null
    const files = t.files.filter((f): f is string => (SNAPSHOT_FILES as readonly string[]).includes(f as string))
    return { from: t.from, to: t.to, at: t.at, files, tries: t.tries, dirty: t.dirty, ...(isString(t.error) ? { error: t.error } : {}) }
  } catch {
    return null
  }
}

export function parseOutcome(text: string | null): UpdateOutcome | null {
  if (!text) return null
  try {
    const o = JSON.parse(text) as Partial<UpdateOutcome>
    if (!isString(o.from) || !isString(o.to) || !isNumber(o.at) || !isNumber(o.tries) || (o.outcome !== 'kept' && o.outcome !== 'rolled-back')) return null
    return { from: o.from, to: o.to, at: o.at, outcome: o.outcome, tries: o.tries, ...(isString(o.error) ? { error: o.error } : {}) }
  } catch {
    return null
  }
}

export type TrialStep =
  // No trial: start as usual. After a trial that ended here, with the data put back first when the new version touched it.
  | { action: 'start'; restore: boolean; outcome?: UpdateOutcome }
  // This version is on trial: put the data back first when an earlier try didn't finish, then try.
  | { action: 'try'; restore: boolean; trial: UpdateTrial }
  // This version failed every try: put the data back and stop.
  | { action: 'stop'; restore: boolean; trial: UpdateTrial; outcome: UpdateOutcome }

const rolledBack = (t: UpdateTrial, now: number): UpdateOutcome => ({ from: t.from, to: t.to, at: now, outcome: 'rolled-back', tries: t.tries, ...(t.error ? { error: t.error } : {}) })

/**
 * What a start does about a trial. `human`: someone opened Foreman (not the service, nor a start after a failed try),
 * which gives a version that used up its tries a fresh set, as they asked for it; the service never does, so a broken
 * version doesn't start and fail at every login.
 */
export function trialStep(trial: UpdateTrial | null, f: { version: string; human: boolean; now: number }): TrialStep {
  if (!trial) return { action: 'start', restore: false }
  // Another version is starting: the install failed and the old one is back, or someone installed a version by hand.
  // The data goes back if the new version touched it; either way the trial is over.
  if (trial.to !== f.version) return { action: 'start', restore: trial.dirty, ...(trial.tries > 0 ? { outcome: rolledBack(trial, f.now) } : {}) }
  // The new version's first start, long after the snapshot: the update was installed some other way, later.
  if (trial.tries === 0 && f.now - trial.at > FIRST_START_MS) return { action: 'start', restore: false }
  const restore = trial.dirty
  if (trial.tries >= MAX_TRIES && !f.human) return { action: 'stop', restore, trial: { ...trial, dirty: false }, outcome: rolledBack(trial, f.now) }
  const tries = trial.tries >= MAX_TRIES ? 1 : trial.tries + 1
  return { action: 'try', restore, trial: { ...trial, tries, dirty: true } }
}

/** The new version opened the data and is serving: the update stays. */
export function keptOutcome(trial: UpdateTrial, now: number): UpdateOutcome {
  return { from: trial.from, to: trial.to, at: now, outcome: 'kept', tries: trial.tries }
}

// ---------------------------------------------------------------------------------------------------------------------
// The files. Each takes the data folder; nothing here opens foreman.db.

const snapshotDir = (dataDir: string) => path.join(dataDir, SNAPSHOT_DIR)
const trialFile = (dataDir: string) => path.join(snapshotDir(dataDir), TRIAL_FILE)

/** Write a file whole or not at all: a half-written note or data file is never read. */
function writeWhole(file: string, data: string): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, data)
  renameSyncWithRetry(tmp, file)
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function readTrial(dataDir: string): UpdateTrial | null {
  return parseTrial(readText(trialFile(dataDir)))
}

export function writeTrial(dataDir: string, trial: UpdateTrial): void {
  writeWhole(trialFile(dataDir), JSON.stringify(trial))
}

export function readOutcome(dataDir: string): UpdateOutcome | null {
  return parseOutcome(readText(path.join(dataDir, OUTCOME_FILE)))
}

export function writeOutcome(dataDir: string, outcome: UpdateOutcome): void {
  writeWhole(path.join(dataDir, OUTCOME_FILE), JSON.stringify(outcome))
}

/** The snapshot and its note go: after the update was kept, or once a trial is over. */
export function endTrial(dataDir: string): void {
  rmSync(snapshotDir(dataDir), { recursive: true, force: true })
}

/**
 * Copy the data aside before installing `to`, replacing any earlier copy. `copyDb` writes a consistent copy of
 * foreman.db to the file it is given (ForemanDb.backupTo, safe while Foreman writes). The note is written last, so a
 * copy that didn't finish has none and is never put back. Throws, leaving no snapshot, when it can't be made.
 */
export function takeSnapshot(dataDir: string, f: { from: string; to: string; now: number; copyDb: (file: string) => void }): UpdateTrial {
  const dir = snapshotDir(dataDir)
  endTrial(dataDir)
  try {
    mkdirSync(dir, { recursive: true })
    const files: string[] = []
    for (const name of SNAPSHOT_FILES) {
      const source = path.join(dataDir, name)
      if (!existsSync(source)) continue
      if (name === 'foreman.db') f.copyDb(path.join(dir, name))
      else copyFileSync(source, path.join(dir, name))
      files.push(name)
    }
    const trial: UpdateTrial = { from: f.from, to: f.to, at: f.now, files, tries: 0, dirty: false }
    writeTrial(dataDir, trial)
    return trial
  } catch (err) {
    endTrial(dataDir)
    throw err
  }
}

/**
 * Put the copied data back over the data folder's. foreman.db's write-ahead log goes first: a log left beside the copy
 * would be replayed into it. Each file is copied in beside its original and then moved over it, so a file is only ever
 * the old one or the copy. Throws when it can't, and the trial stays dirty, so the next start tries again.
 */
export function restoreSnapshot(dataDir: string, trial: UpdateTrial): void {
  const dir = snapshotDir(dataDir)
  for (const name of trial.files) {
    const target = path.join(dataDir, name)
    const tmp = `${target}.restore.tmp`
    copyFileSync(path.join(dir, name), tmp)
    if (name === 'foreman.db') {
      rmSync(`${target}-wal`, { force: true })
      rmSync(`${target}-shm`, { force: true })
    }
    renameSyncWithRetry(tmp, target)
  }
}

export interface TrialStart {
  step: TrialStep
  // The trial this start is on, while it lasts; absent for 'start'.
  trial?: UpdateTrial
}

/**
 * At startup, after the single-instance lock and before anything opens the data: do what trialStep says. Throws when
 * the data couldn't be put back, and then nothing may open it.
 */
export function startTrial(dataDir: string, f: { version: string; human: boolean; now: number }): TrialStart {
  const trial = readTrial(dataDir)
  const step = trialStep(trial, f)
  if (trial && step.restore) {
    restoreSnapshot(dataDir, trial)
    // Put back: until the next try begins, nothing here is the new version's.
    writeTrial(dataDir, { ...trial, dirty: false })
  }
  if (step.action === 'start') {
    if (step.outcome) writeOutcome(dataDir, step.outcome)
    // A note that couldn't be read, or a copy with none, is from a snapshot that never finished: it goes too.
    if (trial || existsSync(snapshotDir(dataDir))) endTrial(dataDir)
    return { step }
  }
  writeTrial(dataDir, step.trial)
  if (step.action === 'stop') writeOutcome(dataDir, step.outcome)
  return { step, trial: step.trial }
}

/** The try failed: note why, for the outcome. The caller then starts Foreman again with RETRY_FLAG and exits. */
export function failTrial(dataDir: string, trial: UpdateTrial, error: string): void {
  writeTrial(dataDir, { ...readTrial(dataDir) ?? trial, error })
}

/** The try opened the data and is serving: the update stays, and the copy goes. */
export function commitTrial(dataDir: string, trial: UpdateTrial, now: number): UpdateOutcome {
  // The note first: once it is gone nothing puts the data back, whatever becomes of the rest.
  rmSync(trialFile(dataDir), { force: true })
  const outcome = keptOutcome(trial, now)
  writeOutcome(dataDir, outcome)
  endTrial(dataDir)
  return outcome
}
