// One polite announcer for the whole window (phase 4 of the design-system plan). Anything that should be spoken by a
// screen reader but isn't on screen as it happens (an agent finished, a chat needs you) goes through `announce`. The
// <Announcer /> in App.tsx renders the single live region this feeds.
//
//   - Announcements made within `delayMs` of the first one are spoken together, in one go.
//   - An announcement with the same `key` as one still waiting replaces it: "started working" followed by "finished"
//     a moment later is just "finished", so a fast turn doesn't talk twice.
//   - The text is dropped from the region after `holdMs`, so it isn't left lying in the page for a reader to browse.
//   - One voice (phase G1): where the words go is chosen when they are flushed. With the speech setting on they are
//     spoken by Foreman (speech.ts) and are not put in the live region, so a screen reader does not read them as well;
//     with it off they go to the live region. Coalescing and replace-by-key happen before that choice, so both ways
//     behave alike, and a change of setting applies to whatever is still waiting.
import { useSyncExternalStore } from 'react'
import { speech as windowSpeech, type Speech } from './speech'

export interface Spoken {
  text: string
  // Changes with every announcement, so identical text is spoken again.
  nonce: number
}

export interface Announcer {
  /** Queue text. `key` lets a later announcement replace an earlier one that has not been spoken yet. */
  announce(text: string, key?: string): void
  subscribe(listener: () => void): () => void
  current(): Spoken
  /** Set where the speech setting is read from. Called by <Announcer />; read at flush time. */
  configure(options: { getMode?: () => SpeechMode }): void
  /** Drop what is waiting and what is showing, and stop Foreman's voice (tests, sign-out). */
  reset(): void
}

/** The `speechOutput` setting: 'on' speaks announcements with Foreman's voice instead of the live region. */
export type SpeechMode = 'on' | 'off'

/** What the announcer needs from the speech layer. */
export type SpeechSink = Pick<Speech, 'available' | 'speak' | 'cancel'>

export interface AnnouncerOptions {
  delayMs?: number
  holdMs?: number
  /** The current speech setting; absent means 'off'. */
  getMode?: () => SpeechMode
  /** Where 'on' sends the words. Absent: the live region is the only sink. */
  speech?: SpeechSink
}

/** Each message is a sentence of its own, so a reader or a voice pauses between them. */
const sentence = (m: string) => (/[.!?…]$/.test(m) ? m : `${m}.`)

export function createAnnouncer({ delayMs = 700, holdMs = 10_000, getMode: initialMode, speech }: AnnouncerOptions = {}): Announcer {
  let getMode = initialMode
  const listeners = new Set<() => void>()
  // `key` is the caller's, if it gave one: only a keyed message can replace one that is still waiting in the voice's queue.
  const queue = new Map<string, { text: string; key?: string }>()
  let spoken: Spoken = { text: '', nonce: 0 }
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let holdTimer: ReturnType<typeof setTimeout> | undefined
  let anonymous = 0

  const set = (next: Spoken) => {
    spoken = next
    for (const listener of listeners) listener()
  }

  const flush = () => {
    flushTimer = undefined
    if (!queue.size) return
    const messages = [...queue.values()]
    queue.clear()
    // One voice: Foreman's own, or the screen reader's through the live region. Nothing is sent to both. Without a
    // voice to speak with (a window that has none), the live region still gets the words.
    if (getMode?.() === 'on' && speech?.available()) {
      for (const m of messages) speech.speak(sentence(m.text), m.key)
      return
    }
    const text = messages.map((m) => sentence(m.text)).join(' ')
    set({ text, nonce: spoken.nonce + 1 })
    clearTimeout(holdTimer)
    holdTimer = setTimeout(() => set({ text: '', nonce: spoken.nonce }), holdMs)
  }

  return {
    announce(text, key) {
      const message = text.trim()
      if (!message) return
      const at = key ?? `#${++anonymous}`
      // A replacement goes to the end: it is the newest thing to say.
      queue.delete(at)
      queue.set(at, { text: message, key })
      flushTimer ??= setTimeout(flush, delayMs)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    current: () => spoken,
    configure(options) {
      if (options.getMode) getMode = options.getMode
    },
    reset() {
      speech?.cancel()
      clearTimeout(flushTimer)
      clearTimeout(holdTimer)
      flushTimer = undefined
      queue.clear()
      set({ text: '', nonce: spoken.nonce })
    }
  }
}

/** The window's announcer. */
export const announcer = createAnnouncer({ speech: windowSpeech })

export const announce = (text: string, key?: string): void => announcer.announce(text, key)

/** What the live region should currently say. */
export function useSpoken(source: Announcer = announcer): Spoken {
  return useSyncExternalStore(source.subscribe, source.current)
}
