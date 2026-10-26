import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core, type Host } from '../src/main/core'
import { SecretStore } from '../src/main/secrets'
import { SpeechService, type SpeechServiceOptions } from '../src/main/speech'
import { tidyTranscript } from '../src/main/speech/local'
import { STT_MODEL, type SttModelInfo } from '../src/main/speech/models'
import { OPENAI_TRANSCRIPTION_MODEL, OPENAI_TRANSCRIPTION_URL } from '../src/main/speech/openai'
import { allowPermission } from '../src/main/speech/permissions'
import { encodeControl, encodeFrame, FrameDecoder, KIND_AUDIO, KIND_CONTROL, parseReply } from '../src/main/speech/protocol'
import { pcmToWav } from '../src/main/speech/provider'
import { Store } from '../src/main/store'
import type { MainEvent, Settings } from '../src/shared/types'
import { tempDir } from './helpers'

const FAKE_HELPER = fileURLToPath(new URL('./fixtures/stt-fake-helper.mjs', import.meta.url))

// A model small enough to write and "download" in a test: four files with known sizes and hashes.
const sha = (data: string) => createHash('sha256').update(data).digest('hex')
const CONTENT: Record<string, string> = { 'enc.onnx': 'encoder-bytes', 'dec.onnx': 'decoder', 'join.onnx': 'joiner!', 'tokens.txt': 'a\nb\n' }
const TINY: SttModelInfo = {
  name: 'tiny-model',
  source: 'example.test/tiny',
  baseUrl: 'https://example.test/tiny/',
  files: Object.entries(CONTENT).map(([name, data]) => ({ name, bytes: data.length, sha256: sha(data) })),
  roles: { encoder: 'enc.onnx', decoder: 'dec.onnx', joiner: 'join.onnx', tokens: 'tokens.txt' }
}

function installTinyModel(dir: string): void {
  const target = path.join(dir, 'stt-models', TINY.name)
  mkdirSync(target, { recursive: true })
  for (const [name, data] of Object.entries(CONTENT)) writeFileSync(path.join(target, name), data)
}

