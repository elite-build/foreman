// Claude Code's process, started as the Agent SDK starts it (piped stdio, no window, exit reported once stderr has drained
// or shortly after), with its pid known: Show resource usage counts it, and the MCP servers and hooks it starts, against
// the workspace whose environment it runs in (processRoots.ts). The SDK only hands the pid to its own internal callers.
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { trackProcess } from '../processRoots'

// How long exit waits for stderr to close once the process has ended (the SDK's own spawn waits as long).
export const STDERR_GRACE_MS = 200
const DRAINED = 'foreman-exit-after-stderr'

type Spawner = typeof spawn
// The SDK's listeners: (code, signal) for exit, (error) for error.
type Listener = (...args: any[]) => void

/** A `spawnClaudeCodeProcess` that tracks the process and passes its stderr, as text, to `onStderr`. */
export function trackedClaudeSpawn(onStderr: (text: string) => void, start: Spawner = spawn): (options: SpawnOptions) => SpawnedProcess {
  return ({ command, args, cwd, env, signal }) => {
    const child = start(command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const untrack = trackProcess(child.pid, env.FOREMAN_WORKSPACE_ID, 'agent')
    const decoder = new StringDecoder('utf8')
    let stderrClosed = false
    let exited = false
    let done = false
    let timer: NodeJS.Timeout | undefined
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      untrack()
      child.emit(DRAINED, child.exitCode, child.signalCode)
      const stderr = child.stderr as (typeof child.stderr & { unref?: () => void }) | null
      if (typeof stderr?.unref === 'function') stderr.unref()
      else stderr?.destroy()
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      if (done) return
      const text = decoder.write(chunk)
      if (text) onStderr(text)
    })
    child.stderr?.on('error', () => undefined)
    child.stderr?.once('close', () => {
      const rest = decoder.end()
      if (rest && !done) onStderr(rest)
      stderrClosed = true
      if (exited) finish()
    })
    child.once('error', untrack)
    child.once('exit', () => {
      exited = true
      if (stderrClosed) finish()
      else timer = setTimeout(finish, STDERR_GRACE_MS)
    })
    const event = (name: string) => (name === 'exit' ? DRAINED : name)
    return {
      stdin: child.stdin!,
      stdout: child.stdout!,
      get killed() {
        return child.killed
      },
      get exitCode() {
        return child.exitCode
      },
      get signalCode() {
        return child.signalCode
      },
      kill: (sig: NodeJS.Signals) => child.kill(sig),
      on: (name: 'exit' | 'error', listener: Listener) => void child.on(event(name), listener),
      once: (name: 'exit' | 'error', listener: Listener) => void child.once(event(name), listener),
      off: (name: 'exit' | 'error', listener: Listener) => void child.off(event(name), listener)
    }
  }
}
