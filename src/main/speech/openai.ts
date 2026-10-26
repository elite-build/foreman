// The optional cloud engine: the session's audio is kept in memory, wrapped as a WAV when the dictation stops and
// sent once to OpenAI's transcription endpoint with the user's own key (Settings > Agents > Provider keys, saved
// as OPENAI_API_KEY in the SecretStore). No partial results, nothing is written to disk, and nothing is sent while
// Privacy mode is on: that is checked when the dictation starts and again just before the upload.
import { pcmToWav, STT_BYTES_PER_SECOND, STT_MAX_SECONDS, type SttProvider, type SttSession, type SttStartOptions } from './provider'

export const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions'
export const OPENAI_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe'

export interface OpenAiProviderOptions {
  /** The saved OPENAI_API_KEY, read on every use. */
  key(): string | undefined
  privacyMode(): boolean
  fetch?: typeof fetch
  timeoutMs?: number
}

const PRIVACY = 'Privacy mode is on, so Foreman will not send audio to OpenAI. Turn Privacy mode off, or use the speech model on this computer.'
const NO_KEY = 'No OpenAI key is saved. Add one under Settings, Agents, Provider keys, or use the speech model on this computer.'

export class OpenAiProvider implements SttProvider {
  readonly name = 'openai' as const

  constructor(private options: OpenAiProviderOptions) {}

  async start(options: SttStartOptions): Promise<SttSession> {
    if (this.options.privacyMode()) throw new Error(PRIVACY)
    if (!this.options.key()) throw new Error(NO_KEY)
    return new OpenAiSession(this.options, options.language)
  }
}

class OpenAiSession implements SttSession {
  private chunks: Buffer[] = []
  private bytes = 0
  private done = false

  constructor(
    private options: OpenAiProviderOptions,
    private language: string
  ) {}

  audio(frame: Uint8Array): void {
    if (this.done || this.bytes >= STT_MAX_SECONDS * STT_BYTES_PER_SECOND) return
    this.chunks.push(Buffer.from(frame))
    this.bytes += frame.byteLength
  }

  async stop(): Promise<string> {
    if (this.done) return ''
    this.done = true
    const pcm = Buffer.concat(this.chunks)
    this.chunks = []
    if (pcm.length < STT_BYTES_PER_SECOND / 10) return ''
    // Re-checked here: the setting may have changed while the user was speaking.
    if (this.options.privacyMode()) throw new Error(PRIVACY)
    const key = this.options.key()
    if (!key) throw new Error(NO_KEY)

    const body = new FormData()
    body.set('file', new Blob([new Uint8Array(pcmToWav(pcm))], { type: 'audio/wav' }), 'dictation.wav')
    body.set('model', OPENAI_TRANSCRIPTION_MODEL)
    body.set('response_format', 'json')
    const language = this.language.split('-')[0].toLowerCase()
    if (/^[a-z]{2,3}$/.test(language)) body.set('language', language)

    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(OPENAI_TRANSCRIPTION_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000)
      })
    } catch (error) {
      throw new Error(`Could not reach OpenAI: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new Error(await failure(response))
    const result = (await response.json().catch(() => ({}))) as { text?: unknown }
    return typeof result.text === 'string' ? result.text.trim() : ''
  }

  cancel(): void {
    this.done = true
    this.chunks = []
  }
}

async function failure(response: Response): Promise<string> {
  if (response.status === 401) return 'OpenAI did not accept the saved API key.'
  if (response.status === 429) return 'OpenAI says this key is over its rate or usage limit.'
  const detail = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null
  const message = typeof detail?.error?.message === 'string' ? detail.error.message.slice(0, 200) : ''
  return `OpenAI could not transcribe the audio (${response.status})${message ? `: ${message}` : ''}.`
}
