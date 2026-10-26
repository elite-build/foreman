// The capture worklet for push-to-talk dictation (accessibility plan, phase G2). It runs on the audio thread, not in
// the renderer's main thread, and is loaded with `audioWorklet.addModule` (see stt.ts, which imports this file as
// `?worker&url` so Vite bundles it into its own script under script-src 'self').
//
// The page asks for a 16 kHz context, so the browser normally resamples for us; `Framer` still converts from whatever
// rate the context really has, to 16 kHz mono 16-bit little-endian samples, and hands over frames of about 100 ms.
// A message {type:'flush'} posts what is left as a short last frame, then {type:'flushed'}.

export const STT_SAMPLE_RATE = 16000
/** 100 ms of 16 kHz audio. */
export const STT_FRAME_SAMPLES = 1600
export const STT_PROCESSOR = 'foreman-stt-capture'

/** Turns blocks of floating-point samples at any rate into fixed frames of 16 kHz int16 samples. */
export class Framer {
  private readonly step: number
  private frame: Int16Array
  private filled = 0
  // Where the next output sample sits, in input samples from the start of the next block (may be just before it, in
  // which case it interpolates from `last`).
  private position = 0
  private last = 0

  constructor(
    inputRate: number,
    private readonly emit: (frame: Int16Array) => void,
    private readonly frameSamples = STT_FRAME_SAMPLES,
    outputRate = STT_SAMPLE_RATE
  ) {
    this.step = inputRate / outputRate
    this.frame = new Int16Array(frameSamples)
  }

  push(input: Float32Array): void {
    if (!input.length) return
    // Linear interpolation. An output sample needs the input sample after it, so the last one of a block waits for
    // the next block.
    while (true) {
      const index = Math.floor(this.position)
      if (index + 1 >= input.length) break
      const from = index < 0 ? this.last : input[index]
      const fraction = this.position - index
      this.put(from + (input[index + 1] - from) * fraction)
      this.position += this.step
    }
    this.position -= input.length
    this.last = input[input.length - 1]
  }

  /** Emit the samples collected so far as a shorter frame. */
  flush(): void {
    if (!this.filled) return
    this.emit(this.frame.slice(0, this.filled))
    this.frame = new Int16Array(this.frameSamples)
    this.filled = 0
  }

  private put(sample: number): void {
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample
    this.frame[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
    if (this.filled === this.frameSamples) {
      this.emit(this.frame)
      this.frame = new Int16Array(this.frameSamples)
      this.filled = 0
    }
  }
}

// The audio worklet scope's globals, which lib.dom does not declare.
interface WorkletPort {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: { data: { type?: string } }) => void) | null
}
declare const sampleRate: number
declare function registerProcessor(name: string, processor: new () => unknown): void
declare class AudioWorkletProcessor {
  readonly port: WorkletPort
}

// Only inside an audio worklet; the unit tests import `Framer` from a plain module.
if (typeof registerProcessor === 'function') {
  class CaptureProcessor extends AudioWorkletProcessor {
    private readonly framer = new Framer(sampleRate, (frame) => this.port.postMessage({ type: 'frame', pcm: frame.buffer }, [frame.buffer]))

    constructor() {
      super()
      this.port.onmessage = (event) => {
        if (event.data?.type !== 'flush') return
        this.framer.flush()
        // Messages arrive in order, so the page has the last frame by the time it sees this.
        this.port.postMessage({ type: 'flushed' })
      }
    }

    process(inputs: Float32Array[][]): boolean {
      const channel = inputs[0]?.[0]
      if (channel) this.framer.push(channel)
      return true
    }
  }
  registerProcessor(STT_PROCESSOR, CaptureProcessor)
}
