// Foreman for Chrome, the app's side: the browsers that connected through the native-messaging host (src/cli/browserHostMain.ts)
// over the CLI socket, which of them the user allowed (Settings.browsers), and the requests agents' browser tools send them.
// The wire format and tool list are in shared/browserLink.ts. Nothing here touches a tab itself: the extension does that.
import type net from 'node:net'
import { BROWSER_KIND_LABEL, type BrowserGroupInfo, type BrowserKind, type BrowserLinkInfo, type BrowserMethod, type BrowserParams, type BrowserRequest, type BrowserStatus } from '../shared/browserLink'
import type { Settings } from '../shared/types'

// A screenshot travels as base64 in one line: a few megabytes at most, never this much.
const MAX_LINE = 64 * 1024 * 1024
const STOPPED = 'The user stopped browser use from the extension.'

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface Connection {
  conn: net.Socket
  installId: string
  kind: BrowserKind
  version?: string
  pending: Map<number, Pending>
}

interface Deps {
  settings(): Settings
  saveSettings(patch: Partial<Settings>): void
  changed(links: BrowserLinkInfo[]): void
  groups?(browserId: string): BrowserGroupInfo[]
}

const KINDS = Object.keys(BROWSER_KIND_LABEL) as BrowserKind[]

export class BrowserLink {
  private connections = new Map<string, Connection>()
  private nextRequest = 1

  constructor(private deps: Deps) {}

  /** A connection that passed the token check (server.ts → index.ts). `rest` is whatever arrived after its first line. */
  attach(conn: net.Socket, rest: string): void {
    let buffer = rest
    let current: Connection | null = null
    let done = false
    conn.on('error', () => undefined)
    conn.once('close', () => {
      done = true
      if (current) this.disconnect(current)
    })

    const handle = (line: string) => {
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (typeof message !== 'object' || message === null) return
      const msg = message as { type?: unknown } & Record<string, unknown>
      if (!current) {
        const hello = this.hello(msg)
        if (!hello) {
          done = true
          conn.end()
          return
        }
        current = this.connect(conn, hello)
        return
      }
      if (msg.type === 'response') {
        const id = msg.id
        const pending = typeof id === 'number' ? current.pending.get(id) : undefined
        if (!pending) return
        current.pending.delete(id as number)
        clearTimeout(pending.timer)
        if (msg.ok === true) pending.resolve(msg.result)
        else pending.reject(new Error(typeof msg.error === 'string' ? msg.error : 'The browser failed the request.'))
      } else if (msg.type === 'stop-all') {
        this.rejectAll(current, STOPPED)
      }
    }

    const drain = () => {
      let end = buffer.indexOf('\n')
      while (end >= 0 && !done) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (line.trim()) handle(line)
        end = buffer.indexOf('\n')
      }
      if (!done && buffer.length > MAX_LINE) {
        done = true
        conn.destroy()
      }
    }

