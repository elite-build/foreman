// The Get started checklist's logic and storage: what each item shows, the migration that keeps it from opening for
// people who already use Foreman, and recording a milestone (idempotent, first time stands, never blocks the action).
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { SecretStore } from '../src/main/secrets'
import { defaultSettings, Store } from '../src/main/store'
import type { AssistantGate } from '../src/shared/assistant'
import {
  assistantNeedsClaude,
  checklistShown,
  defaultOnboarding,
  deriveChecklist,
  migrateOnboarding,
  ONBOARDING_MILESTONES,
  withMilestone,
  type ChecklistInput,
  type ChecklistItemId,
  type OnboardingState
} from '../src/shared/onboarding'
import { SETTINGS_SCHEMA, STRUCTURED_SETTINGS } from '../src/shared/settingsSchema'
import type { MainEvent } from '../src/shared/types'
import { tempDir } from './helpers'

afterEach(() => vi.restoreAllMocks())

const READY = { ready: true, evidenceKey: 'agentReadiness.accountFound' } as const
const SIGNED_OUT = { ready: false, evidenceKey: 'agentReadiness.notSignedIn' } as const
const ready: AssistantGate = { state: 'ready', agent: 'claude', model: 'opus' }

function input(patch: Partial<ChecklistInput> = {}): ChecklistInput {
  return { onboarding: defaultOnboarding(), repoCount: 0, workspaceCount: 0, agent: null, assistantGate: ready, ...patch }
}
const statuses = (patch?: Partial<ChecklistInput>) => Object.fromEntries(deriveChecklist(input(patch)).items.map((i) => [i.id, i.status])) as Record<ChecklistItemId, string>
const reached = (...ids: (typeof ONBOARDING_MILESTONES)[number][]): OnboardingState => ({ milestones: Object.fromEntries(ids.map((id) => [id, '2026-01-01T00:00:00.000Z'])), checklistHidden: false })

describe('checklist derivation', () => {
  it('lists the items in order, with the milestones and derived ones apart', () => {
    const { items } = deriveChecklist(input())
    expect(items.map((i) => i.id)).toEqual(['comfortable', 'agent', 'project', 'workspace', 'needsYou', 'tiles', 'template', 'automation', 'assistant', 'mcp'])
    expect(Object.fromEntries(items.map((i) => [i.id, i.kind]))).toMatchObject({ agent: 'live', project: 'derived', workspace: 'derived', comfortable: 'milestone', mcp: 'milestone' })
    expect(items.every((i) => i.status === 'todo')).toBe(true)
  })

  it('ticks a milestone once it has been reached', () => {
    expect(statuses({ onboarding: reached('comfortable', 'tiles') })).toMatchObject({ comfortable: 'done', tiles: 'done', needsYou: 'todo', mcp: 'todo' })
  })

  it('derives the project and workspace from what exists', () => {
    expect(statuses({ repoCount: 1, workspaceCount: 0 })).toMatchObject({ project: 'done', workspace: 'todo' })
    expect(statuses({ repoCount: 2, workspaceCount: 3 })).toMatchObject({ project: 'done', workspace: 'done' })
    // Removing them takes the tick away: they are not remembered.
    expect(statuses({ repoCount: 0, workspaceCount: 0 })).toMatchObject({ project: 'todo', workspace: 'todo' })
  })

  it('reads the default agent live: done, then back to needs attention when its sign-in lapses', () => {
    expect(statuses({ agent: READY }).agent).toBe('done')
    expect(statuses({ agent: SIGNED_OUT }).agent).toBe('attention')
    expect(statuses({ agent: { ready: false, evidenceKey: 'agentReadiness.noKey' } }).agent).toBe('attention')
    // Still being asked is not a problem yet.
    expect(statuses({ agent: { ready: false, evidenceKey: 'agentReadiness.checking' } }).agent).toBe('todo')
    expect(statuses({ agent: undefined }).agent).toBe('todo')
  })

  it('says the assistant needs Claude while it cannot run', () => {
    for (const gate of [{ state: 'none' }, { state: 'signed-out', agent: 'claude' }, { state: 'unsupported', agent: 'codex' }] as AssistantGate[]) {
      expect(assistantNeedsClaude(gate)).toBe(true)
      expect(statuses({ assistantGate: gate }).assistant).toBe('needs-claude')
    }
    // Claude is signed in and could be chosen for a thread: not blocked.
    expect(statuses({ assistantGate: { state: 'unsupported', agent: 'codex', alternative: 'claude' } }).assistant).toBe('todo')
    expect(statuses({ assistantGate: ready }).assistant).toBe('todo')
    expect(statuses({ assistantGate: { state: 'checking' } }).assistant).toBe('todo')
    expect(statuses({ assistantGate: undefined }).assistant).toBe('todo')
  })

  it('keeps the assistant done once it was used, even if Claude is signed out later', () => {
    expect(statuses({ onboarding: reached('assistant'), assistantGate: { state: 'signed-out', agent: 'claude' } }).assistant).toBe('done')
  })

  it('leaves the assistant off the list when the user turned it off or Privacy mode is on', () => {
    for (const gate of [{ state: 'off' }, { state: 'privacy' }] as AssistantGate[]) {
      const list = deriveChecklist(input({ assistantGate: gate }))
      expect(list.items.map((i) => i.id)).not.toContain('assistant')
      expect(list.total).toBe(9)
    }
  })

  it('is complete only when every tracked item is done, and Home shows the card until then or until it is hidden', () => {
    const all = reached(...ONBOARDING_MILESTONES)
    const done = deriveChecklist(input({ onboarding: all, repoCount: 1, workspaceCount: 1, agent: READY }))
    expect(done).toMatchObject({ done: 10, total: 10, complete: true })
    expect(checklistShown(all, done)).toBe(false)

    // The agent's sign-in lapsing brings the card back.
    const regressed = deriveChecklist(input({ onboarding: all, repoCount: 1, workspaceCount: 1, agent: SIGNED_OUT }))
    expect(regressed).toMatchObject({ done: 9, complete: false })
    expect(checklistShown(all, regressed)).toBe(true)

    const hidden = { ...all, checklistHidden: true }
    expect(checklistShown(hidden, regressed)).toBe(false)
    expect(checklistShown(defaultOnboarding(), deriveChecklist(input()))).toBe(true)
  })
})

