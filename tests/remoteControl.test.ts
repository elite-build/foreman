import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceNet } from '../src/main/deviceNet'
import { Devices } from '../src/main/devices'
import { RemoteComputers } from '../src/main/remote/computers'
import { RemoteHost } from '../src/main/remote/host'
import { ControlRefused, RemoteLink } from '../src/main/remote/link'
import { RemoteRouter } from '../src/main/remote/router'
import { createT } from '../src/shared/i18n'
import { hostAccepts, hostForwards, localWhileViewing, othersNeedYou, type ComputersView, type ComputerSummary } from '../src/shared/remote'
import type { MainEvent } from '../src/shared/types'

// Two computers on the loopback interface, paired, one controlling the other through the real TCP, encryption and
// channel code (main/remote/). The controlled one serves a small fake of the window's Api.

const VERSION = '1.0.11'
const closers: (() => unknown)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

const until = async (check: () => boolean, ms = 4000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

interface Options {
  allowed?: boolean
  ask?: boolean
  version?: string
}

function computer(name: string, platform: string, options: Options = {}) {
  const vault = new Map<string, string>()
  const store = { state: {}, save: () => undefined }
  const devices = new Devices({ store: store as never, keys: { get: (id) => vault.get(id), set: (id, k) => (k === null ? vault.delete(id) : vault.set(id, k)) }, machineName: () => name, changed: () => undefined })
  let port = 0
  const settings = { allowed: options.allowed ?? true, ask: options.ask ?? true }
  const listeners = new Set<(event: MainEvent) => void>()
  const calls: { method: string; args: unknown[] }[] = []
  const signals: { method: string; args: unknown[] }[] = []
  let summary: ComputerSummary = { running: 1, needsYou: 0 }
  const api: Record<string, (...args: unknown[]) => unknown> = {
    getSnapshot: async () => ({ platform, workspaces: [{ id: 'w1', name: 'tokyo' }] }),
    getChat: async (sessionId) => ({ sessionId, text: 'x'.repeat(3 * 1024 * 1024 + 5) }),
    attachData: async (workspaceId, fileName, base64) => {
      calls.push({ method: 'attachData', args: [workspaceId, fileName, base64] })
      return { name: fileName }
    },
    respondApproval: async (...args) => {
      calls.push({ method: 'respondApproval', args })
    },
    cancel: async () => {
      throw new Error('Nothing is running.')
    },
    openPath: async () => calls.push({ method: 'openPath', args: [] }),
    quitNow: async () => calls.push({ method: 'quitNow', args: [] })
  }
  const host = new RemoteHost({
    version: options.version ?? VERSION,
    platform,
    name: () => name,
    allowed: () => settings.allowed,
    ask: () => settings.ask,
    deviceName: (id) => devices.find(id)?.name ?? id,
    api,
    signals: {
      ptyWrite: (...args) => void signals.push({ method: 'ptyWrite', args }),
      setUnread: (...args) => void signals.push({ method: 'setUnread', args })
    },
    onEvent: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    summary: () => summary,
    changed: () => undefined
  })
  const net = new DeviceNet({
    self: () => devices.self(port),
    keyFor: (id) => devices.keyFor(id),
    addressOf: (id) => devices.addressOf(id),
    seen: (id) => devices.seen(id),
    onRequest: async () => ({ ok: true }),
    pairingHost: () => devices.pairingHost(),
    onPaired: (result, address) => {
      devices.add(result, address?.replace(/^::ffff:/, ''), result.peer.port)
      devices.cancelCode()
    },
    onRemote: (from, hello) => host.welcome(from, hello)
  })
  closers.push(() => net.close(), () => host.close())
  return {
    name,
    platform,
    devices,
    net,
    host,
    settings,
    calls,
    signals,
    id: () => devices.self().deviceId,
    emit: (event: MainEvent) => listeners.forEach((l) => l(event)),
    setSummary: (next: ComputerSummary) => {
      summary = next
      host.summaryChanged()
    },
    listen: async () => (port = await net.listen(0, '127.0.0.1'))
  }
}

async function pair(a: ReturnType<typeof computer>, b: ReturnType<typeof computer>) {
  const port = await b.listen()
  await a.listen()
  const code = b.devices.showCode(port).code
  const result = await a.net.pairWith('127.0.0.1', port, code)
  a.devices.add(result, '127.0.0.1', result.peer.port)
}

function link(from: ReturnType<typeof computer>, to: ReturnType<typeof computer>, version = VERSION) {
  const events: MainEvent[] = []
  const notes: MainEvent[] = []
  const revoked: string[] = []
  const l = new RemoteLink({
    deviceId: to.id(),
    hello: () => ({ protocol: 1, version, platform: from.platform, name: from.name }),
    open: (hello) => from.net.openChannel(to.id(), hello),
    changed: () => undefined,
    onEvent: (e) => void events.push(e),
    onNotify: (e) => void notes.push(e),
    onRevoked: (reason) => void revoked.push(reason)
  })
  closers.push(() => l.stop())
  l.start()
  return { link: l, events, notes, revoked }
}

describe('controlling another computer', () => {
  it('keeps a background link with the summary and notifications, and nothing else', async () => {
    const pc = computer('Desk', 'win32')
    const mac = computer('MacBook Pro', 'darwin')
    await pair(pc, mac)
    const { link: l, notes, events } = link(pc, mac)
    await until(() => l.status === 'online' && l.summary !== undefined)
    expect(l.summary).toEqual({ running: 1, needsYou: 0 })
    expect(l.platform).toBe('darwin')

    mac.setSummary({ running: 2, needsYou: 1 })
    await until(() => l.summary?.needsYou === 1)

    mac.emit({ type: 'notify', workspaceId: 'w1', sessionId: 's1', title: 'tokyo', body: 'needs approval', kind: 'attention' })
    mac.emit({ type: 'pty-data', ptyId: 'p', data: 'secret output' })
    await until(() => notes.length === 1)
    expect(events).toEqual([])
    // A background link can't call anything.
    await expect(l.call('getSnapshot', [])).rejects.toThrow()
  })

  it('asks the person there first, then serves calls, streams events and refuses what belongs to that screen', async () => {
    const pc = computer('Desk', 'win32')
    const mac = computer('MacBook Pro', 'darwin')
    await pair(pc, mac)
    const { link: l, events } = link(pc, mac)
    await until(() => l.status === 'online')

    const granted = l.requestControl()
    await until(() => mac.host.requests().length === 1)
    expect(mac.host.requests()[0]).toMatchObject({ deviceId: pc.id(), name: 'Desk', platform: 'win32' })
    expect(l.waiting).toBe(true)
    mac.host.answer(mac.host.requests()[0].id, true)
    await granted
    expect(l.mode).toBe('control')
    expect(mac.host.controllers()).toEqual([expect.objectContaining({ id: pc.id(), name: 'Desk' })])

    expect(await l.call('getSnapshot', [])).toMatchObject({ platform: 'darwin', workspaces: [{ name: 'tokyo' }] })
    // Bigger than one frame: it comes back in parts.
    const chat = (await l.call('getChat', ['s1'])) as { text: string }
    expect(chat.text.length).toBe(3 * 1024 * 1024 + 5)
    await l.call('respondApproval', ['a1', { kind: 'tool', allow: true }])
    expect(mac.calls).toContainEqual({ method: 'respondApproval', args: ['a1', { kind: 'tool', allow: true }] })
    await expect(l.call('cancel', ['s1'])).rejects.toThrow('Nothing is running.')
    await expect(l.call('openPath', ['/Users/yatin'])).rejects.toThrow('only be done on the computer itself')
    await expect(l.call('quitNow', [])).rejects.toThrow('only be done on the computer itself')
    await expect(l.call('attachFiles', ['w1', ['/etc/passwd']])).rejects.toThrow()
    await expect(l.call('notAMethod', [])).rejects.toThrow()
    expect(mac.calls.map((c) => c.method)).not.toContain('openPath')
    expect(mac.calls.map((c) => c.method)).not.toContain('quitNow')

    l.signal('ptyWrite', ['p1', 'ls\r'])
    l.signal('setUnread', [3])
    mac.emit({ type: 'pty-data', ptyId: 'p1', data: 'hello' })
    mac.emit({ type: 'navigate', workspaceId: 'w1' })
    mac.emit({ type: 'approval-resolved', id: 'a1' })
    await until(() => events.length === 2)
    expect(events.map((e) => e.type)).toEqual(['pty-data', 'approval-resolved'])
    expect(mac.signals).toEqual([{ method: 'ptyWrite', args: ['p1', 'ls\r'] }])
  })

  it('lets a computer in without asking when the person there chose that', async () => {
    const pc = computer('Desk', 'win32')
    const mac = computer('MacBook Pro', 'darwin', { ask: false })
    await pair(pc, mac)
    const { link: l } = link(pc, mac)
    await l.requestControl()
    expect(l.mode).toBe('control')
    expect(mac.host.requests()).toEqual([])
  })

  it('remembers an Allow when the link drops and comes back by itself', async () => {
    const pc = computer('Desk', 'win32')
    const mac = computer('MacBook Pro', 'darwin')
    await pair(pc, mac)
    const { link: l } = link(pc, mac)
    const granted = l.requestControl()
    await until(() => mac.host.requests().length === 1)
    mac.host.answer(mac.host.requests()[0].id, true)
    await granted
    // Dropped (sleep, Wi-Fi): it reconnects on its own and is let in again without a new question.
    ;(l as unknown as { channel: { close(): void } }).channel.close()
    await until(() => l.status !== 'online')
    await until(() => l.status === 'online' && l.mode === 'control', 6000)
    expect(mac.host.requests()).toEqual([])
  })

  it('says no when the person there denies, and hands control back when they disconnect you', async () => {
    const pc = computer('Desk', 'win32')
    const mac = computer('MacBook Pro', 'darwin')
    await pair(pc, mac)
    const { link: l, revoked } = link(pc, mac)
    await until(() => l.status === 'online')

    const denied = l.requestControl()
    await until(() => mac.host.requests().length === 1)
    mac.host.answer(mac.host.requests()[0].id, false)
    await expect(denied).rejects.toEqual(new ControlRefused('denied'))
    expect(l.mode).toBe('background')

    const again = l.requestControl()
    await until(() => mac.host.requests().length === 1)
    mac.host.answer(mac.host.requests()[0].id, true)
    await again
    mac.host.disconnect(pc.id())
    await until(() => revoked.length === 1)
    expect(revoked).toEqual(['denied'])
    expect(l.mode).toBe('background')
    await expect(l.call('getSnapshot', [])).rejects.toThrow()
    // Disconnecting forgets the Allow: the next request asks again.
    void l.requestControl().catch(() => undefined)
    await until(() => mac.host.requests().length === 1)
  })

  it('refuses a computer that doesn’t allow control, or runs another version', async () => {
    const pc = computer('Desk', 'win32')
    const mac = computer('MacBook Pro', 'darwin', { allowed: false })
    await pair(pc, mac)
    const off = link(pc, mac)
    await until(() => off.link.status === 'refused')
    await expect(off.link.requestControl()).rejects.toEqual(new ControlRefused('off'))
    off.link.stop()

    mac.settings.allowed = true
    const old = link(pc, mac, '1.0.10')
    await until(() => old.link.status === 'mismatch')
    expect(old.link.version).toBe(VERSION)
  })

  it('closes the links of a computer that was unpaired, or when control is turned off', async () => {
    const pc = computer('Desk', 'win32')
    const mac = computer('MacBook Pro', 'darwin', { ask: false })
    await pair(pc, mac)
    const { link: l } = link(pc, mac)
    await l.requestControl()
    mac.settings.allowed = false
    mac.host.refresh(() => true)
    await until(() => l.status !== 'online')
    expect(mac.host.controllers()).toEqual([])
  })
})

describe('switching the window to another computer', () => {
  it('shows it once it lets you in, and comes back with a reason when it ends control', async () => {
    const pc = computer('Desk', 'win32')
    const mac = computer('MacBook Pro', 'darwin', { ask: false })
    await pair(pc, mac)
    const reloads: number[] = []
    const afterReload: MainEvent[] = []
    const shown: MainEvent[] = []
    const broadcasts: MainEvent[] = []
    const computers = new RemoteComputers({
      self: () => ({ id: pc.id(), name: 'Desk' }),
      platform: 'win32',
      version: VERSION,
      paired: () => pc.devices.list(),
      canDial: (id) => Boolean(pc.devices.addressOf(id)),
      open: (id, hello) => pc.net.openChannel(id, hello),
      host: pc.host,
      localSummary: () => ({ running: 0, needsYou: 2 }),
      broadcast: (e) => void broadcasts.push(e),
      showEvent: (e) => void shown.push(e),
      reloadWindow: () => void reloads.push(1),
      afterReload: (e) => void afterReload.push(e),
      t: () => createT('en')
    })
    closers.push(() => computers.close())
    computers.sync()
    await until(() => computers.view_().computers[0]?.status === 'online')

    await computers.view(mac.id(), { workspaceId: 'w1' })
    expect(reloads).toHaveLength(1)
    expect(afterReload).toEqual([{ type: 'navigate', workspaceId: 'w1', sessionId: undefined }])
    const view = computers.view_()
    expect(view.viewing).toEqual({ id: mac.id(), name: 'MacBook Pro', state: 'connected' })
    // The window draws its own title bar and shortcuts: the platform is this computer's.
    expect(await computers.call('getSnapshot', [])).toMatchObject({ platform: 'win32' })
    mac.emit({ type: 'state', snapshot: { platform: 'darwin' } as never })
    await until(() => shown.length === 1)
    expect((shown[0] as Extract<MainEvent, { type: 'state' }>).snapshot.platform).toBe('win32')
    // While another computer is shown, this one's own count is what the chip's badge adds up.
    expect(othersNeedYou(view)).toBe(2)

    mac.host.disconnect(pc.id())
    await until(() => computers.view_().viewing === null)
    expect(reloads).toHaveLength(2)
    expect(afterReload.at(-1)).toEqual({ type: 'computer-left', name: 'MacBook Pro', reason: 'denied' })
  })

  it('comes back here when the link returns but control was turned off there meanwhile', async () => {
    const pc = computer('Desk', 'win32')
    const mac = computer('MacBook Pro', 'darwin', { ask: false })
    await pair(pc, mac)
    const afterReload: MainEvent[] = []
    const computers = new RemoteComputers({
      self: () => ({ id: pc.id(), name: 'Desk' }),
      platform: 'win32',
      version: VERSION,
      paired: () => pc.devices.list(),
      canDial: () => true,
      open: (id, hello) => pc.net.openChannel(id, hello),
      host: pc.host,
      localSummary: () => ({ running: 0, needsYou: 0 }),
      broadcast: () => undefined,
      showEvent: () => undefined,
      reloadWindow: () => undefined,
      afterReload: (e) => void afterReload.push(e),
      t: () => createT('en')
    })
    closers.push(() => computers.close())
    computers.sync()
    await until(() => computers.view_().computers[0]?.status === 'online')
    await computers.view(mac.id())
    mac.settings.allowed = false
    mac.host.refresh(() => true)
    await until(() => computers.view_().viewing?.state !== 'connected')
    await until(() => computers.view_().viewing === null, 6000)
    expect(afterReload.at(-1)).toEqual({ type: 'computer-left', name: 'MacBook Pro', reason: 'off' })
  })

  it('turns a refusal into words the window shows', async () => {
    const pc = computer('Desk', 'win32')
    const mac = computer('MacBook Pro', 'darwin', { allowed: false })
    await pair(pc, mac)
    const computers = new RemoteComputers({
      self: () => ({ id: pc.id(), name: 'Desk' }),
      platform: 'win32',
      version: VERSION,
      paired: () => pc.devices.list(),
      canDial: () => true,
      open: (id, hello) => pc.net.openChannel(id, hello),
      host: pc.host,
      localSummary: () => ({ running: 0, needsYou: 0 }),
      broadcast: () => undefined,
      showEvent: () => undefined,
      reloadWindow: () => undefined,
      afterReload: () => undefined,
      t: () => createT('en')
    })
    closers.push(() => computers.close())
    computers.sync()
    await until(() => computers.view_().computers[0]?.status === 'refused')
    await expect(computers.view(mac.id())).rejects.toThrow('MacBook Pro doesn’t let other computers control it')
    expect(computers.view_().viewing).toBeNull()
  })
})

describe('routing the window while it shows another computer', () => {
  function router(viewing: boolean) {
    const local = { getSnapshot: vi.fn(async () => 'local'), quitNow: vi.fn(async () => 'quit'), computers: vi.fn(async () => 'chip') }
    const remoteCalls: { method: string; args: unknown[] }[] = []
    const sent: { method: string; args: unknown[] }[] = []
    let down = false
    const remote = {
      viewing: () => (viewing ? { signal: (method: string, args: unknown[]) => void sent.push({ method, args }) } : null),
      viewingName: viewing ? 'MacBook Pro' : null,
      call: async (method: string, args: unknown[]) => {
        remoteCalls.push({ method, args })
        return `remote:${method}`
      },
      fallBackIfDown: () => {
        if (!down) return false
        viewing = false
        return true
      }
    }
    const localSignals = { ptyWrite: vi.fn(), setUnread: vi.fn() }
    const r = new RemoteRouter({ remote, local, localSignals, selfName: () => 'Desk', readFile: async () => Buffer.from('hi'), t: () => createT('en') })
    return { r, local, remoteCalls, sent, localSignals, goDown: () => (down = true) }
  }

  it('sends calls to the computer shown, keeps this computer’s own, and refuses what needs this screen', async () => {
    const { r, local, remoteCalls } = router(true)
    expect(await r.invoke('getSnapshot', [])).toBe('remote:getSnapshot')
    expect(await r.invoke('quitNow', [])).toBe('quit')
    expect(await r.invoke('computers', [])).toBe('chip')
    await expect(r.invoke('openInEditor', ['w1'] as never)).rejects.toThrow('MacBook Pro')
    await expect(r.invoke('pickDirectory', [])).rejects.toThrow()
    // A dropped file's contents travel, not its path on this computer.
    expect(await r.invoke('attachFiles', ['w1', ['C:\\Users\\yatin\\shot.png']])).toEqual(['remote:attachData'])
    expect(remoteCalls.at(-1)).toEqual({ method: 'attachData', args: ['w1', 'shot.png', Buffer.from('hi').toString('base64')] })
    expect(local.quitNow).toHaveBeenCalled()
  })

  it('keeps everything here with no other computer shown, and falls back here when the link is down on load', async () => {
    const here = router(false)
    expect(await here.r.invoke('getSnapshot', [])).toBe('local')
    expect(await here.r.invoke('openInEditor' as never, [] as never).catch(() => 'x')).not.toBe('remote:openInEditor')
    const down = router(true)
    down.goDown()
    expect(await down.r.invoke('getSnapshot', [])).toBe('local')
  })

  it('sends terminal keystrokes over, and keeps this window’s own signals', () => {
    const { r, sent, localSignals } = router(true)
    r.signal('ptyWrite', ['p1', 'x'])
    r.signal('setUnread', [1])
    expect(sent).toEqual([{ method: 'ptyWrite', args: ['p1', 'x'] }])
    expect(localSignals.setUnread).toHaveBeenCalledWith(1)
    expect(localSignals.ptyWrite).not.toHaveBeenCalled()
  })

  it('turns this computer’s events into alerts, or a switch back, while another is shown', () => {
    const { r } = router(true)
    expect(r.toWindow({ type: 'state', snapshot: {} as never })).toEqual({ drop: true })
    expect(r.toWindow({ type: 'pty-data', ptyId: 'p', data: 'x' })).toEqual({ drop: true })
    expect(r.toWindow({ type: 'quit-requested' })).toEqual({ send: { type: 'quit-requested' } })
    expect(r.toWindow({ type: 'navigate', workspaceId: 'w9' })).toEqual({ leave: { workspaceId: 'w9', sessionId: undefined } })
    expect(r.toWindow({ type: 'notify', workspaceId: 'w2', sessionId: 's2', title: 'lisbon', body: 'done', kind: 'finished' })).toEqual({
      send: { type: 'computer-notify', computerId: null, computerName: 'Desk', workspaceId: 'w2', sessionId: 's2', title: 'lisbon', body: 'done' }
    })
    expect(router(false).r.toWindow({ type: 'state', snapshot: {} as never })).toEqual({ send: { type: 'state', snapshot: {} } })
  })
})

describe('remote rules', () => {
  it('never forwards a computer’s own window events, and accepts nothing that belongs to its screen', () => {
    expect(hostForwards({ type: 'chat-item', sessionId: 's', item: {} as never })).toBe(true)
    expect(hostForwards({ type: 'computers', view: {} as ComputersView })).toBe(false)
    expect(hostForwards({ type: 'browser-open', workspaceId: 'w', url: 'x' })).toBe(false)
    expect(localWhileViewing({ type: 'computers', view: {} as ComputersView })).toBe(true)
    expect(localWhileViewing({ type: 'browser-open', workspaceId: 'w', url: 'x' })).toBe(false)
    for (const m of ['sendMessage', 'respondApproval', 'gitAction', 'ptySpawn', 'updateSettings', 'attachData']) expect(hostAccepts(m)).toBe(true)
    for (const m of ['quitNow', 'openPath', 'pickDirectory', 'attachFiles', 'viewComputer', 'computers', 'sttStart', 'openExternal', 'codexSignIn', 'codexSignInCancel']) expect(hostAccepts(m)).toBe(false)
    // Keys can be set from another computer, never read back.
    for (const m of ['revealEnvVar', 'revealAgentKey', 'revealProviderKey']) expect(hostAccepts(m)).toBe(false)
    for (const m of ['setAgentKey', 'setProviderKey', 'setEnvVars']) expect(hostAccepts(m)).toBe(true)
  })
})
