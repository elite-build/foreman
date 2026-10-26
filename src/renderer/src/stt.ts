// Push-to-talk dictation (accessibility plan, phase G2): the capture controller and its tiny store.
//
//   - `pushToTalkPressed` is what the registry's `stt.pushToTalk` entry (mod+alt+V) runs. The registry dispatches only
//     key-downs, so the key-up and blur listeners live here, registered when a session starts and removed when it ends.
//     Hold mode: the key-down starts, letting go of V or of a chord modifier (or the window losing focus) stops. Toggle
//     mode: one press starts, the next stops. Either way a session ends by itself after 60 seconds, and Escape cancels
//     one. Never a global shortcut: it works only while this window has focus.
//   - Audio: getUserMedia -> an AudioWorklet (sttWorklet.ts) that posts 16 kHz mono int16 frames of about 100 ms ->
//     `api.sttAudio`. The microphone track is released as soon as a session stops or is cancelled. Raw audio is never kept.
//   - Where the text goes: the focused text field, at the caret (the field's state follows through an input event), or
//     else the Ask overlay's field. It is never sent; the user presses Enter.
//   - What a screen reader hears: "Listening" once (and "Transcribing" when the engine gives no partial text), then
//     "Heard: <text>". The sidebar chip (components/SttChip.tsx) shows the same, with the partial text.
import { useEffect, useSyncExternalStore } from 'react'
import { announce } from './announce'
import { t as tNow } from './i18n'
import { platformOf, setPushToTalkHandler, type ChordEvent } from './shortcuts'
import { speech } from './speech'
import type { Api, MainEvent } from '../../shared/types'
import { api as bridgeApi, bridge, getState, openAsk, showToast } from './store'
import workletUrl from './sttWorklet.ts?worker&url'
import { STT_PROCESSOR, STT_SAMPLE_RATE } from './sttWorklet'

// ---- the main process's side of the contract (src/shared/types.ts, phase G2) ----

export type SttProvider = Awaited<ReturnType<Api['sttStart']>>['provider']
export type SttModelStatus = Awaited<ReturnType<Api['sttModelStatus']>>

const sttApi = bridgeApi

const noop = () => undefined

/** A session ends by itself after this long. */
export const STT_CAP_MS = 60_000
// How long to wait for the worklet's last frame when a session stops.
const FLUSH_WAIT_MS = 250
// How long the Ask overlay gets to become usable (its assistant check can take a moment).
const ASK_WAIT_MS = 4000

// ---- the store ----

export type SttState = 'idle' | 'listening' | 'transcribing'

export interface SttSnapshot {
  state: SttState
  /** Text heard so far, for engines that stream it. */
  partial: string
  /** The engine of the session in progress; null before it has answered. */
  provider: SttProvider | null
}

const IDLE: SttSnapshot = { state: 'idle', partial: '', provider: null }

// ---- capture ----

export interface Capture {
  /** Release the microphone. With `flush` (the default) the last partial frame is delivered first. */
  stop(flush?: boolean): Promise<void>
}

export type OpenCapture = (onFrame: (pcm: Uint8Array) => void) => Promise<Capture>

/** The microphone through an AudioWorklet. Throws what getUserMedia throws (NotAllowedError, NotFoundError). */
export const openCapture: OpenCapture = async (onFrame) => {
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, sampleRate: STT_SAMPLE_RATE, echoCancellation: true, noiseSuppression: true }
  })
  let context: AudioContext | undefined
  try {
    context = new AudioContext({ sampleRate: STT_SAMPLE_RATE })
    if (!context.audioWorklet) throw new Error('This window cannot capture audio.')
    await context.audioWorklet.addModule(workletUrl)
    const source = context.createMediaStreamSource(media)
    const node = new AudioWorkletNode(context, STT_PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    // A worklet is only pulled while it leads to the destination; the gain keeps it silent.
    const mute = context.createGain()
    mute.gain.value = 0
    let flushed: (() => void) | undefined
    node.port.onmessage = (event: MessageEvent<{ type?: string; pcm?: ArrayBuffer }>) => {
      const data = event.data
      if (data?.type === 'frame' && data.pcm) onFrame(new Uint8Array(data.pcm))
      else if (data?.type === 'flushed') flushed?.()
    }
    source.connect(node)
    node.connect(mute)
    mute.connect(context.destination)
    if (context.state === 'suspended') await context.resume()
    const open = context
    let stopped = false
    return {
      async stop(flush = true) {
        if (stopped) return
        stopped = true
        // The microphone first: nothing more is heard once the key is up. What the worklet holds is still delivered.
        for (const track of media.getTracks()) track.stop()
        if (flush) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, FLUSH_WAIT_MS)
            flushed = () => {
              clearTimeout(timer)
              resolve()
            }
            node.port.postMessage({ type: 'flush' })
          })
        }
        node.port.onmessage = null
        source.disconnect()
        node.disconnect()
        mute.disconnect()
        await open.close().catch(noop)
      }
    }
  } catch (err) {
    for (const track of media.getTracks()) track.stop()
    void context?.close().catch(noop)
    throw err
  }
}

