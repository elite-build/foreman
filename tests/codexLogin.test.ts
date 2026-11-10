// Codex's managed ChatGPT sign-in, against a fake app-server: no process is started and no account is touched.
import { describe, expect, it, vi } from 'vitest'
import type { AppServerLaunch, CodexAppServerLike } from '../src/main/agents/codexAppServer'
import { startCodexSignIn } from '../src/main/agents/codexLogin'

const LAUNCH: AppServerLaunch = { file: 'codex', cwd: '/home', env: { CODEX_HOME: '/codex-home' } }

class FakeServer implements CodexAppServerLike {
  exited = false
  closed = false
  calls: { method: string; params: unknown }[] = []
  private listeners: ((method: string, params: any) => void)[] = []
  private exits: ((code: number | null, stderrTail: string) => void)[] = []
  // What `account/login/start` answers; a test can swap it.
  startReply: unknown = { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.example/oauth?x=1' }
  // Holds the start reply back until released.
  holdStart?: Promise<void>
  cancelReply: Promise<unknown> = Promise.resolve({ status: 'canceled' })

  async initialize(): Promise<void> {
    this.calls.push({ method: 'initialize', params: undefined })
  }
  async request<T>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, params })
    if (method === 'account/login/start') {
      await this.holdStart
      if (this.startReply instanceof Error) throw this.startReply
      return this.startReply as T
    }
    if (method === 'account/login/cancel') return (await this.cancelReply) as T
    throw new Error(`unexpected ${method}`)
  }
  notify(): void {}
  onNotification(handler: (method: string, params: any) => void): void {
    this.listeners.push(handler)
  }
  onRequest(): void {}
  onExit(handler: (code: number | null, stderrTail: string) => void): void {
    this.exits.push(handler)
  }
  close(): void {
    this.closed = true
    this.exited = true
  }
  emit(method: string, params: unknown): void {
    for (const handler of this.listeners) handler(method, params)
  }
  die(code: number | null, tail: string): void {
    this.exited = true
    for (const handler of this.exits) handler(code, tail)
  }
  methods(): string[] {
    return this.calls.map((c) => c.method)
  }
}

