// The speech helper: one dictation, run as a plain Node script (Foreman's binary with ELECTRON_RUN_AS_NODE=1), so
// a crash or a bad native library never takes the app down. The wire format is in ./protocol.ts.
// `sherpa-onnx-node` is loaded only when a dictation starts; when it or the model is missing the helper says so
// in one JSON line and exits with code 2.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { FrameDecoder, HELPER_EXIT_MISSING, KIND_AUDIO, KIND_CONTROL, type HelperModelFiles, type HelperReply, type HelperRequest } from './protocol'

const SAMPLE_RATE = 16000
// Silence appended before the stream is closed so the last words come out of the recognizer.
const TAIL_SECONDS = 0.5

interface Stream {
  acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void
  inputFinished(): void
}
interface Recognizer {
  createStream(): Stream
  isReady(stream: Stream): boolean
  decode(stream: Stream): void
  getResult(stream: Stream): { text?: string }
}
interface Sherpa {
  OnlineRecognizer: new (config: unknown) => Recognizer
}

let recognizer: Recognizer | null = null
let stream: Stream | null = null
let lastText = ''
// A sample split across two frames (odd byte counts) waits here for its other byte.
let carry: Buffer | null = null
let stopped = false

function emit(reply: HelperReply, then?: () => void): void {
  process.stdout.write(`${JSON.stringify(reply)}\n`, then)
}

// After an error nothing more is read; the process leaves once stdout has drained so the line is not lost on a pipe.
let dying = false

function fail(message: string, code: number): void {
  dying = true
  emit({ type: 'error', message }, () => process.exit(code))
}

function load(model: HelperModelFiles): void {
  if (Object.values(model).some((file) => !existsSync(file))) return fail('The speech model is not downloaded. Download it in Settings > Accessibility.', HELPER_EXIT_MISSING)
  let sherpa: Sherpa
  try {
    sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as Sherpa
  } catch (error) {
    return fail(`The speech engine (sherpa-onnx-node) is not installed or does not support this computer: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`, HELPER_EXIT_MISSING)
  }
  try {
    recognizer = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner },
        tokens: model.tokens,
        numThreads: 2,
        provider: 'cpu',
        debug: 0
      },
      decodingMethod: 'greedy_search',
      // One press of the key is one utterance: pauses inside it must not split it.
      enableEndpoint: 0
    })
    stream = recognizer.createStream()
  } catch (error) {
    return fail(`The speech model could not be loaded: ${error instanceof Error ? error.message : String(error)}`, 1)
  }
  emit({ type: 'ready' })
}

function toSamples(bytes: Buffer): Float32Array {
  let data = bytes
  if (carry) {
    data = Buffer.concat([carry, data])
    carry = null
  }
  if (data.length % 2) {
    carry = data.subarray(data.length - 1)
    data = data.subarray(0, data.length - 1)
  }
  const samples = new Float32Array(data.length / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768
  return samples
}

function decodeReady(): string {
  if (!recognizer || !stream) return lastText
  while (recognizer.isReady(stream)) recognizer.decode(stream)
  return (recognizer.getResult(stream).text ?? '').trim()
}

function audio(bytes: Buffer): void {
  if (!recognizer || !stream || stopped) return
  stream.acceptWaveform({ samples: toSamples(bytes), sampleRate: SAMPLE_RATE })
  const text = decodeReady()
  if (text !== lastText) {
    lastText = text
    emit({ type: 'partial', text })
  }
}

function finish(): void {
  stopped = true
  if (recognizer && stream) {
    stream.acceptWaveform({ samples: new Float32Array(Math.round(SAMPLE_RATE * TAIL_SECONDS)), sampleRate: SAMPLE_RATE })
    stream.inputFinished()
    lastText = decodeReady()
  }
  emit({ type: 'final', text: lastText }, () => process.exit(0))
}

function control(request: HelperRequest): void {
  switch (request.type) {
    case 'start':
      if (!recognizer) load(request.model)
      break
    case 'stop':
      if (!stopped) finish()
      break
    case 'cancel':
      process.exit(0)
  }
}

const decoder = new FrameDecoder()
process.stdin.on('data', (chunk: Buffer) => {
  try {
    for (const frame of decoder.push(chunk)) {
      if (dying) return
      if (frame.kind === KIND_CONTROL) control(JSON.parse(frame.payload.toString('utf8')) as HelperRequest)
      else if (frame.kind === KIND_AUDIO) audio(frame.payload)
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 1)
  }
})
// Foreman went away or gave up on the dictation.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('error', () => process.exit(0))