// ---- where the text goes ----

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'tel'])

/** The focused text field, if it is one dictation may type into (not a password, a read-only field or a terminal). */
function focusedField(): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  const el = document.activeElement
  if (!el || el === document.body) return null
  if (el.closest('.xterm, .terminal')) return null
  if (el instanceof HTMLTextAreaElement) return el.readOnly || el.disabled ? null : el
  if (el instanceof HTMLInputElement) return !el.readOnly && !el.disabled && TEXT_INPUT_TYPES.has(el.type) ? el : null
  return el instanceof HTMLElement && el.isContentEditable ? el : null
}

/** Set a field's value the way typing would, so React's onChange sees it. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
}

/** Put `text` at the caret of an input or textarea (replacing a selection), with a space where words would run together. */
export function insertAtCaret(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? start
  const before = el.value.slice(0, start)
  const after = el.value.slice(end)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  setNativeValue(el, `${before}${lead}${text}${trail}${after}`)
  const caret = start + lead.length + text.length
  el.setSelectionRange(caret, caret)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function insertIntoEditable(el: HTMLElement, text: string): void {
  el.focus()
  document.execCommand?.('insertText', false, text)
}

const askInput = () => document.querySelector<HTMLInputElement>('[data-ask-overlay] input:not(:disabled)')

/** The Ask overlay's field, once it exists and is usable; null if it does not become so in time. */
function whenAskInput(): Promise<HTMLInputElement | null> {
  const ready = askInput()
  if (ready) return Promise.resolve(ready)
  return new Promise((resolve) => {
    const finish = (value: HTMLInputElement | null) => {
      observer.disconnect()
      clearTimeout(timer)
      resolve(value)
    }
    const observer = new MutationObserver(() => {
      const input = askInput()
      if (input) finish(input)
    })
    const timer = setTimeout(() => finish(askInput()), ASK_WAIT_MS)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'data-ask-overlay'] })
  })
}

export type Delivery = 'field' | 'ask' | 'unavailable'

/** The focused text field takes the text at its caret; otherwise it goes into the Ask overlay's field (not sent). */
export async function deliverText(text: string): Promise<Delivery> {
  const field = focusedField()
  if (field) {
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) insertAtCaret(field, text)
    else insertIntoEditable(field, text)
    return 'field'
  }
  if (!getState().snapshot?.settings.assistantEnabled) return 'unavailable'
  openAsk()
  const input = await whenAskInput()
  if (!input) return 'unavailable'
  input.focus()
  const end = input.value.length
  input.setSelectionRange(end, end)
  insertAtCaret(input, text)
  return 'ask'
}

// ---- the controller ----

interface Session {
  id: string | null
  provider: SttProvider | null
  capture: Capture | null
  timer: ReturnType<typeof setTimeout> | undefined
  /** A stop arrived before the engine and microphone were open; it is honoured once they are. */
  stopWanted: boolean
  finishing: boolean
  releaseKeys: () => void
}

export interface SttDeps {
  openCapture: OpenCapture
  deliver: (text: string) => Promise<Delivery>
  capMs: number
}

export interface SttController {
  subscribe(listener: () => void): () => void
  getSnapshot(): SttSnapshot
  /** The `stt.pushToTalk` chord went down. */
  pressed(event?: { repeat?: boolean }): void
  start(): Promise<void>
  /** Stop listening and transcribe; resolves once the text has been delivered. */
  stop(): Promise<void>
  /** Stop listening and throw the audio away. */
  cancel(): void
  /** A main-process event (stt-partial, stt-error). */
  handleEvent(event: MainEvent): void
}

