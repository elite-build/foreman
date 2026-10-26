import { readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLI_PROTOCOL_VERSION, ERROR_EXIT, socketPath, tokenPath, type CliErrorCode, type CliProgressFrame } from '../src/cli/protocol'
import { CliCodedError, ensureCliToken, handleRequest, METHODS, readCliToken, startCliServer, tierCheck, type CliHost } from '../src/main/cliServer'
import { defaultSettings } from '../src/main/store'
import type { Workspace } from '../src/shared/types'
import { stubHost } from './cliHost'
import { tempDir } from './helpers'

const ws = (id: string, name: string) => ({ id, name, branch: name, repoId: 'r', path: `/tmp/${id}`, state: 'ready' }) as Workspace

describe('protocol version 2 over the socket', () => {
  let close: (() => void) | undefined
  afterEach(() => close?.())

  async function serve(overrides: Partial<CliHost> = {}) {
    const dataDir = await tempDir()
    const host = stubHost({ appInfo: () => ({ version: '9.9.9', packaged: true, dataDir }), ...overrides })
    const socket = socketPath(dataDir)
    const server = await startCliServer(socket, host)
    close = () => server.close()
    // Everything the app wrote before closing, as lines.
    const lines = (text: string) =>
      new Promise<string[]>((resolve, reject) => {
        const conn = net.createConnection(socket, () => conn.write(text))
        let out = ''
        conn.setEncoding('utf8')
        conn.on('data', (chunk: string) => (out += chunk))
        conn.on('end', () => resolve(out.split('\n').filter(Boolean)))
        conn.on('error', reject)
      })
    const ask = (request: unknown) => lines(`${JSON.stringify(request)}\n`)
    return { ask, lines, dataDir, socket }
  }

  it('answers a request without `v` with one line and no code, as it always did', async () => {
    const { ask } = await serve()
    const ok = await ask({ method: 'repos' })
    expect(ok).toHaveLength(1)
    expect(JSON.parse(ok[0])).toEqual({ ok: true, result: [] })
    const unknown = await ask({ method: 'nope' })
    expect(unknown).toHaveLength(1)
    expect(JSON.parse(unknown[0])).toEqual({ ok: false, error: 'Unknown request nope' })
    const missing = await ask({ method: 'cancel', params: { turn: 'zzz' } })
    expect(JSON.parse(missing[0])).toEqual({ ok: false, error: 'No turn with the id “zzz”. `foreman run` and `foreman send` print it.' })
  })

  it('keeps the old text for a line that isn’t a request', async () => {
    const { lines } = await serve()
    expect(JSON.parse((await lines('{nope\n'))[0])).toEqual({ ok: false, error: 'Malformed request' })
    expect(JSON.parse((await lines('null\n'))[0])).toEqual({ ok: false, error: 'Malformed request' })
  })

  it('gives a failed version 2 request a code', async () => {
    const { ask } = await serve({ state: () => ({ repos: [], workspaces: [ws('a', 'twin'), ws('b', 'twin')], sessions: [], settings: defaultSettings() }) })
    const code = async (request: Record<string, unknown>) => JSON.parse((await ask({ v: 2, ...request }))[0]) as { ok: boolean; code?: CliErrorCode; error?: string }
    expect(await code({ method: 'nope' })).toMatchObject({ ok: false, code: 'unknown-method', error: 'Unknown request nope' })
    expect(await code({ method: 'cancel', params: { turn: 'zzz' } })).toMatchObject({ ok: false, code: 'not-found' })
    expect(await code({ method: 'send', params: { workspace: 'ghost', args: ['hi'], cwd: '/' } })).toMatchObject({ ok: false, code: 'not-found' })
    expect(await code({ method: 'send', params: { workspace: 'twin', args: ['hi'], cwd: '/' } })).toMatchObject({ ok: false, code: 'ambiguous' })
    expect(await code({ method: 'resume-at', params: { turn: 'zzz' } })).toMatchObject({ ok: false, code: 'not-found' })
    // Anything else a handler throws is a plain failure.
    expect(await code({ method: 'checks', params: { cwd: '/nowhere' } })).toMatchObject({ ok: false, code: 'failed' })
    expect(await code({ v: 3, method: 'repos' })).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('answers app-info', async () => {
    const { ask, dataDir } = await serve()
    const reply = JSON.parse((await ask({ v: 2, method: 'app-info' }))[0])
    expect(reply).toEqual({ ok: true, result: { version: '9.9.9', protocol: CLI_PROTOCOL_VERSION, packaged: true, dataDir, socket: socketPath(dataDir) } })
    expect(CLI_PROTOCOL_VERSION).toBe(2)
  })

  it('refuses an admin method from inside an agent turn, with or without the token', async () => {
    const { ask } = await serve()
    const caller = { sessionId: 's', turnId: 't', token: 'k' }
    const message = 'Settings can’t be changed from inside an agent turn.'
    const v2 = JSON.parse((await ask({ v: 2, method: 'export', params: {}, caller, token: 'test-token' }))[0])
    expect(v2).toEqual({ ok: false, error: message, code: 'refused' })
    // Version 1 has no code, but the same refusal.
    const v1 = JSON.parse((await ask({ method: 'import', params: {}, caller }))[0])
    expect(v1).toEqual({ ok: false, error: message })
  })

  it('wants the launch token for an admin method in version 2 only', async () => {
    const { ask } = await serve()
    const params = { workspace: 'ghost', cwd: '/', share: true }
    for (const token of [undefined, '', 'wrong', 'test-token '] as const) {
      const reply = JSON.parse((await ask({ v: 2, method: 'export', params, token }))[0])
      expect(reply).toMatchObject({ ok: false, code: 'refused' })
      expect(reply.error).toMatch(/out of date|isn’t the one installed/)
    }
    // With it the call gets as far as the handler, which can't find the workspace.
    expect(JSON.parse((await ask({ v: 2, method: 'export', params, token: 'test-token' }))[0])).toMatchObject({ ok: false, code: 'not-found' })
    // A version 1 client (the command before it sends tokens) is still served.
    expect(JSON.parse((await ask({ method: 'export', params }))[0])).toMatchObject({ ok: false, error: expect.stringContaining('No workspace named') })
    // Reads need no token.
    expect(JSON.parse((await ask({ v: 2, method: 'repos' }))[0])).toMatchObject({ ok: true })
  })

  it('writes progress frames to a version 2 request only', async () => {
    METHODS['test-progress'] = {
      tier: 'read',
      handle: async (_host, _params, ctx) => {
        ctx.progress('cloning')
        ctx.progress('halfway', 50)
        return 'done'
      }
    }
    try {
      const { ask } = await serve()
      const v2 = (await ask({ v: 2, method: 'test-progress' })).map((l) => JSON.parse(l))
      expect(v2).toEqual([{ progress: { text: 'cloning' } }, { progress: { text: 'halfway', percent: 50 } }, { ok: true, result: 'done' }])
      const v1 = (await ask({ method: 'test-progress' })).map((l) => JSON.parse(l))
      expect(v1).toEqual([{ ok: true, result: 'done' }])
    } finally {
      delete METHODS['test-progress']
    }
  })

  it('hands the bridge the bytes that arrived after its first line', async () => {
    const seen: { params: unknown; rest: string }[] = []
    const { lines } = await serve({
      bridge: (conn, params, rest) => {
        seen.push({ params, rest })
        conn.end('bridged\n')
      }
    })
    const first = JSON.stringify({ method: 'mcp-bridge', params: { grant: 'g', service: 'linear' } })
    const rest = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n{"partial":`
    expect(await lines(`${first}\n${rest}`)).toEqual(['bridged'])
    // Even a request that says v: 2 is the bridge's before anything else is looked at: no token, no registry.
    expect(await lines(`${JSON.stringify({ v: 2, method: 'mcp-bridge', params: { grant: 'g2', service: 'slack' } })}\n`)).toEqual(['bridged'])
    expect(seen).toEqual([
      { params: { grant: 'g', service: 'linear' }, rest },
      { params: { grant: 'g2', service: 'slack' }, rest: '' }
    ])
  })

  it('says so when the host has no bridge', async () => {
    const { lines } = await serve()
    expect(JSON.parse((await lines(`${JSON.stringify({ method: 'mcp-bridge', params: { grant: 'g', service: 'x' } })}\n`))[0])).toEqual({ bridgeError: 'This version of Foreman has no integration bridge.' })
  })
})

describe('handleRequest', () => {
  it('passes progress to the writer for version 2 and not for version 1', async () => {
    METHODS['test-progress'] = { tier: 'read', handle: async (_h, _p, ctx) => (ctx.progress('step', 10), 42) }
    try {
      const frames: CliProgressFrame[] = []
      const v2 = await handleRequest(stubHost(), { v: 2, method: 'test-progress' }, undefined, (f) => frames.push(f))
      expect(v2).toEqual({ ok: true, result: 42 })
      expect(frames).toEqual([{ progress: { text: 'step', percent: 10 } }])
      frames.length = 0
      await handleRequest(stubHost(), { method: 'test-progress' } as never, undefined, (f) => frames.push(f))
      expect(frames).toEqual([])
    } finally {
      delete METHODS['test-progress']
    }
  })

  it('lets a handler choose its code', async () => {
    METHODS['test-coded'] = {
      tier: 'read',
      handle: async () => {
        throw new CliCodedError('needs-confirmation', 'Pass --yes', 'It deletes the workspace.')
      }
    }
    try {
      expect(await handleRequest(stubHost(), { v: 2, method: 'test-coded' })).toEqual({ ok: false, error: 'Pass --yes', code: 'needs-confirmation', hint: 'It deletes the workspace.' })
      expect(await handleRequest(stubHost(), { method: 'test-coded' } as never)).toEqual({ ok: false, error: 'Pass --yes' })
    } finally {
      delete METHODS['test-coded']
    }
  })

  it('does not take Object.prototype names for methods', async () => {
    expect(await handleRequest(stubHost(), { v: 2, method: 'constructor' })).toMatchObject({ ok: false, code: 'unknown-method' })
    expect(await handleRequest(stubHost(), { v: 2, method: '__proto__' })).toMatchObject({ ok: false, code: 'unknown-method' })
  })
})

describe('tiers', () => {
  it('puts every method in the tier the plan gives it', () => {
    const tiers = Object.fromEntries(Object.entries(METHODS).map(([name, m]) => [name, m.tier]))
    // Later phases add nouns; this checks the tiers the plan fixes, and the test below that every tier is valid.
    expect(tiers).toMatchObject({
      status: 'read',
      templates: 'read',
      repos: 'read',
      wait: 'read',
      report: 'read',
      'app-info': 'read',
      doctor: 'read',
      'cli-status': 'read',
      'cli-install': 'admin',
      run: 'act',
      send: 'act',
      'resume-at': 'act',
      cancel: 'act',
      checks: 'act',
      export: 'admin',
      import: 'admin'
    })
  })

  it('gives every registered method a known tier', () => {
    for (const [name, m] of Object.entries(METHODS)) expect(['read', 'act', 'admin'], name).toContain(m.tier)
  })

  it('lets read through for an agent and holds act to the start policy', () => {
    const caller = { sessionId: 's', turnId: 't', token: 'k' }
    const host = stubHost()
    expect(tierCheck('status', 'read', { method: 'status', caller }, host)).toBeNull()
    // checks starts no turn, so an agent may call it.
    expect(tierCheck('checks', 'act', { method: 'checks', params: { cwd: '/' }, caller }, host)).toBeNull()
    // A token Foreman doesn't recognise can't start anything, a dry run excepted.
    expect(tierCheck('send', 'act', { method: 'send', params: { workspace: '.', args: [], cwd: '/' }, caller }, host)).toMatchObject({ code: 'refused' })
    expect(tierCheck('run', 'act', { method: 'run', params: { template: 't', values: [], cwd: '/', dryRun: true }, caller }, host)).toBeNull()
  })

  it('maps every code to an exit code', () => {
    expect(ERROR_EXIT).toEqual({ invalid: 2, 'not-running': 5, 'needs-confirmation': 6, 'needs-consent': 6, refused: 7, 'not-found': 8, ambiguous: 8, busy: 4, failed: 1, 'unknown-method': 1, 'not-supported': 1 })
  })
})

describe('the launch token', () => {
  it('is made once, 32 random bytes in hex, and read back after', async () => {
    const dir = await tempDir()
    expect(readCliToken(dir)).toBeNull()
    const token = await ensureCliToken(dir)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenPath(dir)).toBe(path.join(dir, 'cli.token'))
    // The real access restriction ran (icacls on Windows, 0600 elsewhere) and left the file readable to us.
    expect(readCliToken(dir)).toBe(token)
    expect(await ensureCliToken(dir)).toBe(token)
    expect(await ensureCliToken(await tempDir())).not.toBe(token)
  })

  it('replaces a file that isn’t a token, and restricts it on every launch', async () => {
    const dir = await tempDir()
    writeFileSync(tokenPath(dir), 'not a token')
    expect(readCliToken(dir)).toBeNull()
    const restricted: string[] = []
    const token = await ensureCliToken(dir, { restrict: async (file) => void restricted.push(file) })
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(tokenPath(dir), 'utf8').trim()).toBe(token)
    await ensureCliToken(dir, { restrict: async (file) => void restricted.push(file) })
    expect(restricted).toEqual([tokenPath(dir), tokenPath(dir)])
  })
})
