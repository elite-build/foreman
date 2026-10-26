import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { TurnCallbacks, TurnRequest } from '../src/main/agents/types'

const mocks = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('node:child_process', () => ({ fork: mocks.fork }))
vi.mock('node:fs', () => ({ existsSync: () => true }))
vi.mock('../src/main/agents/cursor', () => ({ cursorDriver: { kind: 'cursor' } }))
import { cursorProcessDriver } from '../src/main/agents/cursorProcess'

describe('Cursor repository environments', () => {
  it('starts simultaneous turns with separate credentials and forwards their results and reports', async () => {
    const children: (EventEmitter & { send: ReturnType<typeof vi.fn>; stderr: PassThrough; disconnect: () => void })[] = []
    mocks.fork.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        send: vi.fn(), stderr: new PassThrough(), connected: true,
        disconnect() { queueMicrotask(() => child.emit('exit', 0)) }
      })
      children.push(child)
      return child
    })
    const callbacks = () => ({ item: vi.fn(), sessionStarted: vi.fn(), usage: vi.fn(), finished: vi.fn() }) as unknown as TurnCallbacks
    const a = callbacks(), b = callbacks()
    const report = vi.fn(() => 'Noted.')
    const req = (token: string) => ({ turnId: token, prompt: 'Do the work', cwd: '/repo', env: { GH_TOKEN: token, CURSOR_API_KEY: 'cursor-key' }, hostTools: { report } }) as unknown as TurnRequest
    const shellToken = process.env.GH_TOKEN
    const first = cursorProcessDriver.createTurn(req('personal'), a).run()
    const second = cursorProcessDriver.createTurn(req('office'), b).run()
    expect(mocks.fork.mock.calls.map((args) => args[2].env.GH_TOKEN)).toEqual(['personal', 'office'])
    expect(mocks.fork.mock.calls.every((args) => args[1].length === 0)).toBe(true)
    expect(process.env.GH_TOKEN).toBe(shellToken)
    expect(children[0].send.mock.calls[0][0]).toMatchObject({ type: 'start', reports: true, request: { env: { GH_TOKEN: 'personal' } } })
    expect(children[0].send.mock.calls[0][0].request).not.toHaveProperty('hostTools')
    children[0].emit('message', { type: 'report', args: ['needs-input', 'Which database?'] })
    children[0].emit('message', { type: 'finished', args: [{ ok: true }] })
    children[1].emit('message', { type: 'finished', args: [{ ok: false, error: 'Failed' }] })
    for (const child of children) child.emit('message', { type: 'ended' })
    await Promise.all([first, second])
    expect(a.finished).toHaveBeenCalledWith({ ok: true })
    expect(b.finished).toHaveBeenCalledWith({ ok: false, error: 'Failed' })
    expect(report).toHaveBeenCalledWith('needs-input', 'Which database?')
  })
})
