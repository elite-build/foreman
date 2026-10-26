// @vitest-environment jsdom
// Phase G2 of the accessibility plan, the renderer's half: push-to-talk dictation. It runs on the real renderer store and
// the real controller (stt.ts) with only the bridge to the main process, the microphone (getUserMedia, AudioContext and
// the worklet node) and `announce` stood in for. What the person hears goes through `announce`, which records it.
import '../domShims'

// The bridge to the main process, in place before the store module reads `window.foreman`. Several listeners, as the
// real one has: the store's and stt.ts's.
const bridge = vi.hoisted(() => {
  const invoke: Record<string, ReturnType<typeof vi.fn>> = {}
  const handlers = new Set<(event: unknown) => void>()
  const nothing = new Proxy({}, { get: () => () => undefined })
  ;(window as unknown as { foreman: unknown }).foreman = {
    invoke: new Proxy(invoke, { get: (target, name: string) => (target[name] ??= vi.fn(async () => undefined)) }),
    onEvent: (handler: (event: unknown) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    send: nothing,
    browser: nothing
  }
  return { invoke, handlers }
})

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { announce } from '../../src/renderer/src/announce'
import { AskOverlay } from '../../src/renderer/src/components/assistant/AskOverlay'
import { AccessibilityPage } from '../../src/renderer/src/components/settings/AccessibilityPage'
import { SttChip } from '../../src/renderer/src/components/SttChip'
import { matchShortcut, shortcutHint, SHORTCUTS, type ShortcutContext } from '../../src/renderer/src/shortcuts'
import { closeAsk, getState, initStore, useStore } from '../../src/renderer/src/store'
import { createStt, pushToTalkPressed, stt } from '../../src/renderer/src/stt'
import { Framer } from '../../src/renderer/src/sttWorklet'

vi.mock('../../src/renderer/src/announce', () => ({ announce: vi.fn() }))

// ---- the stand-ins ----

type Settings = Record<string, unknown>

function snapshot(settings: Settings = {}) {
  return {
    platform: 'win32',
    settings: { language: undefined, assistantEnabled: false, pushToTalk: 'hold', sttProvider: 'local', sttLanguage: 'en', privacyMode: false, announce: 'my-chat', agentPrefs: {}, loadouts: [], ...settings },
    repos: [],
    repoSettings: {},
    workspaces: [],
    sessions: [],
    catalog: { agents: {} },
    agentKeys: {}
  }
}

async function seed(settings: Settings = {}) {
  bridge.invoke.getSnapshot = vi.fn(async () => snapshot(settings))
  bridge.invoke.pendingApprovals = vi.fn(async () => [])
  bridge.invoke.assistantState = vi.fn(async () => ({ gate: { state: 'ready', agent: 'claude', model: 'm' }, threads: [] }))
  bridge.invoke.assistantSend = vi.fn(async () => ({ threadId: 'ask-1' }))
  await initStore()
}

const emit = (event: unknown) => act(() => void [...bridge.handlers].forEach((handler) => handler(event)))

/** A microphone: getUserMedia, an AudioContext and the capture worklet's node, which tests feed frames through. */
function stubMicrophone(options: { deny?: boolean } = {}) {
  const track = { stop: vi.fn() }
  const getUserMedia = vi.fn(async () => {
    if (options.deny) throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
    return { getTracks: () => [track] }
  })
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
  const nodes: FakeNode[] = []
  const contexts: FakeContext[] = []
  class FakeNode {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      // The worklet answers a flush with its last frame (none here) and an acknowledgement.
      postMessage: vi.fn((message: { type?: string }) => {
        if (message.type === 'flush') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'flushed' } }))
      })
    }
    connect = vi.fn()
    disconnect = vi.fn()
    constructor() {
      nodes.push(this)
    }
  }
  class FakeContext {
    state = 'running'
    audioWorklet = { addModule: vi.fn(async () => undefined) }
    destination = {}
    close = vi.fn(async () => undefined)
    constructor(public options: unknown) {
      contexts.push(this)
    }
    createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() })
    createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })
  }
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('AudioWorkletNode', FakeNode)
  /** One frame of `samples` int16 samples from the worklet. */
  const frame = (samples = 1600) => nodes[0].port.onmessage?.({ data: { type: 'frame', pcm: new Int16Array(samples).buffer } })
  return { track, getUserMedia, nodes, contexts, frame }
}

