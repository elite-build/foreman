// Cursor's SDK executes local tools in its own process and has no per-agent environment
// option. Run each turn in a child so concurrent repositories never share credentials.
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ReportKind } from '../../shared/agentReports'
import { cursorDriver } from './cursor'
import { trackChild } from '../processRoots'
import type { AgentDriver, AgentTurn, TurnCallbacks, TurnRequest } from './types'

export type CursorEvent =
  | { type: 'item'; args: Parameters<TurnCallbacks['item']> }
  | { type: 'sessionStarted'; args: Parameters<TurnCallbacks['sessionStarted']> }
  | { type: 'usage'; args: Parameters<TurnCallbacks['usage']> }
  | { type: 'finished'; args: Parameters<TurnCallbacks['finished']> }
  | { type: 'report'; args: [kind: ReportKind | 'review', text: string, link?: string] }
  | { type: 'ended' }

export type CursorStart = { type: 'start'; request: Omit<TurnRequest, 'hostTools' | 'sessionStore' | 'assistant'>; reports: boolean }

class CursorProcessTurn implements AgentTurn {
  private child?: ChildProcess
  private stopped = false
  private finished = false
  private done: Promise<void> = Promise.resolve()

  constructor(private req: TurnRequest, private cb: TurnCallbacks) {}

  run(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.done = new Promise<void>((resolve) => {
      const entry = [new URL('./cursorWorker.js', import.meta.url), new URL('../cursorWorker.js', import.meta.url)].find((url) => existsSync(url))
      if (!entry) { this.cb.finished({ ok: false, error: 'Cursor worker is missing. Rebuild Foreman.' }); resolve(); return }
      const child = fork(fileURLToPath(entry), [], {
        env: { ...this.req.env, ELECTRON_RUN_AS_NODE: '1' },
        // Parent execArgv may contain development or test loader flags.
        execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true
      })
      this.child = child
      trackChild(child, this.req.env, 'agent')
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000) })
      child.on('message', (message: CursorEvent) => {
        switch (message.type) {
          case 'item': this.cb.item(...message.args); break
          case 'sessionStarted': this.cb.sessionStarted(...message.args); break
          case 'usage': this.cb.usage(...message.args); break
          case 'finished': this.finished = true; this.cb.finished(...message.args); break
          case 'report': this.req.hostTools?.report?.(...message.args); break
          case 'ended': child.disconnect(); break
        }
      })
      child.on('error', (err) => {
        if (!this.finished) { this.finished = true; this.cb.finished({ ok: false, error: err.message }) }
      })
      child.on('exit', () => {
        if (!this.finished) this.cb.finished({ ok: false, error: this.stopped ? 'Stopped.' : stderr || 'Cursor process exited without a result.' })
        this.child = undefined
        resolve()
      })
      const { hostTools, sessionStore: _store, assistant: _assistant, ...request } = this.req
      child.send({ type: 'start', request, reports: Boolean(hostTools?.report) } satisfies CursorStart)
    })
    return this.done
  }

  async stop(): Promise<void> {
    this.stopped = true
    const child = this.child
    if (!child) return
    if (child.connected) child.send({ type: 'stop' })
    const timer = setTimeout(() => child.kill(), 5000)
    timer.unref()
    await this.done
    clearTimeout(timer)
  }
  steer(): boolean { return false }
  async setPlanMode(): Promise<void> {}
  async setModel(): Promise<void> {}
}

export const cursorProcessDriver: AgentDriver = {
  ...cursorDriver,
  createTurn: (request, callbacks) => new CursorProcessTurn(request, callbacks)
}
