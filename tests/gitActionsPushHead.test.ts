// A held push or pull request (docs/ai-employees.md §9) sends exactly the commit its preview showed: commits the agent
// made after a person saw it stay on this computer, with real git and a bare remote.
import { describe, expect, it } from 'vitest'
import { git, gitOut } from '../src/main/git'
import { GitActions } from '../src/main/gitActions'
import type { Workspace } from '../src/shared/types'
import { commit, makeRepo, tempDir } from './helpers'

async function setup() {
  const remote = await tempDir()
  await git(remote, ['init', '-q', '--bare'])
  const dir = await makeRepo()
  await git(dir, ['remote', 'add', 'origin', remote])
  await git(dir, ['checkout', '-q', '-b', 'max/launch'])
  const ws = { id: 'w1', repoId: 'r1', path: dir, branch: 'max/launch', baseBranch: 'main' } as Workspace
  const repo = { id: 'r1', rootPath: dir, hasOrigin: true, remote: 'origin' }
  const workspaces = { workspace: () => ws, repo: () => repo, accountFor: () => undefined, accountForFresh: async () => undefined }
  const scm = async () => ({ provider: { kind: 'gitlab' } })
  const actions = new GitActions({} as never, workspaces as never, {} as never, async () => {}, { invalidate: () => {} } as never, scm as never)
  return { dir, remote, actions }
}

describe('a held push', () => {
  it('pushes the previewed commit as the branch, not commits made since', async () => {
    const { dir, remote, actions } = await setup()
    await commit(dir, 'Write the launch post')
    const seen = (await gitOut(dir, ['rev-parse', 'HEAD'])).trim()
    await commit(dir, 'Made after the preview')
    await actions.pushBranch('w1', seen)
    expect((await gitOut(remote, ['rev-parse', 'refs/heads/max/launch'])).trim()).toBe(seen)
    expect((await gitOut(dir, ['rev-parse', '--abbrev-ref', 'max/launch@{upstream}'])).trim()).toBe('origin/max/launch')
  })

  it('without a recorded commit pushes the branch as it is, as the panel’s Push does', async () => {
    const { dir, remote, actions } = await setup()
    await commit(dir, 'Write the launch post')
    await actions.pushBranch('w1')
    expect((await gitOut(remote, ['rev-parse', 'refs/heads/max/launch'])).trim()).toBe((await gitOut(dir, ['rev-parse', 'HEAD'])).trim())
  })
})
