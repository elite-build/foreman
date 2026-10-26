// @vitest-environment jsdom
// Foreman's voice (phase G1): local voices only, spoken in order, a keyed utterance replaces one still waiting, cancel
// stops everything, rate, volume and voice come from settings, and Escape cancels speech without taking the key from the
// composer or from a dialog's text field.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSpeech, pickVoice, type Speech, type SpeechOptions } from '../src/renderer/src/speech'

class FakeUtterance {
  voice: SpeechSynthesisVoice | null = null
  lang = ''
  rate = 1
  volume = 1
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public text: string) {}
}

function voice(name: string, lang: string, extra: Partial<SpeechSynthesisVoice> = {}): SpeechSynthesisVoice {
  return { name, lang, voiceURI: `uri:${name}`, localService: true, default: false, ...extra } as SpeechSynthesisVoice
}

class FakeSynth {
  voices: SpeechSynthesisVoice[] = []
  spoken: FakeUtterance[] = []
  speaking = false
  cancelled = 0
  handlers = new Set<() => void>()
  getVoices = () => this.voices
  addEventListener = (_type: string, h: () => void) => void this.handlers.add(h)
  removeEventListener = (_type: string, h: () => void) => void this.handlers.delete(h)
  speak = (u: FakeUtterance) => {
    this.spoken.push(u)
    this.speaking = true
  }
  cancel = () => {
    this.cancelled++
    this.speaking = false
    // A real engine reports the cancelled utterance late, as an error.
    const last = this.spoken[this.spoken.length - 1]
    queueMicrotask(() => last?.onerror?.())
  }
  /** The engine finishes the utterance it is speaking. */
  finish() {
    const last = this.spoken[this.spoken.length - 1]
    this.speaking = false
    last.onend?.()
  }
  changeVoices(next: SpeechSynthesisVoice[]) {
    this.voices = next
    for (const h of this.handlers) h()
  }
  texts = () => this.spoken.map((u) => u.text)
}

let synth: FakeSynth
let options: SpeechOptions
let speech: Speech

beforeEach(() => {
  synth = new FakeSynth()
  options = {}
  speech = createSpeech({ synth: synth as unknown as SpeechSynthesis, Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance })
  speech.configure(() => options)
})
afterEach(() => {
  speech.dispose()
  document.body.innerHTML = ''
})