const spoken = () => vi.mocked(announce).mock.calls
const spokenFor = (key: string) => spoken().filter((call) => call[1] === key).map((call) => call[0])
const key = (type: 'keyUp' | 'keyDown', code: string) => act(() => void fireEvent[type](window, { code, key: code === 'KeyV' ? 'v' : code }))
/** Let the awaited steps of a session (engine, microphone) run. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))
const press = (repeat = false) => act(() => pushToTalkPressed({ code: 'KeyV', repeat }))

let mic: ReturnType<typeof stubMicrophone>

beforeEach(async () => {
  for (const name of Object.keys(bridge.invoke)) delete bridge.invoke[name]
  vi.mocked(announce).mockClear()
  mic = stubMicrophone()
  bridge.invoke.sttStart = vi.fn(async () => ({ sessionId: 'sid-1', provider: 'local' }))
  bridge.invoke.sttAudio = vi.fn(async () => undefined)
  bridge.invoke.sttStop = vi.fn(async () => ({ text: 'what needs me' }))
  bridge.invoke.sttCancel = vi.fn(async () => undefined)
  await seed()
})
afterEach(() => {
  stt.cancel()
  cleanup()
  closeAsk()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A controlled textarea beside a mirror of its React state, so a test can tell the state followed the DOM. */
function Composer({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <label>
        Message
        <textarea value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <output aria-label="state">{value}</output>
      <button type="button">elsewhere</button>
    </>
  )
}
const message = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
const mirror = () => screen.getByLabelText('state').textContent

describe('the shortcut', () => {
  it('is Ctrl+Alt+V (Cmd+Option+V on macOS) in the registry, and the settings and palette can name it', () => {
    const entry = SHORTCUTS.find((e) => e.id === 'stt.pushToTalk')!
    expect(entry.keys).toEqual({ mac: 'mod+alt+KeyV', win: 'mod+alt+KeyV' })
    expect(matchShortcut({ code: 'KeyV', ctrlKey: true, metaKey: false, altKey: true, shiftKey: false }, 'win32')?.id).toBe('stt.pushToTalk')
    expect(matchShortcut({ code: 'KeyV', ctrlKey: false, metaKey: true, altKey: true, shiftKey: false }, 'darwin')?.id).toBe('stt.pushToTalk')
    expect(shortcutHint('stt.pushToTalk', 'win32')).toBe('Ctrl+Alt+V')
    expect(shortcutHint('stt.pushToTalk', 'darwin')).toBe('⌘⌥V')
  })

  it('runs the controller, passing on whether the key is repeating', async () => {
    const entry = SHORTCUTS.find((e) => e.id === 'stt.pushToTalk')!
    const run = (repeat: boolean) => act(() => entry.run!({ event: { code: 'KeyV', ctrlKey: true, altKey: true, repeat } } as unknown as ShortcutContext))
    run(false)
    run(true)
    await settle()
    expect(bridge.invoke.sttStart).toHaveBeenCalledTimes(1)
    expect(stt.getSnapshot().state).toBe('listening')
  })
})

