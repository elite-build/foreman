// The event log (docs/telemetry.md, "Evidence"): the in-memory ring, the JSON lines in foreman.log, rotation past the
// cap, the process handlers that record uncaught errors, and the tail reader the bundle uses.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DiagnosticsLog, EVENTS_KEPT, errorText, installProcessHandlers, tailLines } from '../src/main/diagnosticsLog'
import { tempDir } from './helpers'

describe('DiagnosticsLog', () => {
  it('keeps the last EVENTS_KEPT events in memory, newest last, whether or not a file is open', () => {
    let now = 1_000
    const log = new DiagnosticsLog(() => now++)
    for (let i = 0; i < EVENTS_KEPT + 10; i++) log.log('tick', { i })
    const recent = log.recent()
    expect(recent).toHaveLength(EVENTS_KEPT)
    expect(recent[0]).toMatchObject({ kind: 'tick', i: 10 })
    expect(recent.at(-1)).toMatchObject({ kind: 'tick', i: EVENTS_KEPT + 9, at: new Date(1_000 + EVENTS_KEPT + 9).toISOString() })
    expect(log.recent(2).map((e) => e.i)).toEqual([EVENTS_KEPT + 8, EVENTS_KEPT + 9])
    expect(log.file).toBeNull()
  })

  it('writes one JSON line per event once open, stops when closed, and starts the file again past the cap', async () => {
    const dir = await tempDir('foreman-diag-')
    const file = path.join(dir, 'logs', 'foreman.log')
    const log = new DiagnosticsLog(() => 5_000)
    log.log('before', {})
    await log.open(file, 400)
    expect(log.file).toBe(file)
    log.log('app.start', { version: '1.2.3' })
    log.log('error', { line: 'boom' })
    await log.flushed()
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    // What was logged before the file opened stays in the ring only.
    expect(lines.map((l) => l.kind)).toEqual(['app.start', 'error'])
    expect(lines[0]).toEqual({ at: new Date(5_000).toISOString(), kind: 'app.start', version: '1.2.3' })

    for (let i = 0; i < 12; i++) log.log('filler', { text: 'x'.repeat(40) })
    await log.flushed()
    expect((await readFile(`${file}.1`, 'utf8')).length).toBeGreaterThan(0)
    expect((await readFile(file, 'utf8')).length).toBeLessThanOrEqual(400)

    log.close()
    expect(log.file).toBeNull()
    const sizeBefore = (await readFile(file, 'utf8')).length
    log.log('after', {})
    await log.flushed()
    expect((await readFile(file, 'utf8')).length).toBe(sizeBefore)
    expect(log.recent(1)[0].kind).toBe('after')
  })

  it('records an uncaught exception or rejection with its stack, and still says so on the console', () => {
    const listeners: Record<string, (x: unknown) => void> = {}
    const target = { on: (event: string, listener: (x: unknown) => void) => (listeners[event] = listener) }
    const log = new DiagnosticsLog(() => 0)
    const said: unknown[][] = []
    installProcessHandlers(target as never, log, (...args) => said.push(args))
    const err = new Error('kaboom')
    listeners.uncaughtException(err)
    listeners.unhandledRejection('plain reason')
    const [exception, rejection] = log.recent()
    expect(exception).toMatchObject({ kind: 'exception', message: 'Error: kaboom' })
    expect(String(exception.stack)).toContain('kaboom')
    expect(rejection).toEqual({ at: new Date(0).toISOString(), kind: 'rejection', message: 'plain reason' })
    expect(said).toEqual([
      ['Uncaught exception:', err],
      ['Unhandled rejection:', 'plain reason']
    ])
  })

  it('describes whatever was thrown', () => {
    expect(errorText(new TypeError('bad'))).toMatchObject({ message: 'TypeError: bad' })
    expect(errorText('text')).toEqual({ message: 'text' })
    expect(errorText({ code: 7 })).toEqual({ message: '{"code":7}' })
  })

  it('reads the last lines of a file, and nothing from a file that is not there', async () => {
    const dir = await tempDir('foreman-tail-')
    const file = path.join(dir, 'a.log')
    await writeFile(file, Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n')
    expect(await tailLines(file, 3)).toEqual(['line 47', 'line 48', 'line 49'])
    expect(await tailLines(file, 100)).toHaveLength(50)
    expect(await tailLines(path.join(dir, 'missing.log'), 3)).toEqual([])
  })
})