describe('voices', () => {
  it('lists local voices only, by name, and follows voiceschanged', () => {
    synth.voices = [voice('Zira', 'en-US'), voice('Cloud', 'en-US', { localService: false }), voice('Anna', 'de-DE')]
    expect(speech.voices().map((v) => v.name)).toEqual(['Anna', 'Zira'])
    const changed = vi.fn()
    speech.subscribe(changed)
    synth.changeVoices([voice('Zira', 'en-US'), voice('Remote', 'fr-FR', { localService: false })])
    expect(changed).toHaveBeenCalledTimes(1)
    expect(speech.voices().map((v) => v.name)).toEqual(['Zira'])
    // The same list again is not a change.
    synth.changeVoices([voice('Zira', 'en-US')])
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('keeps the same array between changes (a stable store snapshot)', () => {
    synth.voices = [voice('Zira', 'en-US')]
    expect(speech.voices()).toBe(speech.voices())
  })
})

describe('the queue', () => {
  it('speaks one at a time, in order', () => {
    speech.speak('first')
    speech.speak('second')
    speech.speak('third')
    expect(synth.texts()).toEqual(['first'])
    synth.finish()
    expect(synth.texts()).toEqual(['first', 'second'])
    synth.finish()
    synth.finish()
    expect(synth.texts()).toEqual(['first', 'second', 'third'])
    expect(speech.speaking()).toBe(false)
  })

  it('replaces a waiting utterance with the same key, at the end, and never the one already speaking', () => {
    speech.speak('a started', 'a')
    speech.speak('b started', 'b')
    speech.speak('c started', 'c')
    speech.speak('b finished', 'b')
    speech.speak('a again', 'a')
    expect(synth.texts()).toEqual(['a started'])
    synth.finish()
    synth.finish()
    synth.finish()
    synth.finish()
    expect(synth.texts()).toEqual(['a started', 'c started', 'b finished', 'a again'])
  })

  it('moves on when an utterance errors', () => {
    speech.speak('one')
    speech.speak('two')
    synth.spoken[0].onerror?.()
    expect(synth.texts()).toEqual(['one', 'two'])
  })

  it('cancel stops the current one and forgets the queue; a late end report does not start anything', async () => {
    speech.speak('one')
    speech.speak('two')
    speech.cancel()
    expect(synth.cancelled).toBe(1)
    expect(speech.speaking()).toBe(false)
    await Promise.resolve()
    expect(synth.texts()).toEqual(['one'])
    speech.speak('three')
    await Promise.resolve()
    expect(synth.texts()).toEqual(['one', 'three'])
  })

  it('ignores empty text', () => {
    speech.speak('   ')
    expect(synth.spoken).toEqual([])
  })
})

describe('settings applied', () => {
  it('uses the rate, the volume and the chosen voice, read when each utterance starts', () => {
    synth.voices = [voice('Anna', 'de-DE'), voice('Zira', 'en-US')]
    options = { voice: 'uri:Anna', rate: 1.5, volume: 0.4, language: 'en' }
    speech.speak('hello')
    const u = synth.spoken[0]
    expect(u.voice?.name).toBe('Anna')
    expect(u.lang).toBe('de-DE')
    expect(u.rate).toBe(1.5)
    expect(u.volume).toBe(0.4)
    options = { rate: 0.8, volume: 1 }
    speech.speak('again')
    synth.finish()
    expect(synth.spoken[1].rate).toBe(0.8)
  })

  it('clamps rate and volume and falls back to 1 for nonsense', () => {
    options = { rate: 9, volume: -3 }
    speech.speak('a')
    expect(synth.spoken[0].rate).toBe(2)
    expect(synth.spoken[0].volume).toBe(0)
    synth.finish()
    options = { rate: Number.NaN, volume: undefined }
    speech.speak('b')
    expect(synth.spoken[1].rate).toBe(1)
    expect(synth.spoken[1].volume).toBe(1)
  })

  it('falls back to the default local voice of the UI language when the chosen voice is gone', () => {
    synth.voices = [voice('Anna', 'de-DE'), voice('Zira', 'en-US'), voice('David', 'en-US', { default: true }), voice('Remote', 'en-US', { default: true, localService: false })]
    options = { voice: 'uri:Gone', language: 'en' }
    speech.speak('hello')
    expect(synth.spoken[0].voice?.name).toBe('David')
  })

  it('pickVoice prefers the exact region, then the language, else leaves the engine default', () => {
    const list = [voice('Anna', 'de-DE'), voice('Maria', 'pt-PT'), voice('Luciana', 'pt-BR')]
    expect(pickVoice(list, '', 'pt-BR')?.name).toBe('Luciana')
    expect(pickVoice(list, '', 'pt')?.name).toBe('Maria')
    expect(pickVoice(list, '', 'ja')).toBeUndefined()
    expect(pickVoice(list, 'uri:Anna', 'ja')?.name).toBe('Anna')
  })

  it('tags the utterance with the UI language when no voice matches', () => {
    options = { language: 'ja' }
    speech.speak('hello')
    expect(synth.spoken[0].voice).toBeNull()
    expect(synth.spoken[0].lang).toBe('ja')
  })
})

describe('without speechSynthesis', () => {
  it('is a no-op, not an error', () => {
    const none = createSpeech()
    expect(none.available()).toBe(false)
    expect(() => {
      none.speak('hello', 'k')
      none.cancel()
    }).not.toThrow()
    expect(none.voices()).toEqual([])
    expect(none.speaking()).toBe(false)
    none.dispose()
  })
})

describe('Escape', () => {
  const escape = (el: Element = document.body, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })
    el.dispatchEvent(event)
    return event
  }
  const focusIn = (html: string, selector: string): HTMLElement => {
    document.body.innerHTML = html
    const el = document.querySelector<HTMLElement>(selector)!
    el.focus()
    expect(document.activeElement).toBe(el)
    return el
  }

  it('does nothing when nothing is being said', () => {
    const button = focusIn('<button id="b">x</button>', '#b')
    expect(escape(button).defaultPrevented).toBe(false)
  })

  it('cancels speech from a button in a dialog, and says so with preventDefault', () => {
    const button = focusIn('<div role="dialog" aria-label="Settings"><button id="b">x</button></div>', '#b')
    speech.speak('hello')
    const event = escape(button)
    expect(event.defaultPrevented).toBe(true)
    expect(synth.cancelled).toBe(1)
    expect(speech.speaking()).toBe(false)
  })

  it('cancels with nothing focused', () => {
    document.body.innerHTML = ''
    ;(document.activeElement as HTMLElement | null)?.blur()
    speech.speak('hello')
    expect(escape().defaultPrevented).toBe(true)
  })

  it('leaves Escape alone in the composer', () => {
    const composer = focusIn('<textarea id="c" aria-label="Message"></textarea>', '#c')
    speech.speak('hello')
    expect(escape(composer).defaultPrevented).toBe(false)
    expect(synth.cancelled).toBe(0)
    expect(speech.speaking()).toBe(true)
  })

  it('leaves Escape alone in the text field of another dialog', () => {
    const field = focusIn('<div role="dialog" aria-label="Rename"><input id="i" type="text" aria-label="Name"></div>', '#i')
    speech.speak('hello')
    expect(escape(field).defaultPrevented).toBe(false)
    expect(speech.speaking()).toBe(true)
  })

  it('cancels inside the Ask overlay, even from its text field', () => {
    const field = focusIn('<div role="dialog" aria-label="Ask Foreman" data-ask-overlay><input id="i" type="text" aria-label="Question"></div>', '#i')
    speech.speak('the answer')
    expect(escape(field).defaultPrevented).toBe(true)
    expect(speech.speaking()).toBe(false)
  })

  it('recognises the Ask dialog by its name when it carries no marker', () => {
    const field = focusIn('<div role="dialog" aria-label="Ask Foreman"><textarea id="i" aria-label="Question"></textarea></div>', '#i')
    speech.speak('the answer')
    expect(escape(field).defaultPrevented).toBe(true)
  })

  it('ignores Escape with a modifier', () => {
    const button = focusIn('<button id="b">x</button>', '#b')
    speech.speak('hello')
    expect(escape(button, { shiftKey: true }).defaultPrevented).toBe(false)
    expect(speech.speaking()).toBe(true)
  })

  it('stops listening after dispose', () => {
    const button = focusIn('<button id="b">x</button>', '#b')
    speech.speak('hello')
    speech.dispose()
    expect(escape(button).defaultPrevented).toBe(false)
  })
})
