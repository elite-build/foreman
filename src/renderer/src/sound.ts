// Completion sounds and event cues, synthesized with Web Audio so the app ships no audio files.
import type { NotifyKind, Settings } from '../../shared/types'
import type { Earcon } from './agentStatus'

let context: AudioContext | null = null

interface ToneOptions {
  type?: OscillatorType
  // Glide to this frequency over the first part of the note.
  glideTo?: number
  glideTime?: number
  attack?: number
}

function tone(ctx: AudioContext, frequency: number, start: number, duration: number, volume: number, options: ToneOptions = {}): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = options.type ?? 'sine'
  osc.frequency.setValueAtTime(frequency, start)
  if (options.glideTo) osc.frequency.exponentialRampToValueAtTime(options.glideTo, start + (options.glideTime ?? duration))
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(volume, start + (options.attack ?? 0.01))
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  osc.connect(gain).connect(ctx.destination)
  osc.start(start)
  osc.stop(start + duration + 0.05)
}

/** A struck bar: a quick-decaying fundamental with the bright fourth partial of a marimba. */
function marimbaNote(ctx: AudioContext, frequency: number, start: number, volume: number): void {
  tone(ctx, frequency, start, 0.6, volume, { attack: 0.004 })
  tone(ctx, frequency * 3.9, start, 0.12, volume * 0.3, { attack: 0.002 })
  tone(ctx, frequency * 10, start, 0.04, volume * 0.08, { attack: 0.001 })
}

export function playSound(sound: Settings['sound']): void {
  if (sound === 'none') return
  try {
    context ??= new AudioContext()
    const now = context.currentTime
    if (sound === 'bell') {
      tone(context, 880, now, 1.1, 0.18)
      tone(context, 1760, now, 0.6, 0.05)
    } else if (sound === 'pop') {
      // A short upward sweep, like a bubble popping.
      tone(context, 320, now, 0.14, 0.24, { glideTo: 1100, glideTime: 0.05, attack: 0.004 })
    } else if (sound === 'marimba') {
      marimbaNote(context, 783.99, now, 0.2)
      marimbaNote(context, 1046.5, now + 0.13, 0.18)
    } else {
      // A soft rising two-note chime.
      tone(context, 659.25, now, 0.35, 0.16)
      tone(context, 987.77, now + 0.12, 0.55, 0.14)
    }
  } catch {
    // Audio unavailable; stay silent.
  }
}

interface EarconNote {
  frequency: number
  // Seconds from the start of the cue.
  start: number
  duration: number
  volume: number
  type?: OscillatorType
  glideTo?: number
}

/** The cues (accessibility plan E3): four shapes you can tell apart without looking, each over before 400 ms. */
export const EARCONS: Readonly<Record<Earcon, readonly EarconNote[]>> = {
  // A soft single blip that rises.
  started: [{ frequency: 440, start: 0, duration: 0.12, volume: 0.12, glideTo: 587 }],
  // The same bright note twice, a tap on the shoulder.
  'needs-me': [
    { frequency: 880, start: 0, duration: 0.1, volume: 0.17, type: 'triangle' },
    { frequency: 880, start: 0.15, duration: 0.12, volume: 0.17, type: 'triangle' }
  ],
  // Two notes going up, resolved.
  finished: [
    { frequency: 659.25, start: 0, duration: 0.14, volume: 0.16 },
    { frequency: 987.77, start: 0.1, duration: 0.24, volume: 0.14 }
  ],
  // Two notes going down and low.
  failed: [
    { frequency: 392, start: 0, duration: 0.14, volume: 0.18, type: 'triangle' },
    { frequency: 261.63, start: 0.12, duration: 0.22, volume: 0.18, type: 'triangle' }
  ]
}

/** When a cue falls silent, in seconds. */
export const earconLength = (kind: Earcon): number => Math.max(...EARCONS[kind].map((n) => n.start + n.duration))

/** Cues stand in for the completion sound; `sound: 'none'` mutes both. */
export const earconsActive = (settings: Pick<Settings, 'sound' | 'earcons'>): boolean => settings.earcons && settings.sound !== 'none'

export function playEarcon(kind: Earcon): void {
  try {
    context ??= new AudioContext()
    const now = context.currentTime
    for (const note of EARCONS[kind]) {
      tone(context, note.frequency, now + note.start, note.duration, note.volume, { type: note.type, glideTo: note.glideTo, glideTime: 0.08, attack: 0.008 })
    }
  } catch {
    // Audio unavailable; stay silent.
  }
}

/** The cue for an agent event (the status-event site), when cues are on. */
export function playEventEarcon(settings: Pick<Settings, 'sound' | 'earcons'>, kind: Earcon): void {
  if (earconsActive(settings)) playEarcon(kind)
}

/**
 * Whether the main process's notice for a chat also gets the completion sound: not when cues are on and the status-event
 * site cues the same event (a turn ended, or something needs you). Other notices keep it.
 */
export function chimeReplaced(settings: Pick<Settings, 'earcons'>, event: { kind?: NotifyKind; sessionId: string }): boolean {
  return settings.earcons && Boolean(event.sessionId) && (event.kind === 'finished' || event.kind === 'attention')
}

/** The completion sound for a notice, unless cues replace it. */
export function playCompletionSound(settings: Pick<Settings, 'sound' | 'earcons'>, event: { kind?: NotifyKind; sessionId: string }): void {
  if (!chimeReplaced(settings, event)) playSound(settings.sound)
}
