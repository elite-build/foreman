// Accessibility plan E3: four short, distinct cues, and how they route against the completion sound. Cues replace the
// chime for the same event and never stack with it; the completion sound set to None mutes both; with cues off nothing changes.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EARCONS, chimeReplaced, earconLength, earconsActive, playCompletionSound, playEarcon, playEventEarcon, playSound } from '../src/renderer/src/sound'
import type { Earcon } from '../src/renderer/src/agentStatus'

// What the fake audio context was asked to play: one entry per oscillator, with its pitch and when it starts.
const played: { frequency: number; start: number; type: string; glideTo?: number }[] = []

class FakeAudioContext {
  currentTime = 10
  destination = {}
  createOscillator() {
    const note = { frequency: 0, start: 0, type: 'sine' } as (typeof played)[number]
    const osc = {
      set type(value: string) {
        note.type = value
      },
      frequency: {
        setValueAtTime: (frequency: number) => void (note.frequency = frequency),
        exponentialRampToValueAtTime: (frequency: number) => void (note.glideTo = frequency)
      },
      connect: (node: unknown) => node,
      start: (at: number) => {
        note.start = at - 10
        played.push(note)
      },
      stop: () => undefined
    }
    return osc
  }
  createGain() {
    const param = { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }
    return { gain: param, connect: (node: unknown) => node }
  }
}

beforeEach(() => {
  played.length = 0
  vi.stubGlobal('AudioContext', FakeAudioContext)
})

const KINDS: Earcon[] = ['started', 'needs-me', 'finished', 'failed']

describe('the four cues', () => {
  it('are each over in under 400 ms', () => {
    for (const kind of KINDS) expect(earconLength(kind), kind).toBeLessThan(0.4)
  })

  it('differ from one another in pitch pattern, so they can be told apart without looking', () => {
    const shape = (kind: Earcon) => JSON.stringify(EARCONS[kind].map((n) => [n.frequency, n.glideTo ?? null, n.type ?? 'sine']))
    expect(new Set(KINDS.map(shape)).size).toBe(4)
    // Finished goes up, failed goes down.
    const [first, second] = EARCONS.finished
    expect(second.frequency).toBeGreaterThan(first.frequency)
    const [high, low] = EARCONS.failed
    expect(low.frequency).toBeLessThan(high.frequency)
  })

  it('play through Web Audio: one oscillator per note, none after the cue ends', () => {
    for (const kind of KINDS) {
      played.length = 0
      playEarcon(kind)
      expect(played.map((n) => n.frequency), kind).toEqual(EARCONS[kind].map((n) => n.frequency))
      expect(Math.max(...played.map((n) => n.start)), kind).toBeLessThan(0.4)
    }
  })

  it('stay silent, without throwing, when audio is unavailable', async () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('no audio')
        }
      }
    )
    // A fresh module, so no context from an earlier test is cached.
    vi.resetModules()
    const fresh = await import('../src/renderer/src/sound')
    expect(() => fresh.playEarcon('finished')).not.toThrow()
    expect(played).toEqual([])
  })
})

describe('routing against the completion sound', () => {
  const on = { sound: 'chime', earcons: true } as const
  const off = { sound: 'chime', earcons: false } as const
  const muted = { sound: 'none', earcons: true } as const
  const finished = { kind: 'finished', sessionId: 's1' } as const

  it('cues on: the cue plays and the chime for the same event does not', () => {
    playEventEarcon(on, 'finished')
    expect(played.map((n) => n.frequency)).toEqual(EARCONS.finished.map((n) => n.frequency))
    played.length = 0
    playCompletionSound(on, finished)
    expect(played).toEqual([])
  })

  it('cues off: no cue, and the chime is as before', () => {
    playEventEarcon(off, 'finished')
    expect(played).toEqual([])
    playCompletionSound(off, finished)
    expect(played.length).toBeGreaterThan(0)
    const chime = played.map((n) => n.frequency)
    played.length = 0
    playSound('chime')
    expect(played.map((n) => n.frequency)).toEqual(chime)
  })

  it("the completion sound set to None mutes the cues too, and the chime", () => {
    expect(earconsActive(muted)).toBe(false)
    playEventEarcon(muted, 'needs-me')
    playCompletionSound(muted, finished)
    playCompletionSound({ sound: 'none', earcons: false }, finished)
    expect(played).toEqual([])
  })

  it('a cue replaces the chime for a turn that ended or a request, not for other notices', () => {
    expect(chimeReplaced(on, { kind: 'finished', sessionId: 's1' })).toBe(true)
    expect(chimeReplaced(on, { kind: 'attention', sessionId: 's1' })).toBe(true)
    // Stopping a turn has no cue, a notice about no chat is not an agent event, and an info notice is neither.
    expect(chimeReplaced(on, { kind: 'stopped', sessionId: 's1' })).toBe(false)
    expect(chimeReplaced(on, { kind: 'attention', sessionId: '' })).toBe(false)
    expect(chimeReplaced(on, { kind: 'info', sessionId: 's1' })).toBe(false)
    expect(chimeReplaced(off, finished)).toBe(false)
    playCompletionSound(on, { kind: 'info', sessionId: 's1' })
    expect(played.length).toBeGreaterThan(0)
  })

  it('never stacks: one event makes one sound with cues on and one with cues off', () => {
    const sounds = (settings: { sound: 'chime'; earcons: boolean }) => {
      played.length = 0
      playEventEarcon(settings, 'finished')
      playCompletionSound(settings, finished)
      return played.length
    }
    expect(sounds({ sound: 'chime', earcons: true })).toBe(EARCONS.finished.length)
    // The chime's own two notes; the cue path adds nothing.
    expect(sounds({ sound: 'chime', earcons: false })).toBe(2)
  })
})