function setup(timeoutMs?: number) {
  const server = new FakeServer()
  const opened: string[] = []
  const factory = vi.fn((launch: AppServerLaunch) => {
    expect(launch).toEqual(LAUNCH)
    return server
  })
  const openUrl = vi.fn(async (url: string) => void opened.push(url))
  const signIn = startCodexSignIn(LAUNCH, openUrl, factory, timeoutMs)
  return { server, opened, factory, openUrl, signIn }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('startCodexSignIn', () => {
  it('starts a ChatGPT login, opens the sign-in page, and finishes when the matching login completes', async () => {
    const { server, opened, signIn } = setup()
    await vi.waitFor(() => expect(opened).toEqual(['https://auth.example/oauth?x=1']))
    expect(server.methods()).toEqual(['initialize', 'account/login/start'])
    expect(server.calls[1]!.params).toEqual({ type: 'chatgpt' })
    server.emit('account/login/completed', { loginId: 'login-1', success: true, error: null })
    await expect(signIn.done).resolves.toEqual({ ok: true })
    expect(server.closed).toBe(true)
  })

  it('reports why a login failed, with the CLI’s own words', async () => {
    const { server, opened, signIn } = setup()
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    server.emit('account/login/completed', { loginId: 'login-1', success: false, error: 'Token exchange failed' })
    await expect(signIn.done).resolves.toEqual({ ok: false, error: 'Token exchange failed' })
    expect(server.closed).toBe(true)
  })

  it('ignores a completion for another login', async () => {
    const { server, opened, signIn } = setup()
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    let settled = false
    void signIn.done.then(() => (settled = true))
    server.emit('account/login/completed', { loginId: 'someone-else', success: true, error: null })
    server.emit('account/login/completed', { loginId: null, success: false, error: 'No id' })
    server.emit('account/chatgptAuthTokens/refresh', {})
    await tick()
    expect(settled).toBe(false)
    expect(server.closed).toBe(false)
    server.emit('account/login/completed', { loginId: 'login-1', success: true, error: null })
    await expect(signIn.done).resolves.toEqual({ ok: true })
  })

  it('keeps a completion that arrives before the start reply was handled', async () => {
    const server = new FakeServer()
    let release!: () => void
    server.holdStart = new Promise<void>((resolve) => (release = resolve))
    const signIn = startCodexSignIn(LAUNCH, async () => undefined, () => server)
    await vi.waitFor(() => expect(server.methods()).toContain('account/login/start'))
    server.emit('account/login/completed', { loginId: 'login-1', success: true, error: null })
    release()
    await expect(signIn.done).resolves.toEqual({ ok: true })
  })

  it('cancel() asks the CLI to cancel that login, closes it, and reports cancelled', async () => {
    const { server, opened, signIn } = setup()
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    signIn.cancel()
    await expect(signIn.done).resolves.toEqual({ ok: false, error: 'Sign-in cancelled', cancelled: true })
    expect(server.calls.at(-1)).toEqual({ method: 'account/login/cancel', params: { loginId: 'login-1' } })
    expect(server.closed).toBe(true)
    // A completion after the fact changes nothing, and a second cancel is harmless.
    server.emit('account/login/completed', { loginId: 'login-1', success: true, error: null })
    signIn.cancel()
    await expect(signIn.done).resolves.toMatchObject({ cancelled: true })
  })

  it('cancel() still closes the process when the CLI does not answer the cancel', async () => {
    vi.useFakeTimers()
    try {
      const { server, signIn } = setup()
      server.cancelReply = new Promise(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      signIn.cancel()
      await vi.advanceTimersByTimeAsync(2000)
      await expect(signIn.done).resolves.toMatchObject({ cancelled: true })
      expect(server.closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancel() before the login started closes the process without asking to cancel anything', async () => {
    const server = new FakeServer()
    server.holdStart = new Promise(() => undefined)
    const signIn = startCodexSignIn(LAUNCH, async () => undefined, () => server)
    await vi.waitFor(() => expect(server.methods()).toContain('account/login/start'))
    signIn.cancel()
    await expect(signIn.done).resolves.toMatchObject({ ok: false, cancelled: true })
    expect(server.methods()).not.toContain('account/login/cancel')
    expect(server.closed).toBe(true)
  })

  it('gives up after the timeout, cancelling the login and closing the process', async () => {
    vi.useFakeTimers()
    try {
      const { server, opened, signIn } = setup(10 * 60_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(opened).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      await expect(signIn.done).resolves.toMatchObject({ ok: false, timedOut: true })
      expect(server.calls.at(-1)).toEqual({ method: 'account/login/cancel', params: { loginId: 'login-1' } })
      expect(server.closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails when the process exits first, naming what it printed', async () => {
    const { server, opened, signIn } = setup()
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    server.die(1, 'boom: bad config')
    const result = await signIn.done
    expect(result).toMatchObject({ ok: false })
    expect((result as { error: string }).error).toContain('boom: bad config')
  })

  it('fails with the CLI’s error when the login cannot start, and when it hands back no link', async () => {
    const refused = new FakeServer()
    refused.startReply = new Error('ChatGPT login is disabled')
    await expect(startCodexSignIn(LAUNCH, vi.fn(), () => refused).done).resolves.toEqual({ ok: false, error: 'ChatGPT login is disabled' })
    expect(refused.closed).toBe(true)

    const empty = new FakeServer()
    empty.startReply = { type: 'apiKey' }
    const open = vi.fn()
    const result = await startCodexSignIn(LAUNCH, open, () => empty).done
    expect(result).toMatchObject({ ok: false })
    expect(open).not.toHaveBeenCalled()
    expect(empty.closed).toBe(true)
  })

  it('cancels the login and closes when the browser cannot be opened', async () => {
    const server = new FakeServer()
    const signIn = startCodexSignIn(LAUNCH, async () => Promise.reject(new Error('Only web links can be opened')), () => server)
    await expect(signIn.done).resolves.toEqual({ ok: false, error: 'Only web links can be opened' })
    expect(server.calls.at(-1)).toEqual({ method: 'account/login/cancel', params: { loginId: 'login-1' } })
    expect(server.closed).toBe(true)
  })

  it('fails when the app-server cannot be started at all', async () => {
    const signIn = startCodexSignIn(LAUNCH, vi.fn(), () => {
      throw new Error('spawn codex ENOENT')
    })
    await expect(signIn.done).resolves.toEqual({ ok: false, error: 'spawn codex ENOENT' })
  })
})