const pcm = (bytes = 3200, fill = 1) => new Uint8Array(bytes).fill(fill)
const wait = async (until: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!until()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

type Rig = ReturnType<typeof rig>
async function rig(options: Omit<Partial<SpeechServiceOptions>, 'settings' | 'model'> & { settings?: Partial<Settings>; model?: boolean } = {}) {
  const { settings: overrides, model, ...service } = options
  const dir = await tempDir('foreman-stt-')
  if (model !== false) installTinyModel(dir)
  const events: MainEvent[] = []
  const log = path.join(dir, 'helper-log.json')
  const settings = { sttProvider: 'local', sttLanguage: 'en', privacyMode: false, ...overrides } as Pick<Settings, 'sttProvider' | 'sttLanguage' | 'privacyMode'>
  const keys: Record<string, string> = {}
  const speech = new SpeechService({
    dir,
    settings: () => settings,
    providerKey: (name) => keys[name],
    broadcast: (event) => events.push(event),
    helper: () => ({ command: process.execPath, args: [FAKE_HELPER], env: { FAKE_STT_LOG: log } }),
    model: TINY,
    stopTimeoutMs: 500,
    ...service
  })
  return { service: speech, events, dir, log, settings, keys, helperLog: () => JSON.parse(readFileSync(log, 'utf8')) as { start: { language: string; model: Record<string, string> }; bytes: number; frames: number } }
}

const opened: SpeechService[] = []
afterEach(() => {
  for (const service of opened.splice(0)) service.dispose()
  vi.unstubAllGlobals()
})
async function started(options: Parameters<typeof rig>[0] = {}): Promise<Awaited<Rig> & { sessionId: string }> {
  const r = await rig(options)
  opened.push(r.service)
  const { sessionId } = await r.service.start({})
  return { ...r, sessionId }
}

describe('speech: the helper protocol', () => {
  it('puts frames back together from chunks of any size', () => {
    const wire = Buffer.concat([encodeControl({ type: 'stop' }), encodeFrame(KIND_AUDIO, Buffer.from([1, 2, 3, 4])), encodeFrame(KIND_AUDIO, Buffer.alloc(0))])
    const decoder = new FrameDecoder()
    const frames = []
    for (let i = 0; i < wire.length; i += 3) frames.push(...decoder.push(wire.subarray(i, i + 3)))
    expect(frames.map((f) => [f.kind, f.payload.length])).toEqual([[KIND_CONTROL, JSON.stringify({ type: 'stop' }).length], [KIND_AUDIO, 4], [KIND_AUDIO, 0]])
    expect(JSON.parse(frames[0].payload.toString())).toEqual({ type: 'stop' })
  })

  it('refuses a frame of an unknown kind or an absurd size', () => {
    expect(() => new FrameDecoder().push(Buffer.from([0x7a, 0, 0, 0, 0]))).toThrow(/kind/)
    const huge = Buffer.alloc(5)
    huge[0] = KIND_AUDIO
    huge.writeUInt32LE(2 ** 30, 1)
    expect(() => new FrameDecoder().push(huge)).toThrow(/too large/)
  })

  it('reads only well-formed replies', () => {
    expect(parseReply('{"type":"partial","text":"hi"}')).toEqual({ type: 'partial', text: 'hi' })
    expect(parseReply('{"type":"error","message":"no"}')).toEqual({ type: 'error', message: 'no' })
    expect(parseReply('{"type":"ready"}')).toEqual({ type: 'ready' })
    expect(parseReply('{"type":"partial"}')).toBeNull()
    expect(parseReply('warming up…')).toBeNull()
  })

  it('makes the upper-case, unpunctuated model output readable', () => {
    expect(tidyTranscript('  HELLO I AM FOREMAN ')).toBe('Hello I am foreman')
    expect(tidyTranscript("I'M SURE I'LL GO IT IS TIDY")).toBe("I'm sure I'll go it is tidy")
    expect(tidyTranscript('')).toBe('')
  })

  it('wraps PCM as a 16 kHz mono 16-bit WAV', () => {
    const wav = pcmToWav(new Uint8Array([1, 0, 2, 0]))
    expect(wav.subarray(0, 4).toString()).toBe('RIFF')
    expect(wav.subarray(8, 16).toString()).toBe('WAVEfmt ')
    expect(wav.readUInt32LE(4)).toBe(36 + 4)
    expect([wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt32LE(28), wav.readUInt16LE(32), wav.readUInt16LE(34)]).toEqual([1, 1, 16000, 32000, 2, 16])
    expect(wav.subarray(36, 40).toString()).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(4)
    expect([...wav.subarray(44)]).toEqual([1, 0, 2, 0])
  })
})

describe('speech: the window may use the microphone and nothing else under media', () => {
  it('grants audio-only requests from the app window', () => {
    expect(allowPermission('media', { mediaTypes: ['audio'], isMainFrame: true }, true)).toBe(true)
  })
  it('refuses video, screen capture, other windows and subframes', () => {
    expect(allowPermission('media', { mediaTypes: ['video'], isMainFrame: true }, true)).toBe(false)
    expect(allowPermission('media', { mediaTypes: ['audio', 'video'], isMainFrame: true }, true)).toBe(false)
    expect(allowPermission('media', { isMainFrame: true }, true)).toBe(false)
    expect(allowPermission('media', { mediaTypes: ['audio'], isMainFrame: true }, false)).toBe(false)
    expect(allowPermission('media', { mediaTypes: ['audio'], isMainFrame: false }, true)).toBe(false)
    // Electron 45 and later ask for screen capture under its own name.
    expect(allowPermission('display-capture', { mediaTypes: ['video'], isMainFrame: true }, true)).toBe(false)
  })
  it('leaves every other permission as it was', () => {
    expect(allowPermission('clipboard-read', {}, true)).toBe(true)
    expect(allowPermission('notifications', {}, false)).toBe(true)
  })
})

describe('speech: a dictation with the local helper', () => {
  it('streams frames in, partial text out, and answers the final text on stop', async () => {
    const r = await started()
    const sessionId = r.sessionId
    expect(sessionId).toMatch(/[0-9a-f-]{36}/)
    await r.service.audio(sessionId, pcm())
    await wait(() => r.events.some((e) => e.type === 'stt-partial' && e.text === 'Hello'))
    r.service.audio(sessionId, pcm())
    r.service.audio(sessionId, pcm())
    await wait(() => r.events.some((e) => e.type === 'stt-partial' && e.text === 'Hello I am'))
    expect(r.events.filter((e) => e.type === 'stt-partial').every((e) => e.type === 'stt-partial' && e.sessionId === sessionId)).toBe(true)

    const done = await r.service.stop(sessionId)
    expect(done).toEqual({ text: 'Hello I am' })
    const seen = r.helperLog()
    // The helper got the language and the model's absolute paths, and every byte of audio.
    expect(seen.start.language).toBe('en')
    expect(seen.start.model.encoder).toBe(path.join(r.dir, 'stt-models', TINY.name, 'enc.onnx'))
    expect(seen.bytes).toBe(3 * 3200)
    expect(r.events.some((e) => e.type === 'stt-error')).toBe(false)
  })

  it('reports the provider it started', async () => {
    const r = await rig()
    opened.push(r.service)
    expect(await r.service.start({})).toMatchObject({ provider: 'local' })
  })

  it('cancel drops the dictation and its text', async () => {
    const r = await started()
    r.service.audio(r.sessionId, pcm())
    await wait(() => r.events.some((e) => e.type === 'stt-partial'))
    r.service.cancel(r.sessionId)
    expect(await r.service.stop(r.sessionId)).toEqual({ text: '' })
    // A cancelled helper never gets to write its log (it was told nothing but to die).
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(existsSync(r.log)).toBe(false)
    // Frames that arrive late are not an error.
    expect(() => r.service.audio(r.sessionId, pcm())).not.toThrow()
  })

  it('ignores frames for another session and refuses a frame that is not PCM or is huge', async () => {
    const r = await started()
    r.service.audio('someone-else', pcm())
    expect(() => r.service.audio(r.sessionId, 'text' as unknown as Uint8Array)).toThrow(/PCM/)
    expect(() => r.service.audio(r.sessionId, new Uint8Array(1 << 20))).toThrow(/large/)
    expect(await r.service.stop(r.sessionId)).toEqual({ text: '' })
    expect(r.helperLog().bytes).toBe(0)
  })

  it('a crashed helper emits stt-error, still answers stop with the text so far, and the next dictation works', async () => {
    const r = await started()
    r.service.audio(r.sessionId, pcm())
    await wait(() => r.events.some((e) => e.type === 'stt-partial'))
    r.service.audio(r.sessionId, new Uint8Array(8).fill(0xff))
    await wait(() => r.events.some((e) => e.type === 'stt-error'))
    const error = r.events.find((e) => e.type === 'stt-error')
    expect(error).toMatchObject({ type: 'stt-error', sessionId: r.sessionId })
    expect(error && 'message' in error && error.message).toMatch(/stopped unexpectedly.*exit code 1.*boom/)

    expect(await r.service.stop(r.sessionId)).toEqual({ text: 'Hello' })
    // Foreman is fine: a new dictation starts and finishes.
    const next = await r.service.start({})
    expect(next.sessionId).not.toBe(r.sessionId)
    r.service.audio(next.sessionId, pcm())
    r.service.audio(next.sessionId, pcm())
    expect(await r.service.stop(next.sessionId)).toEqual({ text: 'Hello I' })
    expect(r.events.filter((e) => e.type === 'stt-error')).toHaveLength(1)
  })

  it('a helper that dies while stopping reports it once', async () => {
    const r = await started()
    r.service.audio(r.sessionId, new Uint8Array(8).fill(0xff))
    expect(await r.service.stop(r.sessionId)).toEqual({ text: '' })
    await wait(() => r.events.some((e) => e.type === 'stt-error'))
    expect(r.events.filter((e) => e.type === 'stt-error')).toHaveLength(1)
  })

  it('stops with what it has when the helper never answers', async () => {
    const r = await rig()
    opened.push(r.service)
    const service = new SpeechService({
      dir: r.dir,
      settings: () => r.settings,
      providerKey: () => undefined,
      broadcast: (event) => r.events.push(event),
      helper: () => ({ command: process.execPath, args: [FAKE_HELPER], env: { FAKE_STT_MODE: 'hang' } }),
      model: TINY,
      stopTimeoutMs: 150
    })
    opened.push(service)
    const { sessionId } = await service.start({})
    service.audio(sessionId, pcm())
    await wait(() => r.events.some((e) => e.type === 'stt-partial'))
    expect(await service.stop(sessionId)).toEqual({ text: 'Hello' })
  })

  it('enforces the 60 second cap in main: audio past it is dropped and the dictation ends with what it had', async () => {
    // 0.01 s is 320 bytes: two 200-byte frames, the second cut short.
    const r = await started({ maxSeconds: 0.01 })
    r.service.audio(r.sessionId, pcm(200))
    r.service.audio(r.sessionId, pcm(200))
    await wait(() => existsSync(r.log))
    r.service.audio(r.sessionId, pcm(200))
    const done = await r.service.stop(r.sessionId)
    expect(done.text).toBe('Hello I')
    expect(r.helperLog().bytes).toBe(320)
    // The capped text was also shown as a partial for the window.
    expect(r.events.filter((e) => e.type === 'stt-partial').pop()).toMatchObject({ text: 'Hello I' })
  })

  it('ends a dictation whose stop never comes, a little after the cap', async () => {
    const r = await started({ maxSeconds: 0.01, graceMs: 30 })
    r.service.audio(r.sessionId, pcm(100))
    await wait(() => existsSync(r.log))
    expect(r.helperLog().bytes).toBe(100)
    expect(await r.service.stop(r.sessionId)).toEqual({ text: 'Hello' })
  })

  it('a new dictation replaces one that was never stopped', async () => {
    const r = await started()
    r.service.audio(r.sessionId, pcm())
    const next = await r.service.start({})
    r.service.audio(r.sessionId, pcm())
    expect(await r.service.stop(r.sessionId)).toEqual({ text: '' })
    r.service.audio(next.sessionId, pcm())
    expect(await r.service.stop(next.sessionId)).toEqual({ text: 'Hello' })
  })

  it('refuses to start with a clear message when nothing was recorded', async () => {
    const noModel = await rig({ model: false })
    await expect(noModel.service.start({})).rejects.toThrow(/model is not downloaded/)
    const noHelper = await rig({ helper: () => null })
    await expect(noHelper.service.start({})).rejects.toThrow(/helper is missing/)
    const french = await rig()
    await expect(french.service.start({ language: 'fr' })).rejects.toThrow(/English only/)
    const settingsFrench = await rig({ settings: { sttLanguage: 'de' } })
    await expect(settingsFrench.service.start({})).rejects.toThrow(/English only/)
    const brokenLauncher = await rig({ helper: () => ({ command: path.join(noModel.dir, 'does-not-exist'), args: [], env: {} }) })
    await expect(brokenLauncher.service.start({})).rejects.toThrow(/could not start/)
    const mic = await rig({ microphone: async () => false })
    await expect(mic.service.start({})).rejects.toThrow(/microphone/)
  })

  it('takes the language from the request before the setting', async () => {
    const r = await rig({ settings: { sttLanguage: 'fr' } })
    opened.push(r.service)
    const { sessionId } = await r.service.start({ language: 'en-GB' })
    await r.service.stop(sessionId)
    expect(r.helperLog().start.language).toBe('en-GB')
  })
})

describe('speech: the model and its download', () => {
  const bodies = (overrides: Record<string, string> = {}): typeof fetch =>
    (async (input: string | URL | Request) => {
      const name = String(input).split('/').pop() as string
      return new Response(overrides[name] ?? CONTENT[name], { status: name in CONTENT ? 200 : 404 })
    }) as typeof fetch

  it('says what the model is and whether it is on disk', async () => {
    const r = await rig({ model: false })
    expect(r.service.modelStatus()).toEqual({ state: 'missing', name: 'tiny-model', sizeMb: 0, source: 'example.test/tiny' })
    installTinyModel(r.dir)
    expect(r.service.modelStatus().state).toBe('ready')
  })

  it('names one real model: int8 Zipformer English, about 73 MB, every file with a size and a SHA-256', () => {
    expect(STT_MODEL.name).toContain('streaming-zipformer-en')
    expect(STT_MODEL.name).toContain('int8')
    expect(STT_MODEL.baseUrl).toMatch(/^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\/$/)
    expect(STT_MODEL.files.every((f) => f.bytes > 0 && /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true)
    expect(Math.round(STT_MODEL.files.reduce((n, f) => n + f.bytes, 0) / 1e6)).toBe(73)
    expect(Object.values(STT_MODEL.roles).every((name) => STT_MODEL.files.some((f) => f.name === name))).toBe(true)
  })

  it('goes missing, downloading with progress, then ready, and the files land checked', async () => {
    const r = await rig({ model: false, fetch: bodies() })
    expect(r.service.modelStatus().state).toBe('missing')
    const during: string[] = []
    const watch = r.service.models.status.bind(r.service.models)
    const done = r.service.downloadModel()
    during.push(watch().state)
    await done
    expect(during).toEqual(['downloading'])
    expect(r.service.modelStatus().state).toBe('ready')
    const models = r.events.filter((e) => e.type === 'stt-model')
    expect(models[0]).toEqual({ type: 'stt-model', state: 'downloading', bytes: 0, total: Object.values(CONTENT).join('').length })
    expect(models.at(-1)).toEqual({ type: 'stt-model', state: 'ready' })
    expect(models.every((e) => e.type === 'stt-model' && (e.state !== 'downloading' || (e.total as number) > 0))).toBe(true)
    expect(readFileSync(path.join(r.dir, 'stt-models', TINY.name, 'enc.onnx'), 'utf8')).toBe(CONTENT['enc.onnx'])
    // No staging folder is left behind.
    expect(existsSync(path.join(r.dir, 'stt-models', `${TINY.name}.partial`))).toBe(false)
    // Already there: nothing more is fetched.
    const fetched = vi.fn(bodies())
    const again = await rig({ fetch: fetched })
    await again.service.downloadModel()
    expect(fetched).not.toHaveBeenCalled()
  })

  it('shares one download between callers and reports progress while it runs', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow = (async (input: string | URL | Request) => {
      await gate
      return bodies()(input)
    }) as typeof fetch
    const calls = vi.fn(slow)
    const r = await rig({ model: false, fetch: calls })
    const first = r.service.downloadModel()
    const second = r.service.downloadModel()
    expect(r.service.modelStatus()).toMatchObject({ state: 'downloading', bytes: 0 })
    release()
    await Promise.all([first, second])
    expect(calls).toHaveBeenCalledTimes(TINY.files.length)
  })

  it('refuses a file that fails its checksum, cleans up, goes back to missing and says why', async () => {
    const r = await rig({ model: false, fetch: bodies({ 'dec.onnx': 'tampered' }) })
    await expect(r.service.downloadModel()).rejects.toThrow(/dec\.onnx did not match/)
    expect(r.service.modelStatus().state).toBe('missing')
    expect(existsSync(path.join(r.dir, 'stt-models', TINY.name))).toBe(false)
    expect(existsSync(path.join(r.dir, 'stt-models', `${TINY.name}.partial`))).toBe(false)
    expect(r.events.at(-2)).toEqual({ type: 'stt-model', state: 'missing' })
    expect(r.events.at(-1)).toMatchObject({ type: 'stt-error', message: expect.stringContaining('could not be downloaded') })
    expect(r.events.at(-1)).not.toHaveProperty('sessionId')
  })

  it('refuses a file of the wrong size and a server error', async () => {
    const short = await rig({ model: false, fetch: bodies({ 'enc.onnx': 'x' }) })
    await expect(short.service.downloadModel()).rejects.toThrow(/did not match/)
    const broken = await rig({ model: false, fetch: (async () => new Response('nope', { status: 503 })) as typeof fetch })
    await expect(broken.service.downloadModel()).rejects.toThrow(/answered 503/)
    expect(broken.service.modelStatus().state).toBe('missing')
    // A failed attempt can be retried.
    expect(broken.service.modelStatus().bytes).toBeUndefined()
  })

  it('a model that is only partly on disk is missing', async () => {
    const r = await rig()
    writeFileSync(path.join(r.dir, 'stt-models', TINY.name, 'dec.onnx'), 'short')
    expect(r.service.modelStatus().state).toBe('missing')
  })
})

describe('speech: OpenAI', () => {
  interface Upload {
    url: string
    headers: Record<string, string>
    form: FormData
  }
  function server(reply: () => Response = () => Response.json({ text: ' hello from openai ' })) {
    const uploads: Upload[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      uploads.push({ url, headers: init.headers as Record<string, string>, form: init.body as FormData })
      return reply()
    }) as unknown as typeof fetch
    return { uploads, fetcher }
  }
  const openai = async (options: Parameters<typeof rig>[0] = {}) => {
    const r = await rig({ settings: { sttProvider: 'openai' }, ...options })
    r.keys.OPENAI_API_KEY = 'sk-test-key'
    opened.push(r.service)
    return r
  }

  it('buffers the audio, uploads one WAV with the key and the language, and returns the text', async () => {
    const { uploads, fetcher } = server()
    const r = await openai({ fetch: fetcher })
    const started = await r.service.start({ language: 'pt-BR' })
    expect(started.provider).toBe('openai')
    r.service.audio(started.sessionId, pcm(3200, 3))
    r.service.audio(started.sessionId, pcm(3200, 4))
    // No partials, and nothing is uploaded before stop.
    expect(uploads).toHaveLength(0)
    expect(await r.service.stop(started.sessionId)).toEqual({ text: 'hello from openai' })

    expect(uploads).toHaveLength(1)
    const [upload] = uploads
    expect(upload.url).toBe(OPENAI_TRANSCRIPTION_URL)
    expect(upload.headers.Authorization).toBe('Bearer sk-test-key')
    expect(upload.form.get('model')).toBe(OPENAI_TRANSCRIPTION_MODEL)
    expect(upload.form.get('language')).toBe('pt')
    const file = upload.form.get('file') as File
    expect(file.type).toBe('audio/wav')
    const wav = Buffer.from(await file.arrayBuffer())
    expect(wav.subarray(0, 4).toString()).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt32LE(40)).toBe(6400)
    expect(wav.length).toBe(44 + 6400)
    expect(wav[44]).toBe(3)
    expect(wav[44 + 3200]).toBe(4)
    expect(r.events.filter((e) => e.type === 'stt-partial')).toEqual([])
  })

  it('does not call the API for an empty dictation', async () => {
    const { uploads, fetcher } = server()
    const r = await openai({ fetch: fetcher })
    const { sessionId } = await r.service.start({})
    expect(await r.service.stop(sessionId)).toEqual({ text: '' })
    expect(uploads).toHaveLength(0)
  })

  it('is refused without a saved key', async () => {
    const { uploads, fetcher } = server()
    const r = await openai({ fetch: fetcher })
    delete r.keys.OPENAI_API_KEY
    await expect(r.service.start({})).rejects.toThrow(/No OpenAI key is saved.*Provider keys/)
    expect(uploads).toHaveLength(0)
  })

  it('is refused while Privacy mode is on, at the start and again before the upload', async () => {
    const { uploads, fetcher } = server()
    const r = await openai({ fetch: fetcher, settings: { sttProvider: 'openai', privacyMode: true } })
    await expect(r.service.start({})).rejects.toThrow(/Privacy mode is on/)

    r.settings.privacyMode = false
    const { sessionId } = await r.service.start({})
    r.service.audio(sessionId, pcm())
    r.settings.privacyMode = true
    expect(await r.service.stop(sessionId)).toEqual({ text: '' })
    expect(r.events.at(-1)).toMatchObject({ type: 'stt-error', sessionId, message: expect.stringContaining('Privacy mode is on') })
    expect(uploads).toHaveLength(0)
  })

  it('turns an API failure into an stt-error and an empty answer, never leaking the key', async () => {
    for (const [status, body, pattern] of [
      [401, { error: { message: 'Incorrect API key provided: sk-test-key' } }, /did not accept the saved API key/],
      [429, {}, /over its rate or usage limit/],
      [500, { error: { message: 'upstream broke' } }, /\(500\): upstream broke/]
    ] as const) {
      const { fetcher } = server(() => Response.json(body, { status }))
      const r = await openai({ fetch: fetcher })
      const { sessionId } = await r.service.start({})
      r.service.audio(sessionId, pcm())
      expect(await r.service.stop(sessionId)).toEqual({ text: '' })
      const error = r.events.find((e) => e.type === 'stt-error')
      expect(error && 'message' in error && error.message).toMatch(pattern)
      expect(JSON.stringify(r.events)).not.toContain('sk-test-key')
    }
  })

  it('reports a network failure', async () => {
    const r = await openai({ fetch: (async () => { throw new Error('getaddrinfo ENOTFOUND') }) as typeof fetch })
    const { sessionId } = await r.service.start({})
    r.service.audio(sessionId, pcm())
    expect(await r.service.stop(sessionId)).toEqual({ text: '' })
    expect(r.events.at(-1)).toMatchObject({ type: 'stt-error', message: expect.stringContaining('Could not reach OpenAI') })
  })

  it('cancel uploads nothing', async () => {
    const { uploads, fetcher } = server()
    const r = await openai({ fetch: fetcher })
    const { sessionId } = await r.service.start({})
    r.service.audio(sessionId, pcm())
    r.service.cancel(sessionId)
    expect(await r.service.stop(sessionId)).toEqual({ text: '' })
    expect(uploads).toHaveLength(0)
  })

  it('keeps no more than the cap in memory', async () => {
    const { uploads, fetcher } = server()
    // 0.2 s is 6400 bytes: the second frame is cut short and the third is dropped.
    const r = await openai({ fetch: fetcher, maxSeconds: 0.2 })
    const { sessionId } = await r.service.start({})
    r.service.audio(sessionId, pcm(4000))
    r.service.audio(sessionId, pcm(4000))
    r.service.audio(sessionId, pcm(4000))
    expect(await r.service.stop(sessionId)).toEqual({ text: 'hello from openai' })
    expect(uploads).toHaveLength(1)
    expect((await (uploads[0].form.get('file') as File).arrayBuffer()).byteLength).toBe(44 + 6400)
    // The cap ended it: its text was shown as a partial, once.
    expect(r.events.filter((e) => e.type === 'stt-partial')).toHaveLength(1)
  })
})

