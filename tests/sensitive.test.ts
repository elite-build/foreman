import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { saveCheckpoint } from '../src/main/checkpoints'
import { refsDiff } from '../src/main/diff'
import { endCheckpointId, sensitiveAlert, startCheckpointId } from '../src/main/turnDelta'
import { alertsAfterRewind, globToRegExp, sensitiveMatches } from '../src/shared/sensitive'
import type { SensitiveAlert } from '../src/shared/types'
import { makeRepo } from './helpers'

describe('sensitive globs', () => {
  it('matches gitignore-style patterns', () => {
    const paths = ['.env', '.env.local', 'app/.env', 'db/migrations/001.sql', 'migrations/x.sql', 'package-lock.json', 'web/package-lock.json', 'src/a.ts', 'envfile']
    expect(sensitiveMatches(paths, ['.env*'])).toEqual(['.env', '.env.local', 'app/.env'])
    expect(sensitiveMatches(paths, ['**/migrations/**'])).toEqual(['db/migrations/001.sql', 'migrations/x.sql'])
    expect(sensitiveMatches(paths, ['/package-lock.json'])).toEqual(['package-lock.json'])
    expect(sensitiveMatches(paths, ['src/*.ts'])).toEqual(['src/a.ts'])
    expect(sensitiveMatches(paths, ['migrations/'])).toEqual(['db/migrations/001.sql', 'migrations/x.sql'])
    expect(globToRegExp('a?.txt').test('ab.txt')).toBe(true)
    expect(sensitiveMatches(paths, [])).toEqual([])
  })
})

describe('sensitive alert', () => {
  it('lists the matching files from the whole worktree between the turn checkpoints', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n' })
    await saveCheckpoint(dir, startCheckpointId('s', 't'))
    // The agent edits one file; another tab (or the user) writes a sensitive one meanwhile.
    await writeFile(path.join(dir, 'a.txt'), 'two\n')
    await writeFile(path.join(dir, '.env'), 'KEY=1\n')
    await saveCheckpoint(dir, endCheckpointId('s', 't'))
    const alert = await sensitiveAlert(dir, 's', 't', ['.env*'])
    expect(alert).toMatchObject({ sessionId: 's', turnId: 't', files: ['.env'], startRef: expect.stringContaining('s-t-start'), endRef: expect.stringContaining('s-t-end') })
    const diff = await refsDiff(dir, alert!.startRef, alert!.endRef, alert!.files)
    expect(diff.files.map((f) => f.path)).toEqual(['.env'])
  })

  it('counts net changes only', async () => {
    const dir = await makeRepo({ '.env': 'A=1\n' })
    await saveCheckpoint(dir, startCheckpointId('s', 't'))
    await writeFile(path.join(dir, '.env'), 'A=2\n')
    await writeFile(path.join(dir, '.env'), 'A=1\n')
    await saveCheckpoint(dir, endCheckpointId('s', 't'))
    expect(await sensitiveAlert(dir, 's', 't', ['.env'])).toBeNull()
  })

  it('skips gitignored files', async () => {
    const dir = await makeRepo({ '.gitignore': 'secret/\n' })
    await saveCheckpoint(dir, startCheckpointId('s', 't'))
    await mkdir(path.join(dir, 'secret'))
    await writeFile(path.join(dir, 'secret', 'k.txt'), 'x\n')
    await saveCheckpoint(dir, endCheckpointId('s', 't'))
    expect(await sensitiveAlert(dir, 's', 't', ['secret/**'])).toBeNull()
  })

  it('is unavailable, never clean, when a checkpoint is missing', async () => {
    const dir = await makeRepo()
    await saveCheckpoint(dir, startCheckpointId('s', 't'))
    expect(await sensitiveAlert(dir, 's', 't', ['.env*'])).toMatchObject({ unavailable: true, files: [] })
    const noStart = await makeRepo()
    await saveCheckpoint(noStart, endCheckpointId('s', 't'))
    expect(await sensitiveAlert(noStart, 's', 't', ['.env*'])).toMatchObject({ unavailable: true })
  })

  it('does nothing when the list is empty', async () => {
    const dir = await makeRepo()
    expect(await sensitiveAlert(dir, 's', 't', [])).toBeNull()
    expect(await sensitiveAlert(dir, 's', 't', ['  '])).toBeNull()
  })
})

describe('rewind', () => {
  const alert = (id: string, sessionId: string, turnId: string, at: string): SensitiveAlert => ({ id, sessionId, turnId, startRef: '', endRef: '', files: ['x'], at })
  it('clears only alerts raised after the restored point', () => {
    const alerts = [alert('old', 's1', 't1', '2026-01-01T10:00:00Z'), alert('new', 's1', 't2', '2026-01-01T12:00:00Z'), alert('other-old', 's2', 'u1', '2026-01-01T09:00:00Z'), alert('other-new', 's2', 'u2', '2026-01-01T13:00:00Z')]
    const kept = alertsAfterRewind(alerts, { sessionId: 's1', keptTurnIds: new Set(['t1']), at: '2026-01-01T11:00:00Z' })
    expect(kept.map((a) => a.id)).toEqual(['old', 'other-old'])
  })
})
