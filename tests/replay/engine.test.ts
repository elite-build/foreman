// The replay engine on its own, over small made-up fixtures: the matching and id rules of docs/agents.md, 9.3.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EOF, kill, type Fixture, type Frame } from '../../src/main/agents/fixtures/format'
import { ReplayEngine, claudeProtocol, jsonRpcProtocol, type Protocol } from '../../src/main/agents/fixtures/replay'

afterEach(() => vi.useRealTimers())

const fixture = (...frames: Frame[]): Fixture => ({ header: { fixture: 1, agent: 'x', scenario: 's', version: '1', recordedAt: '2026-11-11', evidence: 'scripted' }, frames })
const f = (t: number, dir: Frame['dir'], data: unknown): Frame => ({ t, dir, data })

function run(frames: Frame[], protocol: Protocol, options = {}) {
  const got: unknown[] = []
  const exits: unknown[] = []
  const engine = new ReplayEngine(fixture(...frames), protocol, { recv: (d) => got.push(d), stderr: (t) => got.push({ stderr: t }), exit: (i) => exits.push(i) }, options)
  engine.start()
  return { engine, got, exits }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('matching', () => {
  it('waits at a send for a send of the same kind, whatever it says', async () => {
    const { engine, got } = run([f(0, 'recv', { method: 'hello' }), f(1, 'send', { id: 1, method: 'a', params: { x: 1 } }), f(2, 'recv', { id: 1, result: 'A' })], jsonRpcProtocol)
    await settle()
    expect(got).toEqual([{ method: 'hello' }])
    engine.send({ id: 1, method: 'a', params: { x: 'something else entirely' } })
    await settle()
    expect(got).toEqual([{ method: 'hello' }, { id: 1, result: 'A' }])
    expect(engine.warnings).toEqual([])
  })

  it('holds a send that comes before the engine reaches its frame', async () => {
    const { engine, got } = run([f(0, 'send', { id: 1, method: 'a' }), f(1, 'recv', { id: 1, result: 'A' }), f(2, 'send', { method: 'later' }), f(3, 'recv', { method: 'after' })], jsonRpcProtocol)
    engine.send({ method: 'later' })
    await settle()
    expect(got).toEqual([])
    engine.send({ id: 7, method: 'a' })
    await settle()
    expect(got).toEqual([{ id: 7, result: 'A' }, { method: 'after' }])
  })

  it('remaps the id of an answer to the live request, and leaves the agent\'s own ids alone', async () => {
    const { engine, got } = run(
      [f(0, 'send', { id: 1, method: 'thread/start' }), f(1, 'recv', { id: 1, result: 'ok' }), f(2, 'recv', { id: 40, method: 'item/approval', params: {} }), f(3, 'send', { id: 40, result: { allow: true } }), f(4, 'recv', { method: 'done' })],
      jsonRpcProtocol
    )
    engine.send({ id: 12, method: 'thread/start' })
    await settle()
    expect(got).toEqual([{ id: 12, result: 'ok' }, { id: 40, method: 'item/approval', params: {} }])
    engine.send({ id: 40, result: { allow: false } })
    await settle()
    expect(got.at(-1)).toEqual({ method: 'done' })
  })

  it('matches Claude control messages by type and subtype, and remaps request ids', async () => {
    const { engine, got } = run(
      [
        f(0, 'send', { type: 'control_request', request_id: 'rec1', request: { subtype: 'initialize' } }),
        f(1, 'recv', { type: 'control_response', response: { subtype: 'success', request_id: 'rec1', response: { ok: 1 } } }),
        f(2, 'send', { type: 'control_request', request_id: 'rec2', request: { subtype: 'interrupt' } }),
        f(3, 'recv', { type: 'control_response', response: { subtype: 'success', request_id: 'rec2', response: {} } })
      ],
      claudeProtocol
    )
    engine.send({ type: 'control_request', request_id: 'live-a', request: { subtype: 'initialize', hooks: {} } })
    await settle()
    expect(got).toEqual([{ type: 'control_response', response: { subtype: 'success', request_id: 'live-a', response: { ok: 1 } } }])
    engine.send({ type: 'control_request', request_id: 'live-b', request: { subtype: 'interrupt' } })
    await settle()
    expect(got.at(-1)).toMatchObject({ response: { request_id: 'live-b' } })
  })
})

describe('what the recording does not hold', () => {
  it('answers an unknown Claude control request with a generic success, and warns', async () => {
    const { engine, got } = run([f(0, 'recv', { type: 'system' })], claudeProtocol)
    await settle()
    engine.send({ type: 'control_request', request_id: 'r9', request: { subtype: 'something_new' } })
    await settle()
    expect(got.at(-1)).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r9', response: {} } })
    expect(engine.warnings).toEqual(['no frame for a send of "control_request:something_new"'])
  })

  it('answers an unknown JSON-RPC request with a method-not-found error, and ignores an unknown notification', async () => {
    const { engine, got } = run([f(0, 'recv', { method: 'x' })], jsonRpcProtocol)
    await settle()
    engine.send({ id: 3, method: 'thread/compact/start' })
    engine.send({ method: 'initialized' })
    await settle()
    expect(got.at(-1)).toMatchObject({ id: 3, error: { code: -32601 } })
    expect(engine.warnings).toHaveLength(2)
  })
})

describe('time, exits and kills', () => {
  it('scales the gaps between frames by speed, and cuts a long one', async () => {
    vi.useFakeTimers()
    const { got } = run([f(0, 'recv', { n: 1 }), f(1000, 'recv', { n: 2 }), f(60_000, 'recv', { n: 3 })], jsonRpcProtocol, { speed: 2, maxGapMs: 4000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(got).toEqual([{ n: 1 }])
    await vi.advanceTimersByTimeAsync(499)
    expect(got).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(got).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(got).toHaveLength(3)
  })

  it('plays stderr and the exit, and puts the sanitiser\'s paths back', async () => {
    const { got, exits } = run([f(0, 'recv', { cwd: '<repo>/src' }), f(1, 'stderr', 'warning at <repo>'), f(2, 'exit', { code: 3, signal: null })], jsonRpcProtocol, { paths: { repo: '/work/r' } })
    await settle()
    expect(got).toEqual([{ cwd: '/work/r/src' }, { stderr: 'warning at /work/r' }])
    expect(exits).toEqual([{ code: 3, signal: null }])
  })

  it('exits when the adapter closes the input after the recording, and when it is killed', async () => {
    const a = run([f(0, 'recv', { n: 1 })], jsonRpcProtocol)
    await settle()
    expect(a.exits).toEqual([])
    a.engine.send(EOF)
    expect(a.exits).toEqual([{ code: 0, signal: null }])
    const b = run([f(0, 'send', { method: 'never' })], jsonRpcProtocol)
    b.engine.send(kill('SIGKILL'))
    expect(b.exits).toEqual([{ code: null, signal: 'SIGKILL' }])
    b.engine.send({ method: 'never' })
    expect(b.got).toEqual([])
  })
})