describe('recording a milestone', () => {
  it('keeps the first time', () => {
    const first = withMilestone(defaultOnboarding(), 'tiles', '2026-01-01T00:00:00.000Z')
    expect(first.milestones.tiles).toBe('2026-01-01T00:00:00.000Z')
    const again = withMilestone(first, 'tiles', '2026-02-02T00:00:00.000Z')
    expect(again).toBe(first)
    expect(withMilestone(first, 'mcp', '2026-02-02T00:00:00.000Z').milestones).toEqual({ tiles: '2026-01-01T00:00:00.000Z', mcp: '2026-02-02T00:00:00.000Z' })
  })
})

describe('the settings shape', () => {
  it('starts a new install at not seen, nothing reached, checklist shown', () => {
    const settings = defaultSettings()
    expect(settings.onboardingSeen).toBe(false)
    expect(settings.onboarding).toEqual({ milestones: {}, checklistHidden: false })
    expect(defaultSettings().onboarding).not.toBe(settings.onboarding)
  })

  it('has a CLI key for the flag and names the checklist as a structured setting', () => {
    expect(SETTINGS_SCHEMA.find((s) => s.key === 'general.first-run-seen')).toMatchObject({ field: 'onboardingSeen', type: 'boolean' })
    expect(STRUCTURED_SETTINGS).toContain('onboarding')
  })
})

describe('migration', () => {
  const repo = (dir: string) => ({ id: 'r1', name: 'foreman', rootPath: dir, defaultBranch: 'main', remote: 'origin', hasOrigin: true, local: {}, createdAt: new Date().toISOString() })

  async function load(settings: Record<string, unknown>, repos: unknown[] = []) {
    const dir = await tempDir('foreman-onboarding-')
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 2, repos, settings }))
    const store = new Store(dir)
    await store.load()
    const { onboardingSeen, onboarding } = store.state.settings
    store.close()
    return { onboardingSeen, onboarding }
  }
  const older = () => {
    const { onboardingSeen: _a, onboarding: _b, ...rest } = defaultSettings()
    return rest
  }

  it('a new install gets the first run and the checklist', async () => {
    const dir = await tempDir('foreman-onboarding-')
    const store = new Store(dir)
    await store.load()
    expect(store.state.settings.onboardingSeen).toBe(false)
    expect(store.state.settings.onboarding).toEqual({ milestones: {}, checklistHidden: false })
    store.close()
  })

  it('someone upgrading with repositories never gets the first run, and the checklist stays away', async () => {
    const dir = await tempDir('foreman-onboarding-')
    expect(await load({ ...older(), tourSeen: false }, [repo(dir)])).toEqual({ onboardingSeen: true, onboarding: { milestones: {}, checklistHidden: true } })
  })

  it('someone upgrading who had finished the tour is treated the same', async () => {
    expect(await load({ ...older(), tourSeen: true })).toEqual({ onboardingSeen: true, onboarding: { milestones: {}, checklistHidden: true } })
  })

  it('someone upgrading who had added nothing and not seen the tour still gets the first run', async () => {
    expect(await load({ ...older(), tourSeen: false })).toEqual({ onboardingSeen: false, onboarding: { milestones: {}, checklistHidden: false } })
  })

  it('keeps what was saved, and drops what is not a milestone', async () => {
    const saved = { milestones: { tiles: '2026-01-01T00:00:00.000Z', bogus: '2026-01-01T00:00:00.000Z', mcp: 7 }, checklistHidden: false }
    expect(await load({ ...older(), tourSeen: true, onboardingSeen: false, onboarding: saved })).toEqual({
      onboardingSeen: false,
      onboarding: { milestones: { tiles: '2026-01-01T00:00:00.000Z' }, checklistHidden: false }
    })
  })

  it('migrateOnboarding treats junk as missing', () => {
    expect(migrateOnboarding({ onboardingSeen: 'yes', onboarding: [], established: true })).toEqual({ onboardingSeen: true, onboarding: { milestones: {}, checklistHidden: true } })
    expect(migrateOnboarding({ onboarding: null, established: false })).toEqual({ onboardingSeen: false, onboarding: defaultOnboarding() })
  })
})

