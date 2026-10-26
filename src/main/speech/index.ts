// Speech to text, as the app sees it: one dictation at a time, started and fed by the renderer's microphone
// frames, answered with partial text as events and the final text on stop. The engine is chosen from settings
// when a dictation starts; `local` is a helper process (local.ts), `openai` an upload at the end (openai.ts).
//
// Failures: a dictation that cannot start rejects `start` (nothing was recorded). One that fails afterwards (a
// helper crash, an upload refused) emits `stt-error` with its session id, and `stop` still answers (with the text
// so far, or empty) instead of rejecting, so every engine reports problems the same way.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MainEvent, Settings } from '../../shared/types'
import { LocalProvider, type HelperLaunch } from './local'
import { SttModels, type SttModelInfo, type SttModelStatus } from './models'
import { OpenAiProvider } from './openai'
import { STT_BYTES_PER_SECOND, STT_MAX_FRAME_BYTES, STT_MAX_SECONDS, type SttProvider, type SttProviderName, type SttSession } from './provider'

export interface SpeechServiceOptions {
  /** The data directory; models go under `<dir>/stt-models`. */
  dir: string
  settings(): Pick<Settings, 'sttProvider' | 'sttLanguage' | 'privacyMode'>
  /** A saved provider key by environment-variable name (the SecretStore's provider keys). */
  providerKey(name: string): string | undefined
  broadcast(event: MainEvent): void
  /** Ask the OS for microphone access (macOS shows its prompt once); false when it is refused. Absent: assume yes. */
  microphone?(): Promise<boolean>
  /** How to run the helper script; null or absent when it is not built. */
  helper?(): HelperLaunch | null
  fetch?: typeof fetch
  /** Tests: a smaller model description, a shorter cap and quicker timeouts. */
  model?: SttModelInfo
  maxSeconds?: number
  graceMs?: number
  stopTimeoutMs?: number
}

interface Dictation {
  id: string
  provider: SttProviderName
  session: SttSession | null
  bytes: number
  /** The latest partial text, kept so a failed or capped dictation can still answer. */
  text: string
  ending: Promise<string> | null
  timer: NodeJS.Timeout | null
}

const MICROPHONE_OFF = 'Foreman does not have access to the microphone. Allow it in your system privacy settings, then try again.'

export class SpeechService {
  readonly models: SttModels
  private current: Dictation | null = null
  // Dictations that ended on their own (a crash) and wait for the renderer's stop or cancel to collect their text.
  private ended = new Map<string, string>()
  private readonly local: LocalProvider
  private readonly openai: OpenAiProvider
  private readonly maxBytes: number

  constructor(private options: SpeechServiceOptions) {
    this.models = new SttModels({ dir: path.join(options.dir, 'stt-models'), broadcast: options.broadcast, fetch: options.fetch, model: options.model })
    this.local = new LocalProvider({ launch: () => options.helper?.() ?? null, models: this.models, stopTimeoutMs: options.stopTimeoutMs })
    this.openai = new OpenAiProvider({
      key: () => options.providerKey('OPENAI_API_KEY'),
      privacyMode: () => options.settings().privacyMode,
      fetch: options.fetch
    })
    this.maxBytes = Math.floor((options.maxSeconds ?? STT_MAX_SECONDS) * STT_BYTES_PER_SECOND) & ~1
  }

  private provider(name: SttProviderName): SttProvider {
    return name === 'openai' ? this.openai : this.local
  }

