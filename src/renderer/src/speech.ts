// Foreman's own voice (phase G1): a thin layer over `window.speechSynthesis`, which speaks with the voices the operating
// system has installed. Only local voices are offered and used (`localService`): nothing Foreman says is sent anywhere.
//
// The queue behaves like the announcer's (announce.ts):
//   - utterances are spoken in order, one at a time (the engine's own queue is not used, so a queued one can be replaced);
//   - `speak` with the key of an utterance still waiting replaces it, and the replacement goes to the end;
//   - `cancel` stops what is being said and forgets what was waiting.
//
// Escape cancels speech, but never takes the key from the composer (there it stops the agent) or from a text field in a
// dialog. Inside the Ask overlay it always cancels, since the answer being read is what Escape is for there.
import { useSyncExternalStore } from 'react'

/** What the speech layer reads from settings each time it speaks, so a change applies to the next utterance. */
export interface SpeechOptions {
  /** A voice URI; empty or unknown means the default local voice of `language`. */
  voice?: string
  /** 0.5 to 2. */
  rate?: number
  /** 0 to 1. */
  volume?: number
  /** The UI language (a BCP 47 tag): chooses the automatic voice and tags the utterance. */
  language?: string
}

export interface Speech {
  /** Whether this window can speak at all (false in a browser or test without `speechSynthesis`). */
  available(): boolean
  /** The local voices, sorted by name. Stable between changes, so it is safe as a store snapshot. */
  voices(): readonly SpeechSynthesisVoice[]
  /** Called when the list of voices changes. */
  subscribe(listener: () => void): () => void
  /** Queue text; a later call with the same `key` replaces one still waiting. */
  speak(text: string, key?: string): void
  /** Stop speaking and drop the queue. */
  cancel(): void
  /** Whether something is being said or waiting to be. */
  speaking(): boolean
  /** Where rate, volume and voice come from. */
  configure(source: (() => SpeechOptions) | undefined): void
  /** Remove the Escape listener and stop (tests, window teardown). */
  dispose(): void
}

export interface SpeechEnvironment {
  synth?: SpeechSynthesis
  Utterance?: typeof SpeechSynthesisUtterance
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  doc?: Document
}

export const MIN_RATE = 0.5
export const MAX_RATE = 2

const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'image', 'color'])

/** A place where typing happens: Escape belongs to it. */
export function isTextField(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type)
  const editable = el.getAttribute('contenteditable')
  return Boolean((el as HTMLElement).isContentEditable) || (editable !== null && editable !== 'false')
}

/** The Ask overlay: marked with data-ask-overlay, or a dialog named "Ask Foreman". */
function inAskOverlay(el: Element): boolean {
  if (el.closest('[data-ask-overlay]')) return true
  const dialog = el.closest('[role="dialog"]')
  return dialog?.getAttribute('aria-label') === 'Ask Foreman'
}

const languageOf = (voice: SpeechSynthesisVoice) => voice.lang.replace('_', '-').toLowerCase()

/** The voice to use: the chosen one if it is still installed, else the default local voice of the UI language. */
export function pickVoice(voices: readonly SpeechSynthesisVoice[], uri: string | undefined, language: string | undefined): SpeechSynthesisVoice | undefined {
  const chosen = uri ? voices.find((v) => v.voiceURI === uri) : undefined
  if (chosen) return chosen
  const want = language?.replace('_', '-').toLowerCase()
  if (!want) return undefined
  const base = want.split('-')[0]
  const exact = voices.filter((v) => languageOf(v) === want)
  const same = voices.filter((v) => languageOf(v).split('-')[0] === base)
  return exact.find((v) => v.default) ?? exact[0] ?? same.find((v) => v.default) ?? same[0]
}