describe('speech: through Core', () => {
  async function core(extra: Partial<Host> = {}) {
    const dir = await tempDir('foreman-stt-core-')
    const store = new Store(dir)
    await store.load()
    const events: MainEvent[] = []
    const host: Host = {
      broadcast: (event) => events.push(event),
      applyTheme() {},
      setBadge() {},
      setZoom() {},
      keepAwake() {},
      pickDirectory: async () => null,
      pickFiles: async () => [],
      pickPath: async () => null,
      openPath: async () => {},
      openExternal: async () => {},
      metrics: () => ({ cpuPercent: 0, memoryMb: 0 }),
      cliShim: () => '',
      ...extra
    }
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() })
    return { core: new Core(store, secrets, host), store, secrets, events, dir }
  }

  it('checks the three speech settings', async () => {
    const { core: c, store } = await core()
    expect(store.state.settings).toMatchObject({ sttProvider: 'local', sttLanguage: 'en', pushToTalk: 'hold' })
    await c.api.updateSettings({ sttProvider: 'openai', sttLanguage: 'pt-BR', pushToTalk: 'toggle' })
    expect(store.state.settings).toMatchObject({ sttProvider: 'openai', sttLanguage: 'pt-BR', pushToTalk: 'toggle' })
    await expect(c.api.updateSettings({ sttProvider: 'google' as 'local' })).rejects.toThrow(/Unknown speech to text engine/)
    await expect(c.api.updateSettings({ sttLanguage: 'English please' })).rejects.toThrow(/language code/)
    await expect(c.api.updateSettings({ sttLanguage: 5 as unknown as string })).rejects.toThrow(/language code/)
    await expect(c.api.updateSettings({ pushToTalk: 'always' as 'hold' })).rejects.toThrow(/Unknown push to talk/)
    expect(store.state.settings.sttProvider).toBe('openai')
  })

  it('exposes the model status and refuses a local dictation until the model is downloaded', async () => {
    const { core: c } = await core({ sttHelper: () => ({ command: process.execPath, args: [FAKE_HELPER], env: {} }) })
    expect(await c.api.sttModelStatus()).toMatchObject({ state: 'missing', name: STT_MODEL.name, sizeMb: 73, source: STT_MODEL.source })
    await expect(c.api.sttStart({})).rejects.toThrow(/model is not downloaded/)
    await expect(c.api.sttStart({ language: 'not a language' })).rejects.toThrow(/language code/)
  })

  it('asks the host for the microphone before it starts, and passes a refusal on', async () => {
    const microphone = vi.fn(async () => false)
    const { core: c } = await core({ microphone })
    await expect(c.api.sttStart({})).rejects.toThrow(/microphone/)
    expect(microphone).toHaveBeenCalledTimes(1)
  })

  it('dictates with OpenAI using the provider key from the secret store, and not under Privacy mode', async () => {
    const fetched = vi.fn(async () => Response.json({ text: 'ok' }))
    vi.stubGlobal('fetch', fetched)
    const { core: c, secrets } = await core()
    await c.api.updateSettings({ sttProvider: 'openai' })
    await expect(c.api.sttStart({})).rejects.toThrow(/No OpenAI key/)
    secrets.setProviderKey('OPENAI_API_KEY', 'sk-from-vault')
    const { sessionId, provider } = await c.api.sttStart({})
    expect(provider).toBe('openai')
    await c.api.sttAudio(sessionId, pcm())
    expect(await c.api.sttStop(sessionId)).toEqual({ text: 'ok' })
    expect(fetched).toHaveBeenCalledTimes(1)
    expect((fetched.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toEqual({ Authorization: 'Bearer sk-from-vault' })

    await c.api.updateSettings({ privacyMode: true })
    await expect(c.api.sttStart({})).rejects.toThrow(/Privacy mode/)
    await expect(c.api.sttStop(5 as unknown as string)).rejects.toThrow(/Unknown dictation/)
    await c.api.sttCancel('nothing-open')
  })
})