  async start(request: { language?: string }): Promise<{ sessionId: string; provider: SttProviderName }> {
    // One microphone: a dictation still open (its stop never came) gives way to the new one.
    this.drop(this.current)
    this.ended.clear()
    const settings = this.options.settings()
    const language = request.language ?? settings.sttLanguage
    const name = settings.sttProvider
    if (this.options.microphone && !(await this.options.microphone())) throw new Error(MICROPHONE_OFF)

    const dictation: Dictation = { id: randomUUID(), provider: name, session: null, bytes: 0, text: '', ending: null, timer: null }
    dictation.session = await this.provider(name).start({
      language,
      onPartial: (text) => {
        dictation.text = text
        if (this.current === dictation) this.options.broadcast({ type: 'stt-partial', sessionId: dictation.id, text })
      },
      onError: (message) => {
        if (this.current !== dictation) return
        this.clear(dictation)
        this.current = null
        this.ended.set(dictation.id, dictation.text)
        this.options.broadcast({ type: 'stt-error', sessionId: dictation.id, message })
      }
    })
    this.current = dictation
    // The renderer stops at the cap; if it never does (window closed, a bug), the dictation ends here anyway.
    dictation.timer = setTimeout(() => void this.finish(dictation, true), (this.maxBytes / STT_BYTES_PER_SECOND) * 1000 + (this.options.graceMs ?? 5000))
    dictation.timer.unref()
    return { sessionId: dictation.id, provider: name }
  }

  audio(sessionId: string, pcm: Uint8Array): void {
    if (!ArrayBuffer.isView(pcm)) throw new Error('Audio must be 16-bit PCM bytes')
    if (pcm.byteLength > STT_MAX_FRAME_BYTES) throw new Error('Audio frame is too large')
    const dictation = this.current
    if (!dictation || dictation.id !== sessionId || dictation.ending || !dictation.session) return
    const room = this.maxBytes - dictation.bytes
    // Whole 16-bit samples only.
    const take = Math.min(pcm.byteLength, room) & ~1
    if (take > 0) dictation.session.audio(new Uint8Array(pcm.buffer, pcm.byteOffset, take))
    dictation.bytes += take
    if (pcm.byteLength >= room) void this.finish(dictation, true)
  }

  async stop(sessionId: string): Promise<{ text: string }> {
    const collected = this.ended.get(sessionId)
    if (collected !== undefined) {
      this.ended.delete(sessionId)
      return { text: collected }
    }
    const dictation = this.current
    if (!dictation || dictation.id !== sessionId) return { text: '' }
    const text = await this.finish(dictation)
    if (this.current === dictation) this.current = null
    // A helper that died while stopping already reported itself and left its text here.
    this.ended.delete(sessionId)
    return { text }
  }

  cancel(sessionId: string): void {
    this.ended.delete(sessionId)
    if (this.current?.id === sessionId) this.drop(this.current)
  }

  /** Quit: nothing keeps the microphone or a helper. */
  dispose(): void {
    this.drop(this.current)
  }

  modelStatus(): SttModelStatus {
    return this.models.status()
  }

  async downloadModel(): Promise<void> {
    try {
      await this.models.download()
    } catch (error) {
      this.options.broadcast({ type: 'stt-error', message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  private clear(dictation: Dictation): void {
    if (dictation.timer) clearTimeout(dictation.timer)
    dictation.timer = null
  }

  private drop(dictation: Dictation | null): void {
    if (!dictation) return
    this.clear(dictation)
    if (this.current === dictation) this.current = null
    dictation.ending ??= Promise.resolve('')
    dictation.session?.cancel()
  }

  /** End the audio and get the final text, once; the cap, the watchdog and `stop` all come through here. */
  private finish(dictation: Dictation, announce = false): Promise<string> {
    dictation.ending ??= (async () => {
      this.clear(dictation)
      let text = dictation.text
      try {
        text = (await dictation.session?.stop()) ?? text
      } catch (error) {
        text = ''
        this.options.broadcast({ type: 'stt-error', sessionId: dictation.id, message: error instanceof Error ? error.message : String(error) })
      }
      dictation.text = text
      // A capped or timed-out dictation shows what it has now (the renderer's own stop comes later and gets the same text).
      if (announce && text && this.current === dictation) this.options.broadcast({ type: 'stt-partial', sessionId: dictation.id, text })
      return text
    })()
    return dictation.ending
  }
}
