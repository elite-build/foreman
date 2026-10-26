import { waitFor } from './helpers'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import { cancel, findWorkspace, send } from '../src/main/cliServer'
import { defaultSettings } from '../src/main/store'
import { sendReceiptText, tabListText, tabModelText } from '../src/shared/tabs'
import type { Repo, SendOptions, SendReceipt, Session, TurnStatus, Workspace } from '../src/shared/types'
import { stubHost } from './cliHost'
import { fakeDriver, gate, setupSessions } from './sessionHarness'

afterEach(() => registerDriver(claudeDriver))

const ws = (patch: Partial<Workspace> = {}): Workspace => ({ id: 'ws1', repoId: 'r', name: 'lisbon', branch: 'fix-login', state: 'ready', path: '/x', ...patch }) as Workspace
const tab = (id: string, patch: Partial<Session> = {}): Session =>
  ({ id, workspaceId: 'ws1', agent: 'claude', model: 'claude-opus-5-5[1m]', status: 'idle', queue: [], fastMode: false, planMode: false, ...patch }) as Session
const repo = { id: 'r', name: 'app', rootPath: '/app' } as Repo
const templates = [
  { id: 'default-review', name: 'Review my changes', body: 'Review the uncommitted changes.' },
  { id: 'fix', name: 'Fix a bug', body: 'Fix this bug: {{what}}' }
]

function hostFor(workspaces: Workspace[], sessions: Session[], receipt: SendReceipt = { disposition: 'queued', turnId: 'turn-1' }) {
  const sent: { sessionId: string; text: string; options: SendOptions }[] = []
  const host = stubHost({
    state: () => ({ repos: [repo], workspaces, sessions, settings: { ...defaultSettings(), promptTemplates: templates } }),
    deliver: async (sessionId, text, options) => (sent.push({ sessionId, text, options }), receipt)
  })
  return { host, sent }
}
const params = (args: string[], extra: { workspace?: string; tab?: number } = {}) => ({ workspace: 'lisbon', args, cwd: '/elsewhere', ...extra })

describe('tab words', () => {
  it('names the agent family and model, and the receipt', () => {
    expect(tabModelText(tab('a'))).toBe('Claude · Opus 5.5')
    expect(sendReceiptText('queued', 2, tab('a'), 'abc')).toBe('Queued to tab 2 (Claude · Opus 5.5) as turn abc')
    expect(sendReceiptText('started', 1, tab('a'), 'abc')).toBe('Sent to tab 1 (Claude · Opus 5.5) as turn abc')
  })

  it('lists tabs by index, title, model and status', () => {
    const text = tabListText([tab('a', { title: 'Login bug' }), tab('b', { status: 'running', queue: [{} as never] })])
    expect(text.split('\n')).toEqual(['  1  Login bug  Claude · Opus 5.5  idle', '  2  New chat   Claude · Opus 5.5  running, 1 queued'])
  })
})

describe('finding the workspace', () => {
  const state = { repos: [repo], workspaces: [ws(), ws({ id: 'ws2', name: 'tokyo', branch: 'lisbon-branch' }), ws({ id: 'ws3', name: 'gone', state: 'archived' })] }
  it('matches id, then name, then branch, and ignores archived ones', () => {
    expect(findWorkspace(state, 'ws2', '/').name).toBe('tokyo')
    expect(findWorkspace(state, 'LISBON', '/').id).toBe('ws1')
    expect(findWorkspace(state, 'lisbon-branch', '/').id).toBe('ws2')
    expect(() => findWorkspace(state, 'gone', '/')).toThrow('No workspace named “gone”')
  })
  it('asks for the id when a name is ambiguous', () => {
    const twice = { repos: [repo], workspaces: [ws(), ws({ id: 'ws9' })] }
    expect(() => findWorkspace(twice, 'lisbon', '/')).toThrow('matches several workspaces: lisbon (app, id ws1); lisbon (app, id ws9)')
  })
})

