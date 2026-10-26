// One voice (phase G1): with the speech setting on, announcements are spoken by Foreman and the live region stays empty;
// with it off the announcer behaves as before. The choice is made when the words are flushed, so a change of setting
// applies to what is still waiting, and replace-by-key and coalescing work for both.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnnouncer, type SpeechMode, type SpeechSink } from '../src/renderer/src/announce'

function fakeSpeech(available = true): SpeechSink & { said: Array<[string, string | undefined]>; cancelled: number } {
  const said: Array<[string, string | undefined]> = []
  const sink = { said, cancelled: 0, available: () => available, speak: (text: string, key?: string) => void said.push([text, key]), cancel: () => void sink.cancelled++ }
  return sink
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("the announcer's sink", () => {
  it("on: speaks each message as a sentence with its key, and leaves the live region empty", () => {
    const speech = fakeSpeech()
    const a = createAnnouncer({ delayMs: 500, getMode: () => 'on', speech })
    const changed = vi.fn()
    a.subscribe(changed)
    a.announce('Claude finished', 'status:s1')
    a.announce('Codex needs you.')
    expect(speech.said).toEqual([])
    vi.advanceTimersByTime(500)
    expect(speech.said).toEqual([
      ['Claude finished.', 'status:s1'],
      ['Codex needs you.', undefined]
    ])
    expect(a.current()).toEqual({ text: '', nonce: 0 })
    expect(changed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(a.current().text).toBe('')
  })

  it('on: still replaces by key before anything is spoken', () => {
    const speech = fakeSpeech()
    const a = createAnnouncer({ delayMs: 500, getMode: () => 'on', speech })
    a.announce('Claude started', 'status:s1')
    a.announce('Claude finished', 'status:s1')
    vi.advanceTimersByTime(500)
    expect(speech.said).toEqual([['Claude finished.', 'status:s1']])
  })

  it('off (the default): the live region as before, speech untouched', () => {
    const speech = fakeSpeech()
    const withMode = createAnnouncer({ delayMs: 500, getMode: () => 'off', speech })
    const without = createAnnouncer({ delayMs: 500, speech })
    for (const a of [withMode, without]) {
      a.announce('Claude finished')
      a.announce('Codex needs you.')
    }
    vi.advanceTimersByTime(500)
    expect(withMode.current().text).toBe('Claude finished. Codex needs you.')
    expect(without.current().text).toBe('Claude finished. Codex needs you.')
    expect(speech.said).toEqual([])
  })

  it('on without a voice to speak with: the live region still gets the words', () => {
    const speech = fakeSpeech(false)
    const a = createAnnouncer({ delayMs: 500, getMode: () => 'on', speech })
    a.announce('Claude finished')
    vi.advanceTimersByTime(500)
    expect(speech.said).toEqual([])
    expect(a.current().text).toBe('Claude finished.')
  })

  it('a change of setting mid-queue applies at flush time, to what is waiting', () => {
    const speech = fakeSpeech()
    let mode: SpeechMode = 'off'
    const a = createAnnouncer({ delayMs: 500, getMode: () => mode, speech })
    a.announce('First')
    mode = 'on'
    vi.advanceTimersByTime(500)
    expect(speech.said).toEqual([['First.', undefined]])
    expect(a.current().text).toBe('')

    a.announce('Second')
    mode = 'off'
    vi.advanceTimersByTime(500)
    expect(a.current().text).toBe('Second.')
    expect(speech.said).toHaveLength(1)
  })

  it('configure sets where the mode is read from', () => {
    const speech = fakeSpeech()
    const a = createAnnouncer({ delayMs: 500, speech })
    a.configure({ getMode: () => 'on' })
    a.announce('Hello')
    vi.advanceTimersByTime(500)
    expect(speech.said).toEqual([['Hello.', undefined]])
  })

  it('reset also stops the voice', () => {
    const speech = fakeSpeech()
    const a = createAnnouncer({ delayMs: 500, getMode: () => 'on', speech })
    a.announce('Hello')
    a.reset()
    vi.advanceTimersByTime(500)
    expect(speech.cancelled).toBe(1)
    expect(speech.said).toEqual([])
  })
})