type Mode = 'hold' | 'toggle'

function errorText(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return tNow('stt.error.denied')
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return tNow('stt.error.noMic')
  return tNow('stt.error.failed', { error: err instanceof Error ? err.message : String(err) })
}

/** Tell the screen reader and show a toast. */
export function reportSttError(err: unknown): void {
  const message = typeof err === 'string' ? err : errorText(err)
  announce(message, 'stt:error')
  showToast(message, 'error')
}

export function createStt(overrides: Partial<SttDeps> = {}): SttController {
  const deps: SttDeps = { openCapture, deliver: deliverText, capMs: STT_CAP_MS, ...overrides }
  const listeners = new Set<() => void>()
  let snapshot: SttSnapshot = IDLE
  let session: Session | null = null

  const set = (next: SttSnapshot) => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  const settings = () => getState().snapshot?.settings
  const mode = (): Mode => (settings()?.pushToTalk === 'toggle' ? 'toggle' : 'hold')

  /** Release everything a session holds, without delivering anything. */
  const teardown = (s: Session) => {
    if (session === s) session = null
    clearTimeout(s.timer)
    s.releaseKeys()
    void s.capture?.stop(false).catch(noop)
    if (!session) set(IDLE)
  }

  const fail = (s: Session, err: unknown) => {
    const id = s.id
    teardown(s)
    if (id) void sttApi.sttCancel(id).catch(noop)
    reportSttError(err)
  }

  /** Whether a key-up ends a held chord: V, or the modifiers of mod+alt. */
  const endsChord = (e: KeyboardEvent) => {
    const mod = platformOf(getState().snapshot?.platform) === 'mac' ? 'Meta' : 'Control'
    return e.code === 'KeyV' || e.code.startsWith('Alt') || e.code.startsWith(mod)
  }

  /** Key-up and blur end a held chord; Escape cancels in either mode. Registered once per session. */
  const listen = (s: Session, held: boolean): (() => void) => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (held && endsChord(e)) void finish(s)
    }
    const onBlur = () => {
      if (held) void finish(s)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }

  async function finish(s: Session): Promise<void> {
    if (session !== s || s.finishing) return
    // Not ready yet (the engine or the microphone is still opening): stop as soon as it is.
    if (!s.capture || !s.id) {
      s.stopWanted = true
      return
    }
    s.finishing = true
    clearTimeout(s.timer)
    s.releaseKeys()
    set({ state: 'transcribing', partial: snapshot.partial, provider: s.provider })
    // An engine that streams text has been showing it; one that does not (OpenAI) is quiet until the end.
    if (s.provider !== 'local') announce(tNow('stt.transcribing'), 'stt:state')
    let text: string
    try {
      await s.capture.stop(true)
      text = (await sttApi.sttStop(s.id)).text
    } catch (err) {
      // A cancel or an error event may have ended the session meanwhile; then it has been reported.
      if (session === s) fail(s, err)
      return
    }
    if (session !== s) return
    session = null
    set(IDLE)
    await present(text.trim())
  }

  async function present(text: string): Promise<void> {
    if (!text) return announce(tNow('stt.empty'), 'stt:final')
    try {
      const where = await deps.deliver(text)
      if (where === 'unavailable') {
        const message = tNow('stt.unavailable', { text })
        announce(message, 'stt:final')
        showToast(message)
      } else announce(tNow('stt.heard', { text }), 'stt:final')
    } catch (err) {
      reportSttError(err)
    }
  }

  async function start(): Promise<void> {
    if (session) return
    const s: Session = { id: null, provider: null, capture: null, timer: undefined, stopWanted: false, finishing: false, releaseKeys: noop }
    session = s
    set({ state: 'listening', partial: '', provider: null })
    // Foreman's own voice must not talk over the person dictating.
    speech.cancel()
    announce(tNow('stt.listening'), 'stt:state')
    s.releaseKeys = listen(s, mode() === 'hold')
    ensureEvents()
    try {
      const language = settings()?.sttLanguage
      const started = await sttApi.sttStart(language ? { language } : {})
      if (session !== s) {
        void sttApi.sttCancel(started.sessionId).catch(noop)
        return
      }
      s.id = started.sessionId
      s.provider = started.provider
      set({ ...snapshot, provider: started.provider })
      const capture = await deps.openCapture((pcm) => {
        if (session === s && s.id) void sttApi.sttAudio(s.id, pcm).catch(noop)
      })
      if (session !== s) {
        void capture.stop(false).catch(noop)
        return
      }
      s.capture = capture
      s.timer = setTimeout(() => {
        announce(tNow('stt.capReached'), 'stt:cap')
        void finish(s)
      }, deps.capMs)
      if (s.stopWanted) await finish(s)
    } catch (err) {
      if (session === s) fail(s, err)
    }
  }

  function cancel(): void {
    const s = session
    if (!s) return
    const id = s.id
    teardown(s)
    if (id) void sttApi.sttCancel(id).catch(noop)
    announce(tNow('stt.cancelled'), 'stt:state')
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    pressed(event) {
      if (!session) return void start()
      // Toggle mode's second press. In hold mode a fresh press (not the key repeating) while a session is open means
      // a key-up was missed, which macOS does for letters while Command is down: it ends the session too.
      if (event?.repeat || session.finishing) return
      void finish(session)
    },
    start,
    stop: async () => {
      if (session) await finish(session)
    },
    cancel,
    handleEvent(e) {
      if (e.type === 'stt-partial') {
        if (session?.id && e.sessionId === session.id && snapshot.state !== 'idle') set({ ...snapshot, partial: e.text })
      } else if (e.type === 'stt-error') {
        // The error says what went wrong; end whichever session it belongs to (or the only one there is).
        const s = session
        if (s && (!e.sessionId || !s.id || e.sessionId === s.id)) {
          const id = s.id
          teardown(s)
          if (id) void sttApi.sttCancel(id).catch(noop)
        }
        reportSttError(e.message)
      }
    }
  }
}