export function createSpeech(env: SpeechEnvironment = {}): Speech {
  const synth = () => env.synth ?? (typeof speechSynthesis === 'undefined' ? undefined : speechSynthesis)
  const makeUtterance = (text: string): SpeechSynthesisUtterance | undefined => {
    const Ctor = env.Utterance ?? (typeof SpeechSynthesisUtterance === 'undefined' ? undefined : SpeechSynthesisUtterance)
    return Ctor ? new Ctor(text) : undefined
  }
  const target = () => env.target ?? (typeof window === 'undefined' ? undefined : window)
  const doc = () => env.doc ?? (typeof document === 'undefined' ? undefined : document)

  const listeners = new Set<() => void>()
  const queue = new Map<string, string>()
  let anonymous = 0
  let current: SpeechSynthesisUtterance | null = null
  let source: (() => SpeechOptions) | undefined
  let cached: readonly SpeechSynthesisVoice[] = []
  let watching: SpeechSynthesis | undefined
  let listening = false

  const load = (): readonly SpeechSynthesisVoice[] => {
    const all = synth()?.getVoices() ?? []
    return all.filter((v) => v.localService).sort((a, b) => a.name.localeCompare(b.name))
  }
  const sameVoices = (a: readonly SpeechSynthesisVoice[], b: readonly SpeechSynthesisVoice[]) => a.length === b.length && a.every((v, i) => v.voiceURI === b[i].voiceURI)
  const refresh = () => {
    const fresh = load()
    if (sameVoices(fresh, cached)) return
    cached = fresh
    for (const listener of listeners) listener()
  }
  // The list fills in after start-up on some systems: follow `voiceschanged`.
  const watch = () => {
    const s = synth()
    if (!s || watching === s) return
    watching = s
    s.addEventListener?.('voiceschanged', refresh)
    cached = load()
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
    if (!api.speaking()) return
    const active = doc()?.activeElement ?? null
    // Nothing focused or a plain control: Escape is free. A text field: only the Ask overlay's.
    if (active && active !== doc()?.body && isTextField(active) && !inAskOverlay(active)) return
    api.cancel()
    e.preventDefault()
  }
  const listen = () => {
    if (listening) return
    const w = target()
    if (!w) return
    listening = true
    // Capture, so the first Escape stops the voice before an overlay's own handler closes it.
    w.addEventListener('keydown', onKey as EventListener, true)
  }

  const advance = () => {
    const s = synth()
    if (!s || current) return
    const first = queue.entries().next()
    if (first.done) return
    const [key, text] = first.value
    queue.delete(key)
    const utterance = makeUtterance(text)
    if (!utterance) return
    const options = source?.() ?? {}
    const voice = pickVoice(cached, options.voice, options.language)
    if (voice) {
      utterance.voice = voice
      utterance.lang = voice.lang
    } else if (options.language) utterance.lang = options.language
    utterance.rate = clamp(options.rate, MIN_RATE, MAX_RATE, 1)
    utterance.volume = clamp(options.volume, 0, 1, 1)
    current = utterance
    const done = () => {
      // A cancelled utterance reports its end late: only the current one moves the queue on.
      if (current !== utterance) return
      current = null
      advance()
    }
    utterance.onend = done
    utterance.onerror = done
    try {
      s.speak(utterance)
    } catch {
      done()
    }
  }

  const api: Speech = {
    available: () => synth() !== undefined && makeUtterance('') !== undefined,
    voices() {
      watch()
      return cached
    },
    subscribe(listener) {
      watch()
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    speak(text, key) {
      const message = text.trim()
      if (!message || !api.available()) return
      watch()
      listen()
      const at = key ?? `#${++anonymous}`
      // A replacement goes to the end: it is the newest thing to say.
      queue.delete(at)
      queue.set(at, message)
      advance()
    },
    cancel() {
      queue.clear()
      const had = current
      current = null
      if (had || synth()?.speaking) synth()?.cancel()
    },
    speaking: () => current !== null || queue.size > 0,
    configure(next) {
      source = next
    },
    dispose() {
      api.cancel()
      if (listening) target()?.removeEventListener('keydown', onKey as EventListener, true)
      listening = false
      if (watching) watching.removeEventListener?.('voiceschanged', refresh)
      watching = undefined
    }
  }
  return api
}

/** The window's voice. */
export const speech = createSpeech()

/** The local voices, re-read when the system reports a change. */
export function useVoices(source: Speech = speech): readonly SpeechSynthesisVoice[] {
  return useSyncExternalStore(source.subscribe, source.voices)
}