describe('hold mode', () => {
  it('starts on the key-down, once however long it repeats, and says "Listening" once', async () => {
    press()
    press(true)
    press(true)
    await settle()
    expect(bridge.invoke.sttStart).toHaveBeenCalledTimes(1)
    expect(bridge.invoke.sttStart).toHaveBeenCalledWith({ language: 'en' })
    expect(mic.getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true } })
    expect(stt.getSnapshot()).toMatchObject({ state: 'listening', provider: 'local' })
    expect(spokenFor('stt:state')).toEqual(['Listening'])
  })

  it('streams 16 kHz frames to the engine under the session id, and stops forwarding once stopped', async () => {
    press()
    await settle()
    mic.frame(1600)
    expect(bridge.invoke.sttAudio).toHaveBeenCalledTimes(1)
    const [id, pcm] = bridge.invoke.sttAudio.mock.calls[0] as [string, Uint8Array]
    expect(id).toBe('sid-1')
    expect(pcm).toBeInstanceOf(Uint8Array)
    expect(pcm.byteLength).toBe(3200)
    key('keyUp', 'KeyV')
    await settle()
    mic.frame(1600)
    expect(bridge.invoke.sttAudio).toHaveBeenCalledTimes(1)
  })

  it('stops on the key-up of V, asks for the transcript, and releases the microphone', async () => {
    press()
    await settle()
    key('keyUp', 'KeyV')
    await settle()
    expect(bridge.invoke.sttStop).toHaveBeenCalledWith('sid-1')
    expect(mic.track.stop).toHaveBeenCalled()
    expect(mic.contexts[0].close).toHaveBeenCalled()
    expect(stt.getSnapshot().state).toBe('idle')
  })

  it.each([['Control', 'ControlLeft'], ['Alt', 'AltLeft']])('stops when the %s key is let go first', async (_name, code) => {
    press()
    await settle()
    key('keyUp', code)
    await settle()
    expect(bridge.invoke.sttStop).toHaveBeenCalledTimes(1)
  })

  it('ignores the key-up of any other key', async () => {
    press()
    await settle()
    key('keyUp', 'KeyA')
    await settle()
    expect(bridge.invoke.sttStop).not.toHaveBeenCalled()
    expect(stt.getSnapshot().state).toBe('listening')
  })

  it('stops when the window loses focus', async () => {
    press()
    await settle()
    act(() => void fireEvent.blur(window))
    await settle()
    expect(bridge.invoke.sttStop).toHaveBeenCalledTimes(1)
    expect(mic.track.stop).toHaveBeenCalled()
  })

  it('stops as soon as the microphone is open when the key came up before it was', async () => {
    let ready: () => void = () => undefined
    bridge.invoke.sttStart = vi.fn(() => new Promise((resolve) => (ready = () => resolve({ sessionId: 'sid-1', provider: 'local' }))))
    press()
    key('keyUp', 'KeyV')
    expect(bridge.invoke.sttStop).not.toHaveBeenCalled()
    ready()
    await settle()
    expect(bridge.invoke.sttStop).toHaveBeenCalledWith('sid-1')
  })

  it('removes its key listeners when the session ends, so a later key-up does nothing', async () => {
    press()
    await settle()
    key('keyUp', 'KeyV')
    await settle()
    key('keyUp', 'KeyV')
    await settle()
    expect(bridge.invoke.sttStop).toHaveBeenCalledTimes(1)
  })

  it('treats a fresh press while listening as the end (a macOS key-up can go missing under Command)', async () => {
    press()
    await settle()
    press()
    await settle()
    expect(bridge.invoke.sttStop).toHaveBeenCalledTimes(1)
  })

  it('cancels on Escape, throwing the audio away', async () => {
    press()
    await settle()
    key('keyDown', 'Escape')
    await settle()
    expect(bridge.invoke.sttCancel).toHaveBeenCalledWith('sid-1')
    expect(bridge.invoke.sttStop).not.toHaveBeenCalled()
    expect(mic.track.stop).toHaveBeenCalled()
    expect(spokenFor('stt:state')).toContain('Dictation cancelled')
  })
})