/** The window's controller. */
export const stt = createStt()

/** What the `stt.pushToTalk` shortcut runs. */
export function pushToTalkPressed(event?: Pick<ChordEvent, 'code'> & { repeat?: boolean }): void {
  stt.pressed(event)
}
setPushToTalkHandler(pushToTalkPressed)

/** Where dictation is: idle, listening or transcribing, with the partial text. */
export function useStt(): SttSnapshot {
  useEffect(ensureEvents, [])
  return useSyncExternalStore(stt.subscribe, stt.getSnapshot)
}

// ---- the local model ----

const modelListeners = new Set<() => void>()
let model: SttModelStatus | null = null

function setModel(next: SttModelStatus | null): void {
  model = next
  for (const listener of modelListeners) listener()
}

export async function refreshSttModel(): Promise<void> {
  try {
    const status = await sttApi.sttModelStatus()
    if (status) setModel(status)
  } catch {
    // The row simply shows no status.
  }
}

/** Ask main to download the model (after the consent dialog). */
export async function downloadSttModel(): Promise<boolean> {
  try {
    if (model) setModel({ ...model, state: 'downloading', bytes: 0 })
    await sttApi.sttDownloadModel()
    void refreshSttModel()
    return true
  } catch {
    // Main also sends stt-error for a failed download, which is what is reported.
    void refreshSttModel()
    return false
  }
}

/** The local model's state (null until main has answered). Updates while it downloads. */
export function useSttModel(): SttModelStatus | null {
  useEffect(() => {
    ensureEvents()
    void refreshSttModel()
  }, [])
  return useSyncExternalStore(
    (listener) => {
      modelListeners.add(listener)
      return () => {
        modelListeners.delete(listener)
      }
    },
    () => model
  )
}

// ---- main-process events ----

let listening = false

/** Subscribe to the stt-* events once (lazily, so a window without the bridge's event channel still loads). */
function ensureEvents(): void {
  if (listening || typeof bridge?.onEvent !== 'function') return
  listening = true
  bridge.onEvent((e) => {
    if (e.type === 'stt-partial' || e.type === 'stt-error') stt.handleEvent(e)
    else if (e.type === 'stt-model') {
      if (!model) return void refreshSttModel()
      const done = e.state === 'ready' && model.state === 'downloading'
      setModel({ ...model, state: e.state, bytes: e.bytes, total: e.total })
      if (done) announce(tNow('stt.model.ready'), 'stt:model')
    }
  })
}
