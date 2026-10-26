// #20 tests: the smallest stdio MCP server, for proving an agent really started a repo server and called it.
// Newline-delimited JSON-RPC with no dependencies. One tool, `echo`, which answers with the text it got and
// what it can see of two variables: the one it declared (ECHO_TOKEN) and one it must never get (FOREMAN_LEAK_PROBE).
// With a file path as its first argument it also appends each call there, so a test can see the call happened.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const log = process.argv[2]
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')

const TOOL = {
  name: 'echo',
  description: 'Echo the text back, with what this server can see of its variables.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return
  switch (msg.method) {
    case 'initialize':
      return send({
        id: msg.id,
        result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo-fixture', version: '1.0.0' } }
      })
    case 'tools/list':
      return send({ id: msg.id, result: { tools: [TOOL] } })
    case 'tools/call': {
      const text = `echo:${msg.params?.arguments?.text ?? ''} token=${process.env.ECHO_TOKEN ?? 'unset'} leak=${process.env.FOREMAN_LEAK_PROBE ?? 'unset'}`
      if (log) appendFileSync(log, text + '\n')
      return send({ id: msg.id, result: { content: [{ type: 'text', text }] } })
    }
    case 'ping':
      return send({ id: msg.id, result: {} })
    default:
      return send({ id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } })
  }
})
