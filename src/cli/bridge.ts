// `foreman mcp-bridge <service>`: the stdio MCP server Foreman gives agents for an integration
// (Linear today). It holds no credential: it pipes JSON-RPC lines between the agent and the app's
// socket, presenting the turn's grant id, and the app answers with the real key on its side.
// When the app isn't there (it quit while a kept turn runs on), it answers by itself: tools say
// they're unavailable instead of hanging.
import net from 'node:net'

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

const LABELS: Record<string, string> = { app: 'Foreman', linear: 'Linear', github: 'GitHub', slack: 'Slack', langfuse: 'Langfuse' }

export function bridgeLocalReply(service: string, message: Message, why: string): Record<string, unknown> | null {
  if (message.id === undefined || message.id === null || !message.method) return null
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result })
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: `foreman-${service}`, version: '1' },
        instructions: why
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: [] })
    case 'tools/call':
      return reply({ content: [{ type: 'text', text: why }], isError: true })
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: why } }
  }
}

export function runBridge(service: string, env: NodeJS.ProcessEnv = process.env, io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream } = { stdin: process.stdin, stdout: process.stdout }): Promise<void> {
  const socket = env.FOREMAN_BRIDGE_SOCKET
  const grant = env.FOREMAN_BRIDGE_GRANT
  const label = LABELS[service] ?? service
  const closedWhy = `${label} is unavailable while Foreman is closed. Open Foreman and start a new turn to use it.`
  const write = (msg: unknown) => io.stdout.write(`${JSON.stringify(msg)}\n`)

  let conn: net.Socket | null = null
  let connected = false
  let why = closedWhy
  // Requests sent to the app and not answered yet: answered locally if the app goes away.
  const pending = new Map<string | number, Message>()
  const queue: string[] = []

  const goneLocal = () => {
    connected = false
    conn = null
    for (const message of pending.values()) {
      const reply = bridgeLocalReply(service, message, why)
      if (reply) write(reply)
    }
    pending.clear()
    for (const line of queue.splice(0)) handleLocal(line)
  }
  const handleLocal = (line: string) => {
    let message: Message
    try {
      message = JSON.parse(line) as Message
    } catch {
      return
    }
    const reply = bridgeLocalReply(service, message, why)
    if (reply) write(reply)
  }

  if (socket && grant) {
    conn = net.createConnection(socket)
    conn.setEncoding('utf8')
    let buffer = ''
    conn.on('connect', () => {
      conn!.write(`${JSON.stringify({ method: 'mcp-bridge', params: { grant, service } })}\n`)
      connected = true
      for (const line of queue.splice(0)) send(line)
    })
    conn.on('data', (chunk: string) => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as Message & { bridgeError?: string }
          // The app refused the grant (a turn from before a restart, a removed connection).
          if (msg.bridgeError) {
            why = msg.bridgeError
            continue
          }
          if (msg.id !== undefined && msg.id !== null) pending.delete(msg.id)
        } catch {
          continue
        }
        io.stdout.write(`${line}\n`)
      }
    })
    conn.on('error', () => undefined)
    conn.on('close', goneLocal)
  }

  const send = (line: string) => {
    if (!conn || !connected) return handleLocal(line)
    try {
      const message = JSON.parse(line) as Message
      if (message.id !== undefined && message.id !== null && message.method) pending.set(message.id, message)
    } catch {
      return
    }
    conn.write(`${line}\n`)
  }

  return new Promise((resolve) => {
    let input = ''
    io.stdin.setEncoding?.('utf8')
    io.stdin.on('data', (chunk: string | Buffer) => {
      input += chunk.toString()
      let end: number
      while ((end = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, end).trim()
        input = input.slice(end + 1)
        if (!line) continue
        // Still connecting: hold the line until the socket answers or fails.
        if (conn && !connected) queue.push(line)
        else send(line)
      }
    })
    io.stdin.on('end', () => {
      conn?.end()
      resolve()
    })
  })
}
