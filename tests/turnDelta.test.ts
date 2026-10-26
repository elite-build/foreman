import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { saveCheckpoint } from '../src/main/checkpoints'
import { checkpointDelta, endCheckpointId, startCheckpointId, turnDelta } from '../src/main/turnDelta'
import { makeRepo } from './helpers'

describe('turn delta', () => {
  it('diffs a turn start and end checkpoint', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\ntwo\nthree\n', 'keep.txt': 'same\n' })
    await writeFile(path.join(dir, 'earlier.txt'), 'edited before the turn\n')
    await saveCheckpoint(dir, startCheckpointId('s', 't'))

    await writeFile(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    await writeFile(path.join(dir, 'new.txt'), 'x\ny\n')
    await writeFile(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]))
    await saveCheckpoint(dir, endCheckpointId('s', 't'))

    const delta = await turnDelta(dir, 's', 't')
    expect(delta).not.toBe('unavailable')
    if (delta === 'unavailable') return
    // Work done before the turn is not counted.
    expect(delta.files.map((f) => f.path).sort()).toEqual(['a.txt', 'bin.dat', 'new.txt'])
    expect(delta.files.find((f) => f.path === 'a.txt')).toEqual({ path: 'a.txt', additions: 2, deletions: 1 })
    expect(delta.files.find((f) => f.path === 'bin.dat')).toEqual({ path: 'bin.dat', additions: 0, deletions: 0 })
    expect(delta).toMatchObject({ additions: 4, deletions: 1 })
  })

  it('reports an empty delta when the turn changed nothing', async () => {
    const dir = await makeRepo()
    await saveCheckpoint(dir, startCheckpointId('s', 't'))
    await saveCheckpoint(dir, endCheckpointId('s', 't'))
    expect(await turnDelta(dir, 's', 't')).toEqual({ files: [], additions: 0, deletions: 0 })
  })

  it('is unavailable, never clean, when a checkpoint is missing', async () => {
    const dir = await makeRepo()
    await saveCheckpoint(dir, startCheckpointId('s', 't'))
    expect(await turnDelta(dir, 's', 't')).toBe('unavailable')
    expect(await turnDelta(dir, 's', 'other')).toBe('unavailable')
    expect(await checkpointDelta(dir, 'nope-start', startCheckpointId('s', 't'))).toBe('unavailable')
  })

  it('is unavailable outside a repository', async () => {
    expect(await turnDelta(path.join(await makeRepo(), 'missing'), 's', 't')).toBe('unavailable')
  })
})