describe('foreman send', () => {
  it('queues into the only open tab with a receipt, using an explicit target and never steering', async () => {
    const { host, sent } = hostFor([ws()], [tab('s1'), tab('closed', { closedAt: 'x' })])
    const result = await send(host, params(['please', 'add', 'tests']))
    expect(result).toMatchObject({ tab: 1, turn: 'turn-1', session: 's1', disposition: 'queued', message: 'Queued to tab 1 (Claude · Opus 5.5) as turn turn-1' })
    expect(sent).toEqual([{ sessionId: 's1', text: 'please add tests', options: { mode: 'queue', templateId: undefined, via: 'cli' } }])
  })

  it('refuses with several tabs and no --tab, listing them, and sends nothing', async () => {
    const { host, sent } = hostFor([ws()], [tab('s1', { title: 'One' }), tab('s2', { title: 'Two', model: 'claude-sonnet-5-5[1m]' })])
    await expect(send(host, params(['hi']))).rejects.toThrow(/2 open tabs\. Pick one with --tab <n>:\n {2}1 {2}One {2}Claude · Opus 5.5 {2,4}idle\n {2}2 {2}Two {2}Claude · Sonnet 5.5 {2}idle/)
    expect(sent).toEqual([])
  })

  it('uses --tab to pick one, and rejects a tab that does not exist', async () => {
    const { host, sent } = hostFor([ws()], [tab('s1'), tab('s2')], { disposition: 'queued', turnId: 'turn-2' })
    const result = await send(host, params(['hi'], { tab: 2 }))
    expect(result.message).toBe('Queued to tab 2 (Claude · Opus 5.5) as turn turn-2')
    expect(sent[0].sessionId).toBe('s2')
    await expect(send(host, params(['hi'], { tab: 3 }))).rejects.toThrow('has no tab 3')
  })

  it('says "Sent to" when an idle tab starts the turn at once', async () => {
    const { host } = hostFor([ws()], [tab('s1')], { disposition: 'started', turnId: 'turn-9' })
    expect((await send(host, params(['hi']))).message).toBe('Sent to tab 1 (Claude · Opus 5.5) as turn turn-9')
  })

  it('fills an exact template with values, and treats a fuzzy match as plain text', async () => {
    const { host, sent } = hostFor([ws()], [tab('s1')])
    await send(host, params(['review-my-changes']))
    await send(host, params(['fix a bug', 'login', 'is', 'broken']))
    await send(host, params(['review']))
    expect(sent.map((s) => [s.text, s.options.templateId])).toEqual([
      ['Review the uncommitted changes.', 'default-review'],
      ['Fix this bug: login is broken', 'fix'],
      ['review', undefined]
    ])
    await expect(send(host, params(['fixes']))).resolves.toBeDefined()
    await expect(send(host, params(['fix-a-bug']))).rejects.toThrow('Fix a bug: Missing a value for {{what}}')
  })

  it('refuses app commands, empty messages, held first messages and workspaces that are not ready', async () => {
    const { host, sent } = hostFor([ws()], [tab('s1')])
    await expect(send(host, params(['/clear']))).rejects.toThrow('/commands run in the app')
    await expect(send(host, params(['  ']))).rejects.toThrow('Say what to send')
    const held = hostFor([ws({ state: 'setup-failed', heldMessage: { sessionId: 's1', text: 'x', at: '' } })], [tab('s1')])
    await expect(send(held.host, params(['hi']))).rejects.toThrow('first message is held')
    const setting = hostFor([ws({ state: 'setting-up' })], [tab('s1')])
    await expect(send(setting.host, params(['hi']))).rejects.toThrow('isn’t ready yet')
    expect(sent).toEqual([])
    expect(held.sent).toEqual([])
  })

  it('does not report a handled message as a turn', async () => {
    const { host } = hostFor([ws()], [tab('s1')], { disposition: 'handled' })
    await expect(send(host, params(['hi']))).rejects.toThrow('no turn was started')
  })
})

