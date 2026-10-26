// The wire format between Foreman and the speech helper (`out/main/sttHelper.js`, run as a plain Node script by
// Foreman's own binary with ELECTRON_RUN_AS_NODE=1, like the CLI). Node-only: the helper bundles this file.
//
// Foreman -> helper, on stdin, as binary frames:   [kind: 1 byte][length: uint32 little-endian][payload]
//   kind 0x4a ('J'): payload is one UTF-8 JSON control message (HelperRequest).
//   kind 0x41 ('A'): payload is raw PCM, 16 kHz mono signed 16-bit little-endian, any even length up to 1 MiB.
// helper -> Foreman, on stdout, as JSON lines: one HelperReply per line.
// stderr is free text for diagnostics; Foreman keeps its tail for crash messages.
//
// The helper handles one dictation and exits: `start` loads the model, audio frames follow (they queue in the pipe
// while it loads), `stop` makes it flush and answer `final`, `cancel` or a closed stdin makes it exit quietly.
// Exit codes: 0 done, 2 the engine or the model is missing (a JSON `error` line comes first), 1 anything else.

export const KIND_CONTROL = 0x4a
export const KIND_AUDIO = 0x41
export const MAX_FRAME_BYTES = 1 << 20
export const HELPER_EXIT_MISSING = 2

export interface HelperModelFiles {
  encoder: string
  decoder: string
  joiner: string
  tokens: string
}

export type HelperRequest =
  | { type: 'start'; language: string; model: HelperModelFiles }
  | { type: 'stop' }
  | { type: 'cancel' }

export type HelperReply =
  | { type: 'ready' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string }

export function encodeFrame(kind: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5)
  header[0] = kind
  header.writeUInt32LE(payload.byteLength, 1)
  return Buffer.concat([header, Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)])
}

export function encodeControl(message: HelperRequest): Buffer {
  return encodeFrame(KIND_CONTROL, Buffer.from(JSON.stringify(message), 'utf8'))
}

export interface Frame {
  kind: number
  payload: Buffer
}

/** Reassembles frames from arbitrary stdin chunks. Throws on a frame that is too large or of an unknown kind. */
export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Frame[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    const frames: Frame[] = []
    while (this.pending.length >= 5) {
      const kind = this.pending[0]
      const length = this.pending.readUInt32LE(1)
      if (kind !== KIND_CONTROL && kind !== KIND_AUDIO) throw new Error(`Unknown frame kind ${kind}`)
      if (length > MAX_FRAME_BYTES) throw new Error(`Frame of ${length} bytes is too large`)
      if (this.pending.length < 5 + length) break
      frames.push({ kind, payload: this.pending.subarray(5, 5 + length) })
      this.pending = this.pending.subarray(5 + length)
    }
    return frames
  }
}

/** One JSON line from the helper's stdout, or null when it is not one of ours. */
export function parseReply(line: string): HelperReply | null {
  try {
    const value = JSON.parse(line) as { type?: unknown; text?: unknown; message?: unknown }
    if (value.type === 'ready') return { type: 'ready' }
    if ((value.type === 'partial' || value.type === 'final') && typeof value.text === 'string') return { type: value.type, text: value.text }
    if (value.type === 'error' && typeof value.message === 'string') return { type: 'error', message: value.message }
  } catch {
    // Not JSON: ignored, like any stray output.
  }
  return null
}
