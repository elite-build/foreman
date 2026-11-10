// A stand-in for `codex app-server` that speaks just enough of its newline-delimited JSON-RPC for the client's tests.
//   echo         answers with the params it got
//   fail         answers with a JSON-RPC error
//   garbage      prints a line that isn't JSON, then answers
//   notify       answers, then sends a notification
//   ask          sends a server request `item/fake/ask` (id "srv-1"), then answers
//   ask-unknown  sends a server request `item/fake/unknown` (id "srv-2"), then answers
//   die          writes to stderr and exits with code 3 without answering
//   hang         never answers
// The client's replies to our requests come back as an `asked` notification, so a test can see them.
import { createInterface } from 'node:readline'

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === undefined) {
    send({ method: 'asked', params: msg })
    return
  }
  if (msg.id === undefined) {
    send({ method: 'saw', params: { method: msg.method, params: msg.params ?? null } })
    return
  }
  switch (msg.method) {
    case 'initialize':
      send({ id: msg.id, result: { userAgent: 'fake' } })
      break
    case 'echo':
      send({ id: msg.id, result: msg.params })
      break
    case 'fail':
      send({ id: msg.id, error: { code: -32000, message: 'boom' } })
      break
    case 'garbage':
      process.stdout.write('not json at all\n')
      send({ id: msg.id, result: 'ok' })
      break
    case 'notify':
      send({ id: msg.id, result: 'ok' })
      send({ method: 'hello', params: { n: 1 } })
      break
    case 'ask':
      send({ id: 'srv-1', method: 'item/fake/ask', params: { question: 'ok?' } })
      send({ id: msg.id, result: 'asked' })
      break
    case 'ask-unknown':
      send({ id: 'srv-2', method: 'item/fake/unknown', params: {} })
      send({ id: msg.id, result: 'asked' })
      break
    case 'die':
      process.stderr.write('oops: it broke\n')
      process.exit(3)
      break
    case 'hang':
      break
  }
})
