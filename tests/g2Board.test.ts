// G2 backlog, #21 board: keyboard lane moves, the drop toast's Undo (the toast action API), clearing a
// status, and GitHub approver names from `gh pr view --json reviews`.
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { keyboardLane, moveChanges, prFacts } from '../src/shared/board'
import { approversFrom } from '../src/main/github'
import { Environment } from '../src/main/environment'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { WorkspaceService } from '../src/main/workspaces'
import type { Triage } from '../src/shared/triage'
import type { PullRequestInfo, Workspace } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'

const card = (status?: Workspace['status']) => ({ ws: { id: 'w', status } }) as unknown as Triage

describe('moving a focused card with Alt+← / Alt+→', () => {
  it('goes to the nearest lane that takes cards that way', () => {
    expect(keyboardLane('needs-you', 1)).toBe('in-review')
    expect(keyboardLane('working', 1)).toBe('in-review')
    expect(keyboardLane('in-review', 1)).toBe('done')
    expect(keyboardLane('ready', 1)).toBe('done')
    expect(keyboardLane('ready', -1)).toBe('in-review')
    expect(keyboardLane('done', -1)).toBe('in-review')
    // Nothing that way: Needs you and Working come from live facts.
    expect(keyboardLane('in-review', -1)).toBeNull()
    expect(keyboardLane('done', 1)).toBeNull()
  })

  it('does nothing when the status is already the lane’s', () => {
    expect(moveChanges(card('done'), 'done', 'done')).toBe(false)
    expect(moveChanges(card('in-review'), 'in-review', 'done')).toBe(true)
    // A card shown in Ready with the status Done set elsewhere still moves.
    expect(moveChanges(card('done'), 'ready', 'done')).toBe(true)
    expect(moveChanges(card(), 'working', 'ready')).toBe(false)
  })
})

describe('GitHub approvers', () => {
  const review = (login: string, state: string) => ({ author: { login }, state })

  it('counts each reviewer’s latest decision; comments don’t change it', () => {
    expect(approversFrom([review('ana', 'APPROVED'), review('bo', 'COMMENTED'), review('cy', 'CHANGES_REQUESTED')])).toEqual(['ana'])
    expect(approversFrom([review('ana', 'APPROVED'), review('ana', 'COMMENTED')])).toEqual(['ana'])
    expect(approversFrom([review('ana', 'APPROVED'), review('ana', 'CHANGES_REQUESTED')])).toEqual([])
    expect(approversFrom([review('ana', 'CHANGES_REQUESTED'), review('bo', 'APPROVED'), review('ana', 'APPROVED')])).toEqual(['bo', 'ana'])
    expect(approversFrom([review('ana', 'APPROVED'), review('ana', 'DISMISSED')])).toEqual([])
    expect(approversFrom(undefined)).toEqual([])
    expect(approversFrom([{ state: 'APPROVED' }, null])).toEqual([])
  })

  it('names them on the board’s facts, only when approved', () => {
    const pr = { number: 1, url: 'u', title: 't', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', baseRefName: 'main', checks: [], reviewDecision: 'APPROVED', approvedBy: ['ana'] } as PullRequestInfo
    expect(prFacts(pr, 'now').approvedBy).toEqual(['ana'])
    expect(prFacts({ ...pr, reviewDecision: 'REVIEW_REQUIRED' }, 'now').approvedBy).toBeUndefined()
    // GitLab's own list wins when it has one.
    expect(prFacts({ ...pr, approvals: { given: 1, required: 1, by: ['mk'] } }, 'now').approvedBy).toEqual(['mk'])
  })
})

describe('Undo puts the status back, including none', () => {
  it('clears the status with null and records when it changed', async () => {
    const dataDir = await tempDir('foreman-g2-board-')
    const store = new Store(dataDir)
    await store.load()
    store.state.settings.workspacesRoot = await tempDir('foreman-g2-board-ws-')
    store.state.settings.branchPrefixType = 'none'
    const secrets = new SecretStore(path.join(dataDir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
    const environment = new Environment(secrets, () => store.state.settings, (id) => workspaces.repo(id))
    const workspaces: WorkspaceService = new WorkspaceService(store, { changed() {}, setupLog() {} }, environment)
    const repo = await workspaces.addRepo(await makeRepo({ 'README.md': 'hi\n' }))
    const ws = await workspaces.createWorkspace(repo.id, {})
    workspaces.updateWorkspace(ws.id, { status: 'done' })
    expect(workspaces.workspace(ws.id)).toMatchObject({ status: 'done' })
    const setAt = workspaces.workspace(ws.id).statusAt
    expect(setAt).toBeTruthy()
    workspaces.updateWorkspace(ws.id, { status: null })
    expect(workspaces.workspace(ws.id).status).toBeUndefined()
    expect('status' in workspaces.workspace(ws.id)).toBe(false)
    // undefined leaves it alone.
    workspaces.updateWorkspace(ws.id, { status: 'in-review' })
    workspaces.updateWorkspace(ws.id, { name: 'x' })
    expect(workspaces.workspace(ws.id).status).toBe('in-review')
  })
})

describe('toast actions', () => {
  let store: typeof import('../src/renderer/src/store')
  beforeAll(async () => {
    vi.stubGlobal('window', { foreman: { invoke: {}, send: {}, onEvent() {} }, confirm: () => true, addEventListener() {}, dispatchEvent() {} })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} })
    vi.stubGlobal('document', { hasFocus: () => true })
    store = await import('../src/renderer/src/store')
  })

  it('keeps plain toasts as they were, and gives one with a button longer', () => {
    expect(store.makeToast(1, 'hi', 'info')).toEqual({ toast: { id: 1, text: 'hi', kind: 'info' }, durationMs: 6000 })
    const run = () => undefined
    const made = store.makeToast(2, 'Set', 'info', { action: { label: 'Undo', run } })
    expect(made.toast.actions).toEqual([{ label: 'Undo', run }])
    expect(made.durationMs).toBe(10_000)
    const several = store.makeToast(3, 'x', 'error', { action: { label: 'A', run }, actions: [{ label: 'B', run }], durationMs: 3000 })
    expect(several.toast.actions?.map((a) => a.label)).toEqual(['A', 'B'])
    expect(several.durationMs).toBe(3000)
  })

  it('runs the button once, dismissing the toast; a stale id does nothing', async () => {
    let ran = 0
    store.showToast('Status set to Done.', 'info', { action: { label: 'Undo', run: () => void ran++ } })
    const id = store.getState().toast!.id
    store.runToastAction(id + 1, 0)
    expect(ran).toBe(0)
    store.runToastAction(id, 0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ran).toBe(1)
    expect(store.getState().toast).toBeNull()
    store.runToastAction(id, 0)
    expect(ran).toBe(1)
  })

  it('shows a failing action as an error toast', async () => {
    store.showToast('x', 'info', {
      action: {
        label: 'Undo',
        run: async () => {
          throw new Error('Could not undo')
        }
      }
    })
    store.runToastAction(store.getState().toast!.id, 0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getState().toast).toMatchObject({ kind: 'error', text: 'Could not undo' })
  })
})
