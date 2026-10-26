// Local socket the `foreman` command talks to (see src/cli). It reaches only what the registry
// (methods.ts) lists, each under its tier (policy.ts), not the rest of the API.
import { chmodSync, rmSync } from 'node:fs'
import net from 'node:net'
import type { CliErrorCode, CliProgressFrame, CliReplyV2, CliRequest, CliRequestV2, CliResponse } from '../../cli/protocol'
import { CliCodedError, type CliHost } from './host'
import { METHODS, type CliContext } from './methods'
import { isV2, paramsOf, tierCheck, type AnyCliRequest } from './policy'

// Requests are a few hundred bytes; anything this big isn't one.
const MAX_REQUEST = 1024 * 1024

/** Which code a thrown error stands for. The messages are the ones version 1 clients have always seen. */
function errorCode(err: unknown): { code: CliErrorCode; hint?: string } {
  if (err instanceof CliCodedError) return { code: err.code, hint: err.hint }
  const message = err instanceof Error ? err.message : String(err)
  if (/^No .+ named /.test(message) || message.startsWith('No turn with the id')) return { code: 'not-found' }
  if (message.includes('matches several')) return { code: 'ambiguous' }
  return { code: 'failed' }
}

/**
 * Answer one request. A request with no `v` is version 1: one reply, the error text alone, no progress.
 * `v: 2` adds `code` (and `hint`) to a failure, and lets a handler write progress frames through `write`.
 */
export async function handleRequest(host: CliHost, request: AnyCliRequest, signal?: AbortSignal, write?: (frame: CliProgressFrame) => void): Promise<CliResponse | CliReplyV2> {
  const version = (request as { v?: unknown }).v
  if (version !== undefined && version !== 1 && version !== 2) return { ok: false, error: `Unsupported protocol version ${String(version)}`, code: 'invalid' }
  const v2 = isV2(request)
  const fail = (error: string, code: CliErrorCode, hint?: string): CliResponse | CliReplyV2 => (v2 ? { ok: false, error, code, ...(hint ? { hint } : {}) } : { ok: false, error })
  try {
    const method = (request as { method?: unknown }).method
    const entry = typeof method === 'string' && Object.hasOwn(METHODS, method) ? METHODS[method] : undefined
    if (!entry) return fail(`Unknown request ${String(method)}`, 'unknown-method')
    const refusal = tierCheck(method as string, entry.tier, request, host)
    if (refusal) return fail(refusal.error, refusal.code, refusal.hint)
    const ctx: CliContext = {
      request,
      caller: request.caller,
      signal,
      progress: (text, percent) => {
        if (v2 && write) write({ progress: { text, ...(percent !== undefined ? { percent } : {}) } })
      }
    }
    return { ok: true, result: await entry.handle(host, paramsOf(request), ctx) }
  } catch (err) {
    const { code, hint } = errorCode(err)
    return fail(err instanceof Error ? err.message : String(err), code, hint)
  }
}

/** Listen on `socket` until the returned server is closed. */
export function startCliServer(socket: string, host: CliHost): Promise<net.Server> {
  // Only one app runs per data folder (single-instance lock), so a socket left here is from a crash.
  if (process.platform !== 'win32') rmSync(socket, { force: true })
  const server = net.createServer((conn) => {
    let buffer = ''
    conn.setEncoding('utf8')
    conn.on('error', () => undefined)
    conn.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_REQUEST) return conn.destroy()
      const end = buffer.indexOf('\n')
      if (end < 0) return
      conn.removeAllListeners('data')
      let request: CliRequest | CliRequestV2
      try {
        request = JSON.parse(buffer.slice(0, end)) as CliRequest | CliRequestV2
        if (typeof request !== 'object' || request === null) throw new Error('not a request')
      } catch {
        conn.end(`${JSON.stringify({ ok: false, error: 'Malformed request' })}\n`)
        return
      }
      // The bridge is not a registry method: no options, token, caller or progress, and the bytes that
      // followed its first line go to it as they arrived.
      if (request.method === 'mcp-bridge') {
        if (!host.bridge) return void conn.end(`${JSON.stringify({ bridgeError: 'This version of Foreman has no integration bridge.' })}\n`)
        // The grant is what the bridge checks, so a request without one in the right shape never reaches it.
        const params = request.params as { grant?: unknown; service?: unknown } | null | undefined
        if (typeof params?.grant !== 'string' || typeof params.service !== 'string') return void conn.end(`${JSON.stringify({ bridgeError: 'Malformed bridge request.' })}\n`)
        return host.bridge(conn, { grant: params.grant, service: params.service }, buffer.slice(end + 1))
      }
      // A waiting command that goes away stops its wait; the turn is unaffected.
      const gone = new AbortController()
      conn.once('close', () => gone.abort())
      const write = (frame: CliProgressFrame) => {
        if (conn.writable) conn.write(`${JSON.stringify(frame)}\n`)
      }
      void handleRequest(host, request, gone.signal, write).then((response) => conn.end(`${JSON.stringify(response)}\n`))
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, () => {
      server.off('error', reject)
      // Other users on the machine mustn't be able to start agents.
      if (process.platform !== 'win32') chmodSync(socket, 0o600)
      resolve(server)
    })
  })
}