describe('the API records milestones', () => {
  async function setup() {
    const dir = await tempDir('foreman-onboarding-core-')
    const store = new Store(dir)
    await store.load()
    vi.spyOn(store, 'save').mockImplementation(() => {})
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
    const events: MainEvent[] = []
    const core = new Core(store, secrets, {
      broadcast: (event: MainEvent) => events.push(event), applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
      openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
      metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
    })
    const milestones = () => store.state.settings.onboarding.milestones
    return { core, store, events, milestones }
  }

  it('records once, keeps the first time and tells the window only when something changed', async () => {
    const { core, events, milestones } = await setup()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-01T10:00:00.000Z'))
    await core.api.recordOnboardingMilestone('comfortable')
    expect(milestones()).toEqual({ comfortable: '2026-03-01T10:00:00.000Z' })
    const told = events.length
    expect(told).toBeGreaterThan(0)

    vi.setSystemTime(new Date('2026-03-05T10:00:00.000Z'))
    await core.api.recordOnboardingMilestone('comfortable')
    expect(milestones()).toEqual({ comfortable: '2026-03-01T10:00:00.000Z' })
    expect(events.length).toBe(told)
    vi.useRealTimers()
  })

  it('refuses an id that is not a milestone', async () => {
    const { core, milestones } = await setup()
    await expect(core.api.recordOnboardingMilestone('bogus' as never)).rejects.toThrow('Unknown milestone')
    expect(milestones()).toEqual({})
  })

  it('records Tiles whenever the window layout is switched to it, from any place', async () => {
    const { core, milestones } = await setup()
    await core.api.updateSettings({ windowLayout: 'panes' })
    expect(milestones().tiles).toBeUndefined()
    await core.api.updateSettings({ windowLayout: 'tiles' })
    expect(milestones().tiles).toBeTruthy()
  })

  it('records a template only when a message carrying one is sent', async () => {
    const { core, milestones } = await setup()
    const send = vi.spyOn(core.sessions, 'send').mockResolvedValue({ disposition: 'started', turnId: 't1' } as never)
    await core.api.sendMessage('s1', 'plain')
    await Promise.resolve()
    expect(milestones().template).toBeUndefined()
    await core.api.sendMessage('s1', 'from a template', { templateId: 'default-fix-issue' })
    await vi.waitFor(() => expect(milestones().template).toBeTruthy())
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not record a template when the send fails, and the failure still reaches the caller', async () => {
    const { core, milestones } = await setup()
    vi.spyOn(core.sessions, 'send').mockRejectedValue(new Error('no chat'))
    await expect(core.api.sendMessage('s1', 'x', { templateId: 'default-fix-issue' })).rejects.toThrow('no chat')
    await Promise.resolve()
    expect(milestones().template).toBeUndefined()
  })

  it('records an assistant message once it is accepted', async () => {
    const { core, milestones } = await setup()
    vi.spyOn(core.assistant, 'send').mockResolvedValue({ threadId: 't' })
    await core.api.assistantSend(null, 'how do I switch to tiles?')
    await vi.waitFor(() => expect(milestones().assistant).toBeTruthy())
  })

  it('does not lose milestones when the card is hidden and shown again', async () => {
    const { core, store, milestones } = await setup()
    await core.api.recordOnboardingMilestone('mcp')
    // A window holding an older copy hides the card: milestones recorded since stay.
    await core.api.updateSettings({ onboarding: { milestones: {}, checklistHidden: true } })
    expect(milestones().mcp).toBeTruthy()
    expect(store.state.settings.onboarding.checklistHidden).toBe(true)
    await core.api.updateSettings({ onboarding: { milestones: milestones(), checklistHidden: false } })
    expect(store.state.settings.onboarding.checklistHidden).toBe(false)
    // Junk is dropped.
    await core.api.updateSettings({ onboarding: { milestones: { nope: 'x' } as never, checklistHidden: false } })
    expect(Object.keys(milestones())).toEqual(['mcp'])
  })
})
