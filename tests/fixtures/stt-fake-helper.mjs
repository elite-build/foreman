// A stand-in for out/main/sttHelper.js that speaks the same stdio protocol (src/main/speech/protocol.ts) without a
// model: every audio frame adds a word to the partial text, `stop` answers the whole phrase and exits.
//   stdin : [kind: 1 byte][length: uint32 LE][payload], kind 0x4a = JSON control, 0x41 = PCM
//   stdout: JSON lines { type: 'ready' | 'partial' | 'final' | 'error', ... }
// A frame that starts with four 0xff bytes crashes the process (exit code 1, a line on stderr). FAKE_STT_MODE=hang
// ignores `stop`. FAKE_STT_LOG names a file that gets what the helper saw, written when it stops.
import { renameSync, writeFileSync } from 'node:fs'

const WORDS = ['HELLO', 'I', 'AM', 'FOREMAN']
let start = null
let bytes = 0
let frames = 0
let pending = Buffer.alloc(0)

const say = (reply, then) => process.stdout.write(`${JSON.stringify(reply)}\n`, then)
const phrase = () => WORDS.slice(0, Math.min(frames, WORDS.length)).join(' ')
// Written beside it and renamed into place: a test waits for the file to exist, then reads it whole.
const log = () => {
  const file = process.env.FAKE_STT_LOG
  if (!file) return
  writeFileSync(`${file}.tmp`, JSON.stringify({ start, bytes, frames }))
  renameSync(`${file}.tmp`, file)
}

function control(message) {
  if (message.type === 'start') {
    start = message
    say({ type: 'ready' })
  } else if (message.type === 'stop') {
    if (process.env.FAKE_STT_MODE === 'hang') return
    log()
    say({ type: 'final', text: phrase() }, () => process.exit(0))
  } else if (message.type === 'cancel') {
    process.exit(0)
  }
}

process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk])
  while (pending.length >= 5) {
    const kind = pending[0]
    const length = pending.readUInt32LE(1)
    if (pending.length < 5 + length) break
    const payload = pending.subarray(5, 5 + length)
    pending = pending.subarray(5 + length)
    if (kind === 0x4a) {
      control(JSON.parse(payload.toString('utf8')))
    } else if (kind === 0x41) {
      if (payload.length >= 4 && payload.readUInt32LE(0) === 0xffffffff) {
        process.stderr.write('fake helper: boom\n')
        process.exit(1)
      }
      bytes += payload.length
      frames += 1
      say({ type: 'partial', text: phrase() })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