describe('toggle mode', () => {
  beforeEach(() => seed({ pushToTalk: 'toggle' }))

  it('starts on one press and stops on the next; key-ups and a blur do not stop it', async () => {
    press()
    await settle()
    key('keyUp', 'KeyV')
    key('keyUp', 'ControlLeft')
    act(() => void fireEvent.blur(window))
    await settle()
    expect(bridge.invoke.sttStop).not.toHaveBeenCalled()
    expect(stt.getSnapshot().state).toBe('listening')
    press(true)
    expect(bridge.invoke.sttStop).not.toHaveBeenCalled()
    press()
    await settle()
    expect(bridge.invoke.sttStop).toHaveBeenCalledWith('sid-1')
    expect(stt.getSnapshot().state).toBe('idle')
  })

  it('can be stopped from the chip', async () => {
    render(<SttChip />)
    press()
    await settle()
    await userEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))
    await settle()
    expect(bridge.invoke.sttStop).toHaveBeenCalledTimes(1)
  })
})

describe('the 60 second cap', () => {
  it('stops by itself, and says so', async () => {
    vi.useFakeTimers()
    press()
    await vi.advanceTimersByTimeAsync(0)
    expect(stt.getSnapshot().state).toBe('listening')
    await vi.advanceTimersByTimeAsync(59_000)
    expect(bridge.invoke.sttStop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(bridge.invoke.sttStop).toHaveBeenCalledWith('sid-1')
    expect(spokenFor('stt:cap')).toEqual(['Stopped after 60 seconds'])
    expect(mic.track.stop).toHaveBeenCalled()
  })

  it('is not left running after an earlier stop', async () => {
    vi.useFakeTimers()
    press()
    await vi.advanceTimersByTimeAsync(0)
    key('keyUp', 'KeyV')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(bridge.invoke.sttStop).toHaveBeenCalledTimes(1)
  })
})

describe('where the words go', () => {
  // These tests render the overlay, so the assistant is on.
  beforeEach(() => seed({ assistantEnabled: true }))

  function Page() {
    const open = useStore((s) => s.overlay === 'ask')
    return (
      <>
        <button type="button">opener</button>
        {open && <AskOverlay />}
      </>
    )
  }

  it('puts them at the caret of the focused text field and keeps the field’s React state in step', async () => {
    render(<Composer initial="hello world" />)
    message().focus()
    message().setSelectionRange(5, 5)
    bridge.invoke.sttStop = vi.fn(async () => ({ text: 'brave' }))
    press()
    await settle()
    // Focus stays where it was while the key is held.
    expect(document.activeElement).toBe(message())
    key('keyUp', 'KeyV')
    await waitFor(() => expect(mirror()).toBe('hello brave world'))
    expect(message().value).toBe('hello brave world')
    expect(message().selectionStart).toBe('hello brave'.length)
    expect(spokenFor('stt:final')).toEqual(['Heard: brave'])
    // Not sent, and the Ask overlay did not open.
    expect(getState().overlay).toBeNull()
  })

  it('replaces a selection', async () => {
    render(<Composer initial="open the old one" />)
    message().focus()
    message().setSelectionRange(9, 12)
    bridge.invoke.sttStop = vi.fn(async () => ({ text: 'new' }))
    press()
    await settle()
    key('keyUp', 'KeyV')
    await waitFor(() => expect(mirror()).toBe('open the new one'))
  })

  it('puts them in an empty field without a leading space', async () => {
    render(<Composer />)
    message().focus()
    press()
    await settle()
    key('keyUp', 'KeyV')
    await waitFor(() => expect(mirror()).toBe('what needs me'))
  })

  it('does not type into a password field: that is no place for words, so they go to the Ask overlay', async () => {
    render(
      <>
        <input type="password" aria-label="Secret" />
        <Page />
      </>
    )
    screen.getByLabelText('Secret').focus()
    press()
    await settle()
    key('keyUp', 'KeyV')
    const field = (await screen.findByRole('textbox', { name: 'Ask a question' })) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('what needs me'))
    expect((screen.getByLabelText('Secret') as HTMLInputElement).value).toBe('')
  })

  it('opens the Ask overlay with the words in its field when no text field has focus, and sends nothing', async () => {
    render(<Page />)
    screen.getByRole('button', { name: 'opener' }).focus()
    press()
    await settle()
    key('keyUp', 'KeyV')
    const field = (await screen.findByRole('textbox', { name: 'Ask a question' })) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('what needs me'))
    expect(getState().overlay).toBe('ask')
    expect(document.activeElement).toBe(field)
    expect(bridge.invoke.assistantSend).not.toHaveBeenCalled()
    expect(spokenFor('stt:final')).toEqual(['Heard: what needs me'])
    // The person can edit it, and Enter sends.
    await userEvent.type(field, ' today{Enter}')
    await waitFor(() => expect(bridge.invoke.assistantSend).toHaveBeenCalled())
    expect((bridge.invoke.assistantSend.mock.calls[0] as unknown[])[1]).toBe('what needs me today')
  })

  it('keeps what is already in the Ask field and adds to it', async () => {
    render(<Page />)
    screen.getByRole('button', { name: 'opener' }).focus()
    press()
    await settle()
    key('keyUp', 'KeyV')
    const field = (await screen.findByRole('textbox', { name: 'Ask a question' })) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('what needs me'))
    field.blur()
    screen.getByRole('button', { name: 'Read the last reply' }).focus()
    bridge.invoke.sttStop = vi.fn(async () => ({ text: 'and why' }))
    press()
    await settle()
    key('keyUp', 'KeyV')
    await waitFor(() => expect(field.value).toBe('what needs me and why'))
  })

  it('says where the words went when the assistant is off and no field has focus', async () => {
    await seed({ assistantEnabled: false })
    press()
    await settle()
    key('keyUp', 'KeyV')
    await waitFor(() => expect(spokenFor('stt:final')).toHaveLength(1))
    expect(spokenFor('stt:final')[0]).toContain('Heard: what needs me')
    expect(spokenFor('stt:final')[0]).toContain('no text field')
    expect(getState().overlay).toBeNull()
  })

  it('says it heard nothing for an empty transcript', async () => {
    bridge.invoke.sttStop = vi.fn(async () => ({ text: '  ' }))
    render(<Composer />)
    message().focus()
    press()
    await settle()
    key('keyUp', 'KeyV')
    await waitFor(() => expect(spokenFor('stt:final')).toEqual(['Heard nothing']))
    expect(mirror()).toBe('')
  })
})

