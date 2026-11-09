import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { git } from '../src/main/git'
import { gitStatus, type PrResult } from '../src/main/github'
import type { PullRequestInfo, Workspace } from '../src/shared/types'
import { commit, makeRepo } from './helpers'

describe('the next step after the pull request merged', () => {
  it('offers Archive until work goes on after the merge, then a new pull request', async () => {
    const dir = await makeRepo()
    await git(dir, ['checkout', '-q', '-b', 'feat'])
    await commit(dir, 'work')
    const head = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()
    // Squash-merged: the base gets its own commit, the branch's stay outside it.
    await git(dir, ['checkout', '-q', 'main'])
    await commit(dir, 'work (#88)')
    await git(dir, ['checkout', '-q', 'feat'])

    const ws = { id: 'w1', path: dir, branch: 'feat', baseBranch: 'main' } as Workspace
    const pr = { number: 88, url: 'u', title: 't', state: 'MERGED', isDraft: false, mergeable: 'UNKNOWN', baseRefName: 'main', checks: [] } as PullRequestInfo
    const merged: PrResult = { kind: 'ok', pr, headRefOid: head, repo: 'acme/web' }
    const status = () => gitStatus(ws, true, undefined, 'origin', async () => merged, { available: async () => true })

    expect((await status()).primary.action).toBe('archive')
    // Bringing the base in isn't new work.
    await git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'merge', '-q', '--no-ff', '--no-edit', 'main'])
    expect(await status()).toMatchObject({ pr: { number: 88 }, primary: { action: 'archive' } })

    // An agent writing the next change in the same chat.
    await writeFile(path.join(dir, 'next.md'), 'more\n')
    expect(await status()).toMatchObject({ pr: undefined, primary: { action: 'create-pr' } })
    await rm(path.join(dir, 'next.md'))

    await commit(dir, 'next change')
    expect(await status()).toMatchObject({ pr: undefined, primary: { action: 'create-pr' } })
  })

  it('still offers Archive when a tracked file only changed its line endings', async () => {
    const dir = await makeRepo({ 'notes.md': 'one\ntwo\n' })
    // As a Windows checkout with autocrlf off sees a test run rewriting a snapshot with CRLF.
    await git(dir, ['config', 'core.autocrlf', 'false'])
    await git(dir, ['checkout', '-q', '-b', 'feat'])
    const head = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()

    const ws = { id: 'w1', path: dir, branch: 'feat', baseBranch: 'main' } as Workspace
    const pr = { number: 89, url: 'u', title: 't', state: 'MERGED', isDraft: false, mergeable: 'UNKNOWN', baseRefName: 'main', checks: [] } as PullRequestInfo
    const merged: PrResult = { kind: 'ok', pr, headRefOid: head, repo: 'acme/web' }
    const status = () => gitStatus(ws, true, undefined, 'origin', async () => merged, { available: async () => true })

    await writeFile(path.join(dir, 'notes.md'), 'one\r\ntwo\r\n')
    expect(await status()).toMatchObject({ uncommitted: 1, pr: { number: 89 }, primary: { action: 'archive' } })

    // A real edit to the same file is the next change.
    await writeFile(path.join(dir, 'notes.md'), 'one\r\ntwo\r\nthree\r\n')
    expect(await status()).toMatchObject({ pr: undefined, primary: { action: 'create-pr' } })
  })
})