    conn.on('data', (chunk: string) => {
      if (done) return
      buffer += chunk
      drain()
    })
    drain()
  }

  /** Every browser Foreman knows: the allowed ones (connected or not), then connected ones not allowed yet. */
  links(): BrowserLinkInfo[] {
    const saved = this.deps.settings().browsers ?? []
    const links: BrowserLinkInfo[] = saved.map((browser) => {
      const live = this.connections.get(browser.id)
      return { id: browser.id, kind: browser.kind, name: browser.name, allowed: true, connected: Boolean(live), ...(live?.version ? { version: live.version } : {}) }
    })
    for (const live of this.connections.values()) {
      if (saved.some((browser) => browser.id === live.installId)) continue
      links.push({ id: live.installId, kind: live.kind, name: BROWSER_KIND_LABEL[live.kind], allowed: false, connected: true, ...(live.version ? { version: live.version } : {}) })
    }
    return links
  }

  /** Allow a browser (or rename an allowed one). The first allowed browser becomes the default. */
  allow(id: string, name: string): void {
    const settings = this.deps.settings()
    const saved = settings.browsers ?? []
    const existing = saved.find((browser) => browser.id === id)
    const live = this.connections.get(id)
    const kind = live?.kind ?? existing?.kind
    if (!kind) throw new Error('That browser isn’t connected. Open it, then allow it again.')
    const label = name.trim() || BROWSER_KIND_LABEL[kind]
    const browsers = existing
      ? saved.map((browser) => (browser.id === id ? { id, name: label, kind } : browser))
      : [...saved, { id, name: label, kind }]
    this.deps.saveSettings({ browsers, ...(settings.browserDefault ? {} : { browserDefault: id }) })
    if (live) this.sendStatus(live)
    this.deps.changed(this.links())
  }

  /** Forget a browser: it must be allowed again before it can be used. */
  forget(id: string): void {
    const settings = this.deps.settings()
    const patch: Partial<Settings> = { browsers: (settings.browsers ?? []).filter((browser) => browser.id !== id) }
    if (settings.browserDefault === id) patch.browserDefault = undefined
    this.deps.saveSettings(patch)
    const live = this.connections.get(id)
    if (live) this.sendStatus(live)
    this.deps.changed(this.links())
  }

  /** One request to a connected, allowed browser. Rejects when it isn't either, when it answers with an error, or on timeout. */
  call(id: string, method: BrowserMethod, params: BrowserParams, timeoutMs = 30000): Promise<unknown> {
    const { name, allowed } = this.identity(id)
    const live = this.connections.get(id)
    if (!live) return Promise.reject(new Error(`${name} isn't connected. Open it, or check Foreman for Chrome is installed.`))
    if (!allowed) return Promise.reject(new Error(`${name} isn't allowed for Foreman yet. Allow it in Settings → Browser.`))
    const requestId = this.nextRequest++
    const request: BrowserRequest = { type: 'request', id: requestId, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        live.pending.delete(requestId)
        reject(new Error(`${name} didn't answer in time (${method}).`))
      }, timeoutMs)
      live.pending.set(requestId, { resolve, reject, timer })
      live.conn.write(`${JSON.stringify(request)}\n`)
    })
  }

  close(): void {
    for (const live of this.connections.values()) {
      this.rejectAll(live, 'Foreman for Chrome closed.')
      live.conn.end()
    }
    this.connections.clear()
  }

  // ---- internals ----

  /** The first message must be a hello with a non-empty install id; anything else ends the connection. */
  private hello(msg: Record<string, unknown>): { installId: string; kind: BrowserKind; version?: string } | null {
    if (msg.type !== 'hello') return null
    if (typeof msg.installId !== 'string' || !msg.installId.trim() || msg.installId.length > 200) return null
    const kind = KINDS.includes(msg.kind as BrowserKind) ? (msg.kind as BrowserKind) : 'other'
    const version = typeof msg.version === 'string' ? msg.version.slice(0, 64) : undefined
    return { installId: msg.installId, kind, ...(version ? { version } : {}) }
  }

  private connect(conn: net.Socket, hello: { installId: string; kind: BrowserKind; version?: string }): Connection {
    // A browser that connects again (a reloaded extension, a second profile with the same id) replaces its old connection.
    const old = this.connections.get(hello.installId)
    if (old) {
      this.rejectAll(old, 'The browser reconnected.')
      old.conn.end()
    }
    const live: Connection = { conn, installId: hello.installId, kind: hello.kind, ...(hello.version ? { version: hello.version } : {}), pending: new Map() }
    this.connections.set(hello.installId, live)
    this.sendStatus(live)
    this.deps.changed(this.links())
    return live
  }

  private disconnect(live: Connection): void {
    this.rejectAll(live, 'The browser disconnected before it answered.')
    if (this.connections.get(live.installId) !== live) return
    this.connections.delete(live.installId)
    this.deps.changed(this.links())
  }

  private rejectAll(live: Connection, message: string): void {
    for (const [id, pending] of live.pending) {
      clearTimeout(pending.timer)
      live.pending.delete(id)
      pending.reject(new Error(message))
    }
  }

  private identity(id: string): { name: string; allowed: boolean } {
    const saved = this.deps.settings().browsers?.find((browser) => browser.id === id)
    if (saved) return { name: saved.name, allowed: true }
    const live = this.connections.get(id)
    return { name: BROWSER_KIND_LABEL[live?.kind ?? 'other'], allowed: false }
  }

  private sendStatus(live: Connection): void {
    if (!live.conn.writable) return
    const { name, allowed } = this.identity(live.installId)
    const status: BrowserStatus = { type: 'status', allowed, name, groups: this.deps.groups?.(live.installId) ?? [] }
    live.conn.write(`${JSON.stringify(status)}\n`)
  }
}