describe('foreman cancel', () => {
  const status = (state: TurnStatus['state'], outcome?: TurnStatus['outcome']): TurnStatus => ({ workspaceId: 'ws1', sessionId: 's1', turnId: 't1', state, outcome })

  it('reports each case in words, and leaves an ended turn alone', async () => {
    const cancelled: string[] = []
    const make = (before: TurnStatus, after: TurnStatus | null) =>
      stubHost({
        state: () => ({ repos: [], workspaces: [ws()], sessions: [], settings: defaultSettings() }),
        turnStatus: async () => before,
        cancelTurn: async (id) => (cancelled.push(id), after)
      })
    expect(await cancel(make(status('queued'), status('ended', 'cancelled')), { turn: 't1' })).toMatchObject({ was: 'queued', outcome: 'cancelled', message: 'Cancelled turn t1 before it started (it was queued). Outcome: cancelled.' })
    expect(await cancel(make(status('running'), status('ended', 'cancelled')), { turn: 't1' })).toMatchObject({ was: 'running', message: 'Stopped turn t1. Outcome: cancelled.' })
    const done = await cancel(make(status('ended', 'completed'), null), { turn: 't1' })
    expect(done).toMatchObject({ was: 'ended', outcome: 'completed', message: 'Turn t1 had already ended (completed); nothing to cancel.' })
    expect(cancelled).toEqual(['t1', 't1'])
    await expect(cancel(stubHost({ turnStatus: async () => null }), { turn: 'zzz' })).rejects.toThrow('No turn with the id “zzz”')
  })
})

describe('cancelling turns in real sessions', () => {
  it('drops a queued turn by id without disturbing the running one', async () => {
    const { sessions, session } = await setupSessions()
    const running = gate()
    registerDriver(fakeDriver(running.script))
    const first = await sessions.deliver(session.id, 'first')
    const queued = await sessions.deliver(session.id, 'second', { mode: 'queue' })
    expect(queued).toMatchObject({ disposition: 'queued' })
    expect(session.queue.map((m) => m.turnId)).toEqual([queued.turnId])
    expect(await sessions.cancelTurn(queued.turnId!)).toMatchObject({ state: 'ended', outcome: 'cancelled' })
    expect(session.queue).toEqual([])
    expect(await sessions.turnStatus(first.turnId!)).toMatchObject({ state: 'running' })
    running.release()
  })

  it('stops a running turn and reads back the persisted outcome', async () => {
    const { sessions, session } = await setupSessions()
    registerDriver(fakeDriver(gate().script))
    const { turnId } = await sessions.deliver(session.id, 'go')
    expect(await sessions.cancelTurn(turnId!)).toMatchObject({ state: 'ended', outcome: 'cancelled' })
  })

  it('stops a turn that is still starting as soon as its agent exists', async () => {
    const { sessions, session } = await setupSessions()
    registerDriver(fakeDriver(gate().script))
    const pending = sessions.deliver(session.id, 'go')
    await waitFor(() => expect(session.turnId).toBeDefined())
    const result = await sessions.cancelTurn(session.turnId!)
    expect(result).toMatchObject({ state: 'ended', outcome: 'cancelled' })
    await pending
  })

  it('a queued message keeps its id when it starts, so the receipt stays valid', async () => {
    const { sessions, session, store } = await setupSessions()
    const first = gate()
    registerDriver(fakeDriver(first.script))
    await sessions.deliver(session.id, 'first')
    const queued = await sessions.deliver(session.id, 'second', { mode: 'queue' })
    first.release()
    await waitFor(async () => {
      const items = await store.readChat(session.id)
      expect(items.some((i) => i.kind === 'user' && i.turnId === queued.turnId)).toBe(true)
    })
  })

  it('leaves an ended turn as it was', async () => {
    const { sessions, session } = await setupSessions()
    registerDriver(fakeDriver(async (_r, cb) => cb.finished({ ok: true })))
    const { turnId } = await sessions.deliver(session.id, 'go')
    await waitFor(async () => expect((await sessions.turnStatus(turnId!))?.state).toBe('ended'))
    expect(await sessions.cancelTurn(turnId!)).toMatchObject({ state: 'ended', outcome: 'completed' })
  })
})
