// Speech to text: the contract every engine meets. One provider call per dictation: `start` opens a session,
// the renderer's microphone frames go into `audio`, `stop` returns the final transcript, `cancel` throws the audio away.
// Raw audio is never written to disk.

export type SttProviderName = 'local' | 'openai'

/** What the renderer sends: 16 kHz, mono, signed 16-bit little-endian PCM. */
export const STT_SAMPLE_RATE = 16000
export const STT_BYTES_PER_SECOND = STT_SAMPLE_RATE * 2
/** One dictation never runs longer than this (the renderer stops earlier; main enforces it too). */
export const STT_MAX_SECONDS = 60
/** A frame is about 100 ms (3200 bytes); anything much larger is a bug in the sender. */
export const STT_MAX_FRAME_BYTES = 64 * 1024

export interface SttStartOptions {
  /** A language code such as `en`. */
  language: string
  /** The words so far (providers that cannot stream never call this). Each call replaces the last. */
  onPartial(text: string): void
  /** The engine failed after the session started (a crashed helper). The session is over. */
  onError(message: string): void
}

export interface SttSession {
  /** A frame of PCM. Cheap and synchronous; frames after `stop` or `cancel` are ignored. */
  audio(frame: Uint8Array): void
  /** End the audio and wait for the final transcript. Never rejects for an engine that already failed: it returns what it had. */
  stop(): Promise<string>
  /** Drop the session without a transcript. */
  cancel(): void
}

export interface SttProvider {
  readonly name: SttProviderName
  /** Rejects with a message fit to show the user when the engine cannot start (nothing was recorded). */
  start(options: SttStartOptions): Promise<SttSession>
}

/** Signed 16-bit little-endian PCM as a RIFF/WAVE file (44-byte header). */
export function pcmToWav(pcm: Uint8Array, sampleRate = STT_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.byteLength, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.byteLength, 40)
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)])
}
