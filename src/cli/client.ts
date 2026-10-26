// The `foreman` command's side of the socket. `request` is protocol version 1 (one request, one reply
// line) and stays as it was for old callers and tests; `requestV2` is what the commands use: the reply
// can be preceded by progress lines, and a failure carries a code the exit status comes from.
import net from 'node:net'
import type { TurnCaller } from '../shared/agentReports'
import { ERROR_EXIT, EXIT_DISCONNECTED, type CliErrorCode, type CliProgressFrame, type CliReplyV2, type CliRequest, type CliRequestV2, type CliResponse } from './protocol'

/** A problem to print as is. `exitCode` overrides the default exit code of 1; `code` says why, for scripts. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
    readonly code?: CliErrorCode,
    readonly hint?: string
  ) {
    super(message)
  }
}

/** A mistake in what was typed: exit code 2. */
export function usageError(message: string, hint?: string): CliError {
  return new CliError(message, ERROR_EXIT.invalid, 'invalid', hint)
}

/**
 * Send one request and wait for its reply. With `waiting`, a connection that
 * drops before the reply (the app quit, or isn't running) is exit code 5: the
 * work it was waiting for isn't lost, and can be read again later.
 */
export function request<T>(socket: string, req: CliRequest, options: { waiting?: boolean } = {}): Promise<T> {
  const lost = (why: string) => new CliError(`${why}. A turn keeps its outcome; \`foreman wait <turn>\` reads it once Foreman is back.`, EXIT_DISCONNECTED)
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket)
    let buffer = ''
    let gotReply = false
    conn.setEncoding('utf8')
    conn.on('connect', () => conn.write(`${JSON.stringify(req)}\n`))
    conn.on('data', (chunk: string) => (buffer += chunk))
    conn.on('error', (err: NodeJS.ErrnoException) => {
      if (options.waiting && !gotReply) reject(lost(err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? 'Foreman isn’t running' : 'Lost the connection to Foreman'))
      else if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') reject(new CliError('Foreman isn’t running. Open the app and try again.'))
      else reject(err)
    })
    conn.on('close', () => {
      if (gotReply) return
      gotReply = true
      if (!buffer.trim()) return reject(options.waiting ? lost('Foreman closed the connection') : new CliError('Foreman closed the connection without replying.'))
      try {
        const response = JSON.parse(buffer) as CliResponse<T>
        if (response.ok) resolve(response.result)
        else reject(new CliError(response.error))
      } catch {
        reject(new CliError('Foreman sent a reply this command doesn’t understand. Is the app up to date?'))
      }
    })
  })
}

export interface RequestV2Options {
  // The turn identity from the environment, when this runs inside an agent turn.
  caller?: TurnCaller
  // The contents of <dataDir>/cli.token; without it the app serves nothing in the admin tier.
  token?: string | null
  // A dropped connection is exit code 5 and says the work isn't lost.
  waiting?: boolean
  onProgress?: (progress: CliProgressFrame['progress']) => void
}

/** What an app that predates a method answers (it has no `code`): the command is newer than the app. */
export const NEWER_THAN_APP = 'This foreman command is newer than the running Foreman app. Update the app (the command is part of it).'

function isProgress(line: unknown): line is CliProgressFrame {
  return typeof line === 'object' && line !== null && 'progress' in line && typeof (line as CliProgressFrame).progress === 'object'
}

/** The error a failed reply stands for. An old app has no `code`, and says `Unknown request …` for a method it lacks. */
export function replyError(reply: { error?: string; code?: CliErrorCode; hint?: string }): CliError {
  // A reply that fails without saying why still gets a sentence, not a crash in the error path.
  const text = typeof reply.error === 'string' && reply.error ? reply.error : 'Foreman reported an error without saying what went wrong.'
  const unknown = reply.code === 'unknown-method' || (reply.code === undefined && text.startsWith('Unknown request'))
  if (unknown) return new CliError(NEWER_THAN_APP, ERROR_EXIT['not-supported'], reply.code ?? 'not-supported')
  const code = reply.code ?? 'failed'
  return new CliError(text, ERROR_EXIT[code] ?? 1, code, reply.hint)
}

/**
 * Send one version 2 request. The app writes newline-delimited JSON: any number of progress frames,
 * then one reply, then closes. Frames are handled as they arrive, however the bytes were split.
 */
export function requestV2<T>(socket: string, method: string, params: unknown, options: RequestV2Options = {}): Promise<T> {
  const lost = (why: string) => new CliError(`${why}. A turn keeps its outcome; \`foreman wait <turn>\` reads it once Foreman is back.`, EXIT_DISCONNECTED, 'not-running')
  const req: CliRequestV2 = { v: 2, method, params, ...(options.caller ? { caller: options.caller } : {}), ...(options.token ? { token: options.token } : {}) }
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket)
    let buffer = ''
    let settled = false
    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      finish()
    }
    // One complete line: a progress frame, or the reply that ends the request.
    const handle = (text: string) => {
      if (!text.trim() || settled) return
      let line: unknown
      try {
        line = JSON.parse(text)
      } catch {
        return settle(() => reject(new CliError('Foreman sent a reply this command doesn’t understand. Is the app up to date?')))
      }
      if (isProgress(line)) return options.onProgress?.(line.progress)
      const reply = line as CliReplyV2<T> | CliResponse<T>
      if (reply.ok) settle(() => resolve(reply.result))
      else settle(() => reject(replyError(reply as { error: string; code?: CliErrorCode; hint?: string })))
    }
    conn.setEncoding('utf8')
    conn.on('connect', () => conn.write(`${JSON.stringify(req)}\n`))
    conn.on('data', (chunk: string) => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        handle(text)
      }
    })
    conn.on('error', (err: NodeJS.ErrnoException) => {
      const absent = err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
      if (options.waiting) settle(() => reject(lost(absent ? 'Foreman isn’t running' : 'Lost the connection to Foreman')))
      else if (absent) settle(() => reject(new CliError('Foreman isn’t running. Open the app and try again.', ERROR_EXIT['not-running'], 'not-running')))
      else settle(() => reject(err))
    })
    conn.on('close', () => {
      // A reply the app didn't end with a newline still counts.
      handle(buffer)
      buffer = ''
      settle(() => reject(options.waiting ? lost('Foreman closed the connection') : new CliError('Foreman closed the connection without replying.', ERROR_EXIT['not-running'], 'not-running')))
    })
  })
}
