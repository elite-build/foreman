import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { noGithubEnv } from '../src/main/github'
import { DAY_MS, FOREMAN_TEMP, STAGED_DIR, sweepForemanTemp, sweepTemp } from '../src/main/tempSweep'
import { RUN_TEMP_PREFIX } from './globalSetup'
import { tempDir } from './helpers'

const NOW = Date.now()

async function entry(dir: string, name: string, ageMs: number, file = false): Promise<void> {
  const full = path.join(dir, name)
  if (file) await writeFile(full, 'x')
  else {
    await mkdir(full, { recursive: true })
    await writeFile(path.join(full, 'index'), 'x')
  }
  const at = new Date(NOW - ageMs)
  await utimes(full, at, at)
}

describe('temp sweep', () => {
  it('deletes Foreman’s own temp folders a day old, and nothing else', async () => {
    const tmp = await tempDir()
    await entry(tmp, 'switchyard-index-Ab12cd', 2 * DAY_MS)
    await entry(tmp, 'foreman-bundle-Zz9Yy8', 2 * DAY_MS)
    await entry(tmp, 'foreman-memory-msg-q1w2e3', 2 * DAY_MS)
    await entry(tmp, 'foreman-no-github-000000', 2 * DAY_MS)
    // Still in use: younger than a day.
    await entry(tmp, 'switchyard-index-young1', 60_000)
    // Not Foreman's mkdtemp folders: other apps', stable names and sockets.
    await entry(tmp, 'switchyard-test-abc123', 2 * DAY_MS)
    await entry(tmp, 'foreman-agent-runtime', 2 * DAY_MS)
    await entry(tmp, 'foreman-index-abc123', 2 * DAY_MS)
    await entry(tmp, 'switchyard-index-toolong1', 2 * DAY_MS)
    await entry(tmp, 'foreman-0123456789ab.sock', 2 * DAY_MS, true)

    expect(await sweepTemp({ dir: tmp, match: FOREMAN_TEMP, olderThanMs: DAY_MS, now: NOW })).toBe(4)
    expect((await readdir(tmp)).sort()).toEqual(['foreman-0123456789ab.sock', 'foreman-agent-runtime', 'foreman-index-abc123', 'switchyard-index-toolong1', 'switchyard-index-young1', 'switchyard-test-abc123'])
  })

  it('deletes pasted files left waiting a day, and keeps the staging folder', async () => {
    const tmp = await tempDir()
    const staged = path.join(tmp, STAGED_DIR)
    await entry(staged, 'deadbeef', 2 * DAY_MS)
    await entry(staged, 'cafef00d', 60_000)
    await entry(tmp, 'foreman-picked-a1b2c3', 2 * DAY_MS)

    expect(await sweepForemanTemp(tmp, NOW)).toBe(2)
    expect(await readdir(staged)).toEqual(['cafef00d'])
    expect(await readdir(tmp)).toEqual([STAGED_DIR])
  })

  it('finds nothing to do in a folder that isn’t there', async () => {
    const tmp = await tempDir()
    expect(await sweepForemanTemp(path.join(tmp, 'missing'), NOW)).toBe(0)
  })

  it('makes the empty GitHub config folder again when a sweep took it', async () => {
    const first = noGithubEnv().GH_CONFIG_DIR
    expect(existsSync(first)).toBe(true)
    expect(noGithubEnv().GH_CONFIG_DIR).toBe(first)
    await rm(first, { recursive: true, force: true })
    const second = noGithubEnv().GH_CONFIG_DIR
    expect(second).not.toBe(first)
    expect(existsSync(second)).toBe(true)
  })

  it('gives each test file a temp folder of its own (tests/setup.ts)', () => {
    expect(path.basename(os.tmpdir())).toMatch(new RegExp(`^${RUN_TEMP_PREFIX}[A-Za-z0-9]{6}$`))
  })
})
