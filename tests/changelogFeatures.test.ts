import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core, type Host } from '../src/main/core'
import { fetchReviewThreads } from '../src/main/reviews'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { isWindows } from '../src/main/platform'
import type { GitStatus, MainEvent, PullRequestInfo, ReviewThread } from '../src/shared/types'
import { tempDir } from './helpers'

vi.mock('../src/main/reviews', async (original) => ({
  ...(await original<typeof import('../src/main/reviews')>()),
  fetchReviewThreads: vi.fn()
}))
afterEach(() => vi.restoreAllMocks())

const pr = { number: 12, title: 'Fix login', url: 'https://github.com/acme/app/pull/12' } as PullRequestInfo
const thread: ReviewThread = {
  id: 'thread',
  path: 'src/login.ts',
  line: 7,
  side: 'RIGHT',
  isResolved: false,
  isOutdated: false,
  comments: [
    {
      id: 'comment',
      author: 'reviewer',
      body: 'Handle the empty token',
      url: `${pr.url}#comment`,
      createdAt: '',
      updatedAt: '',
      diffHunk: '-old\n+new'
    }
  ]
}

async function setup() {
  const dir = await tempDir()
  const store = new Store(dir)
  await store.load()
  store.state.repos.push({
    id: 'repo',
    name: 'app',
    rootPath: dir,
    defaultBranch: 'main',
    remote: 'origin',
    hasOrigin: false,
    local: {},
    createdAt: ''
  })
  store.state.workspaces.push({
    id: 'ws',
    repoId: 'repo',
    name: 'naples',
    branch: 'feature',
    baseBranch: 'main',
    path: dir,
    portBase: 50030,
    state: 'ready',
    createdAt: ''
  })
  const events: MainEvent[] = []
  const host: Host = {
    broadcast: (event) => events.push(event),
    applyTheme() {},
    setBadge() {},
    setZoom() {},
    keepAwake() {},
    pickDirectory: async () => null,
    pickFiles: async () => [],
    pickPath: async () => null,
    openPath: async () => {},
    openExternal: async () => {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }),
    cliShim: () => ''
  }
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), {
    available: () => true,
    encrypt: (s) => Buffer.from(s),
    decrypt: (b) => b.toString()
  })
  const core = new Core(store, secrets, host)
  return { core, store, events }
}

describe('closed chat navigation', () => {
  it('reopens the requested chat instead of the most recently closed one', async () => {
    const { core } = await setup()
    const first = core.sessions.createSession('ws', { title: 'First' })
    const second = core.sessions.createSession('ws', { title: 'Second' })
    core.sessions.createSession('ws')
    await core.api.closeSession(first.id)
    await core.api.closeSession(second.id)
    const reopened = await core.api.reopenSession('ws', first.id)
    expect(reopened?.id).toBe(first.id)
    expect(second.closedAt).toBeDefined()
    await expect(core.api.reopenSession('another-workspace', second.id)).rejects.toThrow('another workspace')
    expect((await core.api.reopenSession('ws'))?.id).toBe(second.id)
  })
})

describe('review feedback delivery', () => {
  it('attaches selected threads with context and queues them to the selected chat', async () => {
    const { core } = await setup()
    const session = core.sessions.createSession('ws')
    vi.spyOn(core.git, 'status').mockResolvedValue({ pr } as GitStatus)
    vi.mocked(fetchReviewThreads).mockResolvedValue([thread, { ...thread, id: 'other' }])
    const send = vi.spyOn(core.sessions, 'send').mockResolvedValue('queued')
    expect(await core.api.sendReviewThreads('ws', ['thread'], session.id)).toBe(session.id)
    const [id, , options] = send.mock.calls[0]
    expect(id).toBe(session.id)
    expect(options?.mode).toBe('queue')
    const context = await readFile(options!.attachments![0].path, 'utf8')
    expect(context).toContain('src/login.ts:7')
    expect(context).toContain('Handle the empty token')
    expect(context).toContain(pr.url)
  })

  it('rejects feedback resolved since it was selected and never sends it', async () => {
    const { core } = await setup()
    vi.spyOn(core.git, 'status').mockResolvedValue({ pr } as GitStatus)
    vi.mocked(fetchReviewThreads).mockResolvedValue([{ ...thread, isResolved: true }])
    const send = vi.spyOn(core.sessions, 'send').mockResolvedValue('queued')
    await expect(core.api.sendReviewThreads('ws', ['thread'])).rejects.toThrow('resolved')
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects sending to a chat in another workspace', async () => {
    const { core } = await setup()
    const session = core.sessions.createSession('elsewhere')
    vi.spyOn(core.git, 'status').mockResolvedValue({ pr } as GitStatus)
    vi.mocked(fetchReviewThreads).mockResolvedValue([thread])
    const send = vi.spyOn(core.sessions, 'send').mockResolvedValue('queued')
    await expect(core.api.sendReviewThreads('ws', ['thread'], session.id)).rejects.toThrow('no longer open')
    expect(send).not.toHaveBeenCalled()
  })
})

describe.skipIf(isWindows)('shell snippets', () => {
  it('executes multiline Bash once in the workspace with its port and captures the exit code', async () => {
    const { core, store, events } = await setup()
    try {
      const id = await core.api.ptySpawn(
        'ws',
        80,
        10,
        'snippet',
        'printf "port=%s\\n" "$FOREMAN_PORT"\nprintf "once\\n" >> runs.txt\nprintf "cwd=%s\\n" "$PWD"\nexit 7'
      )
      await vi.waitFor(() => expect(events.some((e) => e.type === 'pty-exit' && e.ptyId === id && e.code === 7)).toBe(true))
      const output = events
        .filter((e): e is Extract<MainEvent, { type: 'pty-data' }> => e.type === 'pty-data' && e.ptyId === id)
        .map((e) => e.data)
        .join('')
      expect(output).toContain('port=50030')
      expect(output).toContain(`cwd=${store.dir}`)
      expect(await readFile(path.join(store.dir, 'runs.txt'), 'utf8')).toBe('once\n')
    } finally {
      core.ptys.killAll()
    }
  })

  it('stops a running snippet and refuses to launch one in an archived workspace', async () => {
    const { core, store, events } = await setup()
    try {
      const id = await core.api.ptySpawn('ws', 80, 10, 'snippet', 'sleep 30')
      core.signals.ptyKill(id)
      await vi.waitFor(() => expect(events.some((e) => e.type === 'pty-exit' && e.ptyId === id)).toBe(true))
      store.state.workspaces[0].state = 'archived'
      await expect(core.api.ptySpawn('ws', 80, 10, 'snippet', 'echo should-not-run')).rejects.toThrow('not ready')
    } finally {
      core.ptys.killAll()
    }
  })
})