describe('what is said and shown while listening', () => {
  it('says "Transcribing" only for an engine that gives no partial text', async () => {
    bridge.invoke.sttStart = vi.fn(async () => ({ sessionId: 'sid-1', provider: 'openai' }))
    press()
    await settle()
    key('keyUp', 'KeyV')
    await settle()
    expect(spokenFor('stt:state')).toEqual(['Listening', 'Transcribing'])
    vi.mocked(announce).mockClear()
    bridge.invoke.sttStart = vi.fn(async () => ({ sessionId: 'sid-2', provider: 'local' }))
    press()
    await settle()
    key('keyUp', 'KeyV')
    await settle()
    expect(spokenFor('stt:state')).toEqual(['Listening'])
  })

  it('shows the state and the partial text in a status chip that is not read aloud a second time', async () => {
    render(<SttChip />)
    expect(screen.queryByRole('status')).toBeNull()
    press()
    await settle()
    const chip = screen.getByRole('status')
    expect(chip.getAttribute('aria-live')).toBe('off')
    expect(within(chip).getByText('Listening…')).toBeTruthy()
    await emit({ type: 'stt-partial', sessionId: 'sid-1', text: 'what needs' })
    expect(within(chip).getByText('what needs')).toBeTruthy()
    await emit({ type: 'stt-partial', sessionId: 'sid-1', text: 'what needs me' })
    expect(within(chip).getByText('what needs me')).toBeTruthy()
    // Another session's partial text is not shown.
    await emit({ type: 'stt-partial', sessionId: 'other', text: 'not mine' })
    expect(within(chip).queryByText('not mine')).toBeNull()
  })

  it('shows "Transcribing…" while the engine finishes, then goes away', async () => {
    let finish: (value: { text: string }) => void = () => undefined
    bridge.invoke.sttStop = vi.fn(() => new Promise((resolve) => (finish = resolve)))
    render(<SttChip />)
    press()
    await settle()
    key('keyUp', 'KeyV')
    await settle()
    expect(within(screen.getByRole('status')).getByText('Transcribing…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop dictation' })).toBeNull()
    await act(async () => finish({ text: 'done' }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })
})

describe('errors', () => {
  it('announces and toasts an error event, and ends the session', async () => {
    press()
    await settle()
    await emit({ type: 'stt-error', sessionId: 'sid-1', message: 'The speech model could not be loaded.' })
    expect(spokenFor('stt:error')).toEqual(['The speech model could not be loaded.'])
    expect(getState().toast).toMatchObject({ text: 'The speech model could not be loaded.', kind: 'error' })
    expect(stt.getSnapshot().state).toBe('idle')
    expect(mic.track.stop).toHaveBeenCalled()
    expect(bridge.invoke.sttCancel).toHaveBeenCalledWith('sid-1')
  })

  it('ignores another session’s error for the session in progress, but still reports it', async () => {
    press()
    await settle()
    await emit({ type: 'stt-error', sessionId: 'old', message: 'Old trouble.' })
    expect(stt.getSnapshot().state).toBe('listening')
    expect(spokenFor('stt:error')).toEqual(['Old trouble.'])
  })

  it('explains a refused microphone, and gives the engine its session back', async () => {
    mic = stubMicrophone({ deny: true })
    press()
    await settle()
    expect(spokenFor('stt:error')[0]).toContain('microphone')
    expect(getState().toast?.kind).toBe('error')
    expect(stt.getSnapshot().state).toBe('idle')
    expect(bridge.invoke.sttCancel).toHaveBeenCalledWith('sid-1')
  })

  it('reports a refusal from the engine (Privacy mode with OpenAI) and stays idle', async () => {
    bridge.invoke.sttStart = vi.fn(async () => {
      throw new Error('Privacy mode is on, so OpenAI speech to text is blocked.')
    })
    press()
    await settle()
    expect(spokenFor('stt:error')[0]).toContain('Privacy mode is on')
    expect(stt.getSnapshot().state).toBe('idle')
    expect(mic.getUserMedia).not.toHaveBeenCalled()
  })

  it('can start again after an error', async () => {
    mic = stubMicrophone({ deny: true })
    press()
    await settle()
    mic = stubMicrophone()
    press()
    await settle()
    expect(stt.getSnapshot().state).toBe('listening')
  })
})

describe('a controller of its own', () => {
  it('asks the capture it is given, and delivers where it is told', async () => {
    const stop = vi.fn(async () => undefined)
    const deliver = vi.fn(async () => 'field' as const)
    const own = createStt({ openCapture: vi.fn(async () => ({ stop })), deliver })
    await own.start()
    await own.stop()
    expect(stop).toHaveBeenCalledWith(true)
    expect(deliver).toHaveBeenCalledWith('what needs me')
    expect(own.getSnapshot().state).toBe('idle')
  })
})

describe('Framer', () => {
  const run = (rate: number, input: Float32Array, frameSamples = 1600) => {
    const frames: Int16Array[] = []
    const framer = new Framer(rate, (frame) => frames.push(frame), frameSamples)
    framer.push(input)
    return { frames, framer }
  }

  it('passes 16 kHz samples through as 16-bit values, 1600 to a frame', () => {
    const { frames } = run(16000, new Float32Array(3300).fill(0.5))
    expect(frames).toHaveLength(2)
    expect(frames[0]).toHaveLength(1600)
    expect(frames[0][0]).toBe(Math.floor(0.5 * 0x7fff))
  })

  it('halves 32 kHz to 16 kHz', () => {
    const { frames, framer } = run(32000, new Float32Array(3300).fill(0.25), 800)
    expect(frames).toHaveLength(2)
    framer.flush()
    expect(frames.reduce((n, f) => n + f.length, 0)).toBeGreaterThanOrEqual(1600)
    expect(Math.abs(frames[0][10] - 0.25 * 0x7fff)).toBeLessThanOrEqual(1)
  })

  it('takes 48 kHz to 16 kHz across blocks without a gap, so the length is a third', () => {
    const frames: Int16Array[] = []
    const framer = new Framer(48000, (frame) => frames.push(frame), 100)
    for (let i = 0; i < 30; i++) framer.push(new Float32Array(128).fill(-1))
    framer.flush()
    const total = frames.reduce((n, f) => n + f.length, 0)
    expect(Math.abs(total - (30 * 128) / 3)).toBeLessThanOrEqual(2)
    expect(frames[0][0]).toBe(-0x8000)
  })

  it('clamps to the 16-bit range', () => {
    const { frames } = run(16000, new Float32Array(10).fill(3), 4)
    expect(frames[0][0]).toBe(0x7fff)
  })

  it('flushes what is left as a shorter frame, and nothing when it is empty', () => {
    const { frames, framer } = run(16000, new Float32Array(8), 10)
    expect(frames).toHaveLength(0)
    framer.flush()
    expect(frames).toHaveLength(1)
    expect(frames[0]).toHaveLength(7)
    framer.flush()
    expect(frames).toHaveLength(1)
  })
})

describe('Settings → Accessibility → Speech input', () => {
  const model = (over: Record<string, unknown> = {}) => ({ state: 'missing', name: 'Zipformer English (int8)', sizeMb: 118, source: 'github.com/k2-fsa/sherpa-onnx', ...over })

  beforeEach(() => {
    bridge.invoke.updateSettings = vi.fn(async () => ({}))
    bridge.invoke.resetSettings = vi.fn(async () => ({}))
    bridge.invoke.sttModelStatus = vi.fn(async () => model())
    bridge.invoke.sttDownloadModel = vi.fn(async () => undefined)
    bridge.invoke.opencodeProviders = vi.fn(async () => [])
    bridge.invoke.setProviderKey = vi.fn(async () => undefined)
  })

  it('has named controls, with the chord in the help for the key', async () => {
    render(<AccessibilityPage />)
    expect(screen.getByRole('heading', { level: 2, name: 'Speech input' })).toBeTruthy()
    const mode = screen.getByRole('radiogroup', { name: 'Push to talk' })
    expect(within(mode).getByRole('radio', { name: 'Hold to talk' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radiogroup', { name: 'Speech to text engine' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Dictation language' }) as HTMLInputElement).value).toBe('en')
    expect(screen.getByText(/Dictate with Ctrl\+Alt\+V while this window has focus/)).toBeTruthy()
    await screen.findByText('Not downloaded')
  })

  it('saves the push-to-talk mode, the engine and the language', async () => {
    render(<AccessibilityPage />)
    await userEvent.click(screen.getByRole('radio', { name: 'Press to start, press to stop' }))
    expect(bridge.invoke.updateSettings).toHaveBeenCalledWith({ pushToTalk: 'toggle' })
    await userEvent.click(screen.getByRole('radio', { name: 'OpenAI' }))
    expect(bridge.invoke.updateSettings).toHaveBeenCalledWith({ sttProvider: 'openai' })
    const language = screen.getByRole('textbox', { name: 'Dictation language' })
    await userEvent.clear(language)
    await userEvent.type(language, 'pt-BR')
    await userEvent.tab()
    expect(bridge.invoke.updateSettings).toHaveBeenCalledWith({ sttLanguage: 'pt-BR' })
  })

  it('refuses a language that is not a language code, and puts the saved one back', async () => {
    render(<AccessibilityPage />)
    const language = screen.getByRole('textbox', { name: 'Dictation language' }) as HTMLInputElement
    await userEvent.clear(language)
    await userEvent.type(language, 'english please')
    await userEvent.tab()
    expect(bridge.invoke.updateSettings).not.toHaveBeenCalledWith(expect.objectContaining({ sttLanguage: expect.anything() }))
    expect(getState().toast).toMatchObject({ text: 'Use a language code such as en or pt-BR.', kind: 'error' })
    expect(language.value).toBe('en')
  })

  it('shows the model row for the local engine, and the OpenAI key row only for OpenAI', async () => {
    await seed({ sttProvider: 'openai' })
    const { unmount } = render(<AccessibilityPage />)
    expect(screen.getByLabelText('OpenAI API key')).toBeTruthy()
    expect(screen.queryByText('Speech model')).toBeNull()
    unmount()
    await seed({ sttProvider: 'local' })
    render(<AccessibilityPage />)
    expect(await screen.findByText('Speech model')).toBeTruthy()
    expect(screen.queryByLabelText('OpenAI API key')).toBeNull()
  })

  it('saves the OpenAI key as OPENAI_API_KEY, hides it as typed, and offers Remove once saved', async () => {
    await seed({ sttProvider: 'openai' })
    render(<AccessibilityPage />)
    const field = screen.getByLabelText('OpenAI API key') as HTMLInputElement
    expect(field.type).toBe('password')
    expect(screen.getByText('No key yet')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    await userEvent.type(field, 'sk-test-123')
    await userEvent.click(screen.getByRole('button', { name: 'Reveal API key' }))
    expect(field.type).toBe('text')
    bridge.invoke.opencodeProviders = vi.fn(async () => [{ envVar: 'OPENAI_API_KEY', saved: true, detected: false }])
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(bridge.invoke.setProviderKey).toHaveBeenCalledWith('OPENAI_API_KEY', 'sk-test-123')
    expect(await screen.findByText('Key saved')).toBeTruthy()
    expect(field.value).toBe('')
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(bridge.invoke.setProviderKey).toHaveBeenCalledWith('OPENAI_API_KEY', null)
  })

  it('warns that Privacy mode blocks OpenAI, only when both are true', async () => {
    await seed({ sttProvider: 'openai', privacyMode: true })
    const { unmount } = render(<AccessibilityPage />)
    expect(screen.getByText(/Privacy mode is on, so dictation with OpenAI is blocked/)).toBeTruthy()
    unmount()
    await seed({ sttProvider: 'local', privacyMode: true })
    render(<AccessibilityPage />)
    expect(screen.queryByText(/dictation with OpenAI is blocked/)).toBeNull()
  })

  it('shows the model’s name, size and state', async () => {
    render(<AccessibilityPage />)
    expect(await screen.findByText(/Zipformer English \(int8\), 118 MB/)).toBeTruthy()
    expect(screen.getByText('Not downloaded')).toBeTruthy()
  })

  it('asks before downloading: the dialog names the size and the source, and nothing is fetched until it is accepted', async () => {
    render(<AccessibilityPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Download' }))
    const dialog = await screen.findByRole('dialog', { name: 'Download the speech model?' })
    expect(dialog.textContent).toContain('118 MB')
    expect(dialog.textContent).toContain('github.com/k2-fsa/sherpa-onnx')
    expect(bridge.invoke.sttDownloadModel).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(bridge.invoke.sttDownloadModel).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Download the speech model?' })).getByRole('button', { name: 'Download' }))
    expect(bridge.invoke.sttDownloadModel).toHaveBeenCalledTimes(1)
  })

  it('shows progress while the model downloads, and says when it is ready', async () => {
    bridge.invoke.sttModelStatus = vi.fn(async () => model({ state: 'downloading', bytes: 59_000_000, total: 118_000_000 }))
    render(<AccessibilityPage />)
    expect(await screen.findByText('Downloaded 59 of 118 MB (50 percent)')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
    await emit({ type: 'stt-model', state: 'downloading', bytes: 118_000_000 / 4 * 3, total: 118_000_000 })
    expect(await screen.findByText('Downloaded 89 of 118 MB (75 percent)')).toBeTruthy()
    await emit({ type: 'stt-model', state: 'ready' })
    expect(await screen.findByText('Ready')).toBeTruthy()
    expect(spokenFor('stt:model')).toEqual(['Speech model downloaded'])
  })
})
