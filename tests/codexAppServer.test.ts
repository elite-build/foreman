// The JSON-RPC client for `codex app-server`, against a stand-in process that speaks the protocol.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexAppServer, RpcError } from '../src/main/agents/codex/appServer'

const FAKE = path.join(process.cwd(), 'tests', 'fixtures', 'codexAppServerFake.mjs')
const open: CodexAppServer[] = []

function start(): CodexAppServer {
  const server = CodexAppServer.attach(spawn(process.execPath, [FAKE], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }))
  open.push(server)
  return server
}

afterEach(() => {
  for (const server of open.splice(0)) server.close()
})

const next = <T>(register: (resolve: (value: T) => void) => void) => new Promise<T>(register)

describe('CodexAppServer', () => {
  it('initializes with the experimental API on, then says initialized', async () => {
    const server = start()
    const saw = next<{ method: string; params: unknown }>((resolve) => server.onNotification((m, p) => m === 'saw' && resolve(p as { method: string; params: unknown })))
    await server.initialize()
    expect(await saw).toEqual({ method: 'initialized', params: null })
  })

  it('matches each answer to its request, however they interleave', async () => {
    const server = start()
    const [a, b] = await Promise.all([server.request('echo', { n: 1 }), server.request('echo', { n: 2 })])
    expect(a).toEqual({ n: 1 })
    expect(b).toEqual({ n: 2 })
  })

  it('rejects with the server message on an error reply, and keeps working', async () => {
    const server = start()
    await expect(server.request('fail', {})).rejects.toThrow('boom')
    await expect(server.request('echo', { ok: true })).resolves.toEqual({ ok: true })
  })

  it('ignores lines that are not JSON', async () => {
    const server = start()
    await expect(server.request('garbage', {})).resolves.toBe('ok')
  })

  it('delivers notifications to every handler', async () => {
    const server = start()
    const seen: unknown[] = []
    server.onNotification((m, p) => m === 'hello' && seen.push(['a', p]))
    const done = next<void>((resolve) => server.onNotification((m, p) => m === 'hello' && (seen.push(['b', p]), resolve())))
    await server.request('notify', {})
    await done
    expect(seen).toEqual([['a', { n: 1 }], ['b', { n: 1 }]])
  })

  it('answers a server request with the handler result', async () => {
    const server = start()
    const calls: unknown[] = []
    server.onRequest(async (method, params, id) => (calls.push([method, params, id]), { decision: 'accept' }))
    const reply = next<{ id: string; result: unknown }>((resolve) => server.onNotification((m, p) => m === 'asked' && resolve(p as { id: string; result: unknown })))
    await server.request('ask', {})
    expect(await reply).toEqual({ id: 'srv-1', result: { decision: 'accept' } })
    expect(calls).toEqual([['item/fake/ask', { question: 'ok?' }, 'srv-1']])
  })

  it('answers -32603 when the handler throws, and its own code for an RpcError', async () => {
    const server = start()
    server.onRequest(async (method) => {
      if (method === 'item/fake/unknown') throw new RpcError('nope', -32601)
      throw new Error('handler broke')
    })
    const replies: { id: string; error: { code: number; message: string } }[] = []
    const both = next<void>((resolve) => server.onNotification((m, p) => m === 'asked' && replies.push(p as (typeof replies)[number]) === 2 && resolve()))
    await server.request('ask', {})
    await server.request('ask-unknown', {})
    await both
    expect(replies).toEqual([
      { id: 'srv-1', error: { code: -32603, message: 'handler broke' } },
      { id: 'srv-2', error: { code: -32601, message: 'nope' } }
    ])
  })

  it('answers -32601 to a server request when nothing handles requests', async () => {
    const server = start()
    const reply = next<{ id: string; error: { code: number } }>((resolve) => server.onNotification((m, p) => m === 'asked' && resolve(p as { id: string; error: { code: number } })))
    await server.request('ask', {})
    expect(await reply).toMatchObject({ id: 'srv-1', error: { code: -32601 } })
  })

  it('rejects pending requests when the process exits, with its stderr', async () => {
    const server = start()
    const exits: [number | null, string][] = []
    server.onExit((code, tail) => exits.push([code, tail]))
    await expect(server.request('die', {})).rejects.toThrow(/exited with code 3: oops: it broke/)
    expect(server.exited).toBe(true)
    expect(exits).toEqual([[3, expect.stringContaining('oops: it broke')]])
    // Later requests fail at once, and a late exit handler still hears about it.
    await expect(server.request('echo', {})).rejects.toThrow(/exited with code 3/)
    expect(await next<number | null>((resolve) => server.onExit((code) => resolve(code)))).toBe(3)
  })

  it('close() kills the process, fails what is pending, and tells the exit handlers', async () => {
    const server = start()
    const exited = next<number | null>((resolve) => server.onExit((code) => resolve(code)))
    const pending = server.request('hang', {})
    const failure = expect(pending).rejects.toThrow('closed')
    server.close()
    await failure
    await exited
    expect(server.exited).toBe(true)
    await expect(server.request('echo', {})).rejects.toThrow()
    // A second close is harmless.
    server.close()
  })

  it('reports a process that cannot start as an exit', async () => {
    const server = CodexAppServer.start({ file: path.join(process.cwd(), 'no-such-codex'), cwd: process.cwd(), env: {} })
    open.push(server)
    await expect(server.request('initialize', {})).rejects.toThrow(/exited/)
    expect(server.exited).toBe(true)
  })
})
