import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '../src/cli/command'
import { phoneRunners } from '../src/cli/commands/phone'
import { renderCommandHelp } from '../src/cli/help'
import { CliCodedError } from '../src/main/cli/host'
import type { CliContext } from '../src/main/cli/methods'
import { PHONE_METHODS } from '../src/main/cli/phone'
import { METHODS, tierCheck } from '../src/main/cliServer'
import { commandName, findCommand } from '../src/shared/cliCommands'
import { PHONE_COMMANDS } from '../src/shared/cliCommandsSettings'
import type { PhoneApproveResult, PhoneDenyResult, PhoneLinkResult, PhonePendingResult, PhoneRevokeResult, PhoneStatusResult } from '../src/shared/cli/phone'
import { ACCESS_SCOPES, type MobileAccess, type MobileDevice, type MobileInfo } from '../src/shared/mobile'
import { fakeApi, stubHost } from './cliHost'

const ctx = { request: { method: 'x' }, caller: undefined, signal: undefined, progress: () => undefined } as CliContext

const device = (patch: Partial<MobileDevice> = {}): MobileDevice => ({ id: 'd-1111aaaa', name: 'iPhone', pairedAt: '2026-11-01T09:00:00.000Z', kind: 'phone', scopes: ['read', 'operate'], transport: 'private', lastSeen: '2026-11-10T08:30:00.000Z', ...patch })

/** A MobileService stand-in: the calls the dialog makes, over one MobileInfo, recording what was asked. */
function mobile(start: { info?: Partial<MobileInfo>; lan?: Partial<MobileInfo['lan']> } = {}) {
  const info: MobileInfo = {
    enabled: false,
    url: '',
    port: 47632,
    devices: [],
    ...start.info,
    lan: { enabled: false, address: '', port: 47633, candidates: [{ name: 'Wi-Fi', address: '192.168.1.20' }, { name: 'Ethernet', address: '10.0.0.5' }], ...start.lan }
  }
  const calls: [string, ...unknown[]][] = []
  const copy = (): MobileInfo => structuredClone(info)
  const api = fakeApi({
    mobileInfo: async () => copy(),
    mobileConfigure: async (enabled, url) => {
      calls.push(['mobileConfigure', enabled, url])
      Object.assign(info, { enabled, url })
      return copy()
    },
    mobileConfigureLan: async (enabled, address) => {
      calls.push(['mobileConfigureLan', enabled, address])
      Object.assign(info.lan, { enabled, address })
      return copy()
    },
    mobileStartPairing: async (mode = 'private') => {
      calls.push(['mobileStartPairing', mode])
      const origin = mode === 'private' ? info.url : `http://${info.lan.address}:${info.lan.port}`
      info.pairing = { mode, url: `${origin}/?pair=SECRET`, qr: 'data:image/png;base64,x', expiresAt: Date.now() + 120_000 }
      return copy()
    },
    mobileApprovePairing: async (id, allow, access: MobileAccess = 'operate') => {
      calls.push(['mobileApprovePairing', id, allow, access])
      const p = info.pending!
      if (allow) info.devices.push({ id: 'd-new', name: p.name, kind: p.kind, scopes: [...ACCESS_SCOPES[access]], pairedAt: '2026-11-10T10:00:00.000Z', transport: p.mode })
      delete info.pending
      return copy()
    },
    mobileRevokeDevice: async (id) => {
      calls.push(['mobileRevokeDevice', id])
      info.devices = info.devices.filter((d) => d.id !== id)
      return copy()
    }
  })
  const host = stubHost({ api })
  const call = <T>(method: string, params?: unknown) => PHONE_METHODS[method].handle(host, params, ctx) as Promise<T>
  // A phone that opened the link and is showing its code.
  const asks = (patch: Partial<NonNullable<MobileInfo['pending']>> = {}) => void (info.pending = { id: 'p-1', name: 'curl', kind: 'browser', code: '042917', mode: 'lan', expiresAt: Date.now() + 90_000, ...patch })
  return { info, calls, call, asks }
}

async function failure(promise: Promise<unknown>): Promise<CliCodedError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(CliCodedError)
  return err as CliCodedError
}

describe('the phone methods', () => {
  it('reads in read and changes who may sign in only in admin, the same as the command table says', () => {
    const tiers = { 'phone-status': 'read', 'phone-link': 'admin', 'phone-pending': 'read', 'phone-approve': 'admin', 'phone-deny': 'admin', 'phone-revoke': 'admin' }
    expect(Object.fromEntries(Object.entries(PHONE_METHODS).map(([m, d]) => [m, d.tier]))).toEqual(tiers)
    expect(Object.fromEntries(PHONE_COMMANDS.map((c) => [commandName(c), c.tier]))).toEqual({ phone: 'read', 'phone status': 'read', 'phone link': 'admin', 'phone pending': 'read', 'phone approve': 'admin', 'phone deny': 'admin', 'phone revoke': 'admin' })
    // Registered with the server, under those tiers.
    for (const [m, tier] of Object.entries(tiers)) expect(METHODS[m]?.tier, m).toBe(tier)
  })

  it('refuses every admin one from inside an agent turn, and serves the reads there', () => {
    const host = stubHost()
    const caller = { sessionId: 's', turnId: 't', token: 'turn-token' }
    for (const [method, def] of Object.entries(PHONE_METHODS)) {
      const refusal = tierCheck(method, def.tier, { v: 2, method, params: {}, caller, token: 'test-token' }, host)
      if (def.tier === 'admin') expect(refusal, method).toMatchObject({ code: 'refused', error: expect.stringContaining('inside an agent turn') })
      else expect(refusal, method).toBeNull()
    }
  })

  it('status lists both connections, the signed-in devices and a sign-in waiting', async () => {
    const m = mobile({ info: { enabled: true, url: 'https://mac.tail.ts.net', devices: [device(), device({ id: 'd-2222bbbb', name: 'Chrome', kind: 'browser', scopes: ['read'], transport: 'lan', lastSeen: undefined })] }, lan: { enabled: false, address: '192.168.1.20' } })
    m.asks()
    const result = await m.call<PhoneStatusResult>('phone-status')
    expect(result.private).toEqual({ on: true, url: 'https://mac.tail.ts.net' })
    expect(result.lan).toEqual({ on: false, address: '192.168.1.20', port: 47633 })
    expect(result.devices).toEqual([
      { id: 'd-1111aaaa', name: 'iPhone', kind: 'phone', access: 'operate', transport: 'private', pairedAt: '2026-11-01T09:00:00.000Z', lastSeen: '2026-11-10T08:30:00.000Z' },
      { id: 'd-2222bbbb', name: 'Chrome', kind: 'browser', access: 'read', transport: 'lan', pairedAt: '2026-11-01T09:00:00.000Z' }
    ])
    expect(result.pending).toMatchObject({ name: 'curl', kind: 'browser', code: '042917', mode: 'lan' })
    const lines = result.text.split('\n')
    expect(lines[0]).toMatch(/^Private \(Tailscale HTTPS\)\s+on\s+https:\/\/mac\.tail\.ts\.net$/)
    expect(lines[1]).toMatch(/^Same Wi-Fi\s+off\s+192\.168\.1\.20:47633$/)
    expect(result.text).toMatch(/NAME\s+KIND\s+ACCESS\s+CONNECTION\s+LAST SEEN\s+ID/)
    expect(result.text).toMatch(/iPhone\s+phone\s+operate\s+private\s+2026-11-10 08:30 UTC\s+d-1111aaaa/)
    expect(result.text).toMatch(/Chrome\s+browser\s+read\s+lan\s+never\s+d-2222bbbb/)
    // The seconds left are read when the command runs; a slow machine may have used one of them.
    expect(result.text).toMatch(/Waiting for approval: “curl” \(browser, same Wi-Fi\), code 042917, expires in 1m (29|30)s\./)
  })

  it('status says when nobody is signed in, and a record from before kinds and scopes reads as a phone that may operate', async () => {
    expect((await mobile().call<PhoneStatusResult>('phone-status')).text).toContain('No phones or browsers are signed in.')
    const old = mobile({ info: { devices: [{ id: 'd-old', name: 'Pixel', pairedAt: '2026-01-01T00:00:00.000Z' }] } })
    expect((await old.call<PhoneStatusResult>('phone-status')).devices).toEqual([{ id: 'd-old', name: 'Pixel', kind: 'phone', access: 'operate', pairedAt: '2026-01-01T00:00:00.000Z' }])
  })

  it('link defaults to same Wi-Fi when no private address is set, turning it on with the first address first', async () => {
    const m = mobile()
    const result = await m.call<PhoneLinkResult>('phone-link', { kind: 'phone' })
    expect(m.calls).toEqual([
      ['mobileConfigureLan', true, '192.168.1.20'],
      ['mobileStartPairing', 'lan']
    ])
    expect(result).toMatchObject({ mode: 'lan', kind: 'phone', url: 'http://192.168.1.20:47633/?pair=SECRET', turnedOn: 'lan' })
    expect(result.qr).toBeUndefined()
    expect(result.text).toContain('Turned on same-Wi-Fi access on 192.168.1.20 (Wi-Fi).')
    expect(result.text).toContain('Open this link on the phone within 2 minutes; it works once:\nhttp://192.168.1.20:47633/?pair=SECRET')
    expect(result.text).toContain('`foreman phone approve <code>`')
  })

  it('link keeps the same-Wi-Fi address chosen before, and leaves a listener that is on alone', async () => {
    const chosen = mobile({ lan: { address: '10.0.0.5' } })
    await chosen.call('phone-link', { mode: 'lan' })
    expect(chosen.calls[0]).toEqual(['mobileConfigureLan', true, '10.0.0.5'])
    const on = mobile({ lan: { enabled: true, address: '10.0.0.5' } })
    const result = await on.call<PhoneLinkResult>('phone-link', { mode: 'lan' })
    expect(on.calls).toEqual([['mobileStartPairing', 'lan']])
    expect(result.turnedOn).toBeUndefined()
    expect(result.text).not.toContain('Turned on')
  })

  it('link defaults to private once its address is set, turning private on when it is off', async () => {
    const m = mobile({ info: { url: 'https://mac.tail.ts.net' } })
    const result = await m.call<PhoneLinkResult>('phone-link', {})
    expect(m.calls).toEqual([
      ['mobileConfigure', true, 'https://mac.tail.ts.net'],
      ['mobileStartPairing', 'private']
    ])
    expect(result).toMatchObject({ mode: 'private', url: 'https://mac.tail.ts.net/?pair=SECRET', turnedOn: 'private' })
  })

  it('link --private with no address is refused with how to set one, and nothing is turned on', async () => {
    const m = mobile()
    const err = await failure(m.call('phone-link', { mode: 'private' }))
    expect(err.code).toBe('refused')
    expect(err.message).toBe('No private HTTPS address is set for this computer.')
    expect(err.hint).toContain('foreman settings set devices.mobile-url')
    expect(m.calls).toEqual([])
  })

  it('link refuses same Wi-Fi when the computer has no private address', async () => {
    const err = await failure(mobile({ lan: { candidates: [] } }).call('phone-link', { mode: 'lan' }))
    expect(err.code).toBe('refused')
    expect(err.hint).toContain('--private')
  })

  it('link --browser opens the full app at /app with the same one-time secret', async () => {
    const lan = await mobile({ lan: { enabled: true, address: '192.168.1.20' } }).call<PhoneLinkResult>('phone-link', { mode: 'lan', kind: 'browser' })
    expect(lan.url).toBe('http://192.168.1.20:47633/app?pair=SECRET')
    expect(lan.text).toContain('Open this link in the browser')
    const priv = await mobile({ info: { enabled: true, url: 'https://mac.tail.ts.net' } }).call<PhoneLinkResult>('phone-link', { kind: 'browser' })
    expect(priv.url).toBe('https://mac.tail.ts.net/app?pair=SECRET')
  })

  it('link --qr draws the link as text', async () => {
    const result = await mobile({ lan: { enabled: true, address: '192.168.1.20' } }).call<PhoneLinkResult>('phone-link', { mode: 'lan', qr: true })
    expect(result.qr).toMatch(/[█▀▄]/)
    expect(result.qr).not.toContain('\x1b')
    expect(result.text).toContain(result.qr!)
  })

  it('link checks its parameters', async () => {
    const m = mobile()
    expect((await failure(m.call('phone-link', { mode: 'wifi' }))).code).toBe('invalid')
    expect((await failure(m.call('phone-link', { kind: 'tablet' }))).code).toBe('invalid')
  })

  it('pending shows the waiting sign-in, or says there is none', async () => {
    const m = mobile()
    expect(await m.call<PhonePendingResult>('phone-pending')).toEqual({ pending: null, text: 'No sign-in is waiting.' })
    m.asks()
    const result = await m.call<PhonePendingResult>('phone-pending')
    expect(result.pending).toMatchObject({ name: 'curl', kind: 'browser', code: '042917' })
    expect(result.text).toContain('code 042917')
  })

  it('approve with the code shown approves that sign-in, with operate by default', async () => {
    const m = mobile()
    m.asks()
    const result = await m.call<PhoneApproveResult>('phone-approve', { code: '042917' })
    expect(m.calls).toEqual([['mobileApprovePairing', 'p-1', true, 'operate']])
    expect(result.device).toMatchObject({ id: 'd-new', name: 'curl', kind: 'browser', access: 'operate', transport: 'lan' })
    expect(result.text).toContain('Approved “curl” (browser) with access operate')
  })

  it('approve passes each access through', async () => {
    for (const access of ['read', 'operate', 'admin'] as const) {
      const m = mobile()
      m.asks()
      const result = await m.call<PhoneApproveResult>('phone-approve', { code: '042 917', access })
      expect(m.calls, access).toEqual([['mobileApprovePairing', 'p-1', true, access]])
      expect(result.device.access).toBe(access)
      expect(m.info.devices[0].scopes).toEqual([...ACCESS_SCOPES[access]])
    }
    const m = mobile()
    m.asks()
    expect((await failure(m.call('phone-approve', { code: '042917', access: 'window' }))).code).toBe('invalid')
    expect(m.calls).toEqual([])
  })

  it('approve refuses a code that differs, a code that isn’t six digits, and when nothing is waiting', async () => {
    const m = mobile()
    expect((await failure(m.call('phone-approve', { code: '042917' }))).message).toBe('No sign-in is waiting.')
    m.asks()
    const wrong = await failure(m.call('phone-approve', { code: '042918' }))
    expect(wrong.code).toBe('not-found')
    expect(wrong.message).toBe('That code doesn’t match the sign-in that is waiting.')
    expect((await failure(m.call('phone-approve', { code: '4291' }))).code).toBe('invalid')
    expect(m.calls).toEqual([])
    // The waiting sign-in is still there to approve with the right code.
    expect(m.info.pending).toBeDefined()
  })

  it('deny refuses the waiting sign-in, and says when nothing is waiting', async () => {
    const m = mobile()
    expect((await failure(m.call('phone-deny'))).code).toBe('not-found')
    m.asks()
    const result = await m.call<PhoneDenyResult>('phone-deny')
    expect(m.calls).toEqual([['mobileApprovePairing', 'p-1', false, 'operate']])
    expect(result.text).toBe('Denied the sign-in from “curl” (browser).')
    expect(m.info.devices).toEqual([])
  })

  it('revoke finds a device by id, by the start of its id or by a name only it has', async () => {
    const devices = [device(), device({ id: 'd-2222bbbb', name: 'Chrome', kind: 'browser' }), device({ id: 'd-3333cccc', name: 'Pixel' })]
    const byId = mobile({ info: { devices: structuredClone(devices) } })
    const result = await byId.call<PhoneRevokeResult>('phone-revoke', { device: 'd-2222bbbb' })
    expect(byId.calls).toEqual([['mobileRevokeDevice', 'd-2222bbbb']])
    expect(result.revoked).toMatchObject({ id: 'd-2222bbbb', name: 'Chrome', kind: 'browser' })
    expect(result.text).toContain('Revoked “Chrome” (browser).')
    const byName = mobile({ info: { devices: structuredClone(devices) } })
    await byName.call('phone-revoke', { device: 'pixel' })
    expect(byName.calls).toEqual([['mobileRevokeDevice', 'd-3333cccc']])
    const byPrefix = mobile({ info: { devices: structuredClone(devices) } })
    await byPrefix.call('phone-revoke', { device: 'd-1111' })
    expect(byPrefix.calls).toEqual([['mobileRevokeDevice', 'd-1111aaaa']])
  })

  it('revoke refuses a name several devices have, and one nobody has', async () => {
    const m = mobile({ info: { devices: [device(), device({ id: 'd-2222bbbb' })] } })
    const several = await failure(m.call('phone-revoke', { device: 'iPhone' }))
    expect(several.code).toBe('ambiguous')
    expect(several.message).toContain('d-1111aaaa')
    expect(several.message).toContain('d-2222bbbb')
    expect((await failure(m.call('phone-revoke', { device: 'Galaxy' }))).code).toBe('not-found')
    expect(m.calls).toEqual([])
  })
})

describe('the phone commands', () => {
  function fakeContext(args: string[], opts: Record<string, unknown> = {}, confirmed = true) {
    const sent: [string, unknown][] = []
    const out: string[] = []
    const notes: string[] = []
    const context: Context = {
      args,
      opts,
      json: false,
      quiet: false,
      yes: false,
      cwd: '/work',
      send: (async (method: string, params?: unknown) => {
        sent.push([method, params])
        return { text: `${method} ok` }
      }) as Context['send'],
      print: (_value, text) => void out.push(typeof text === 'function' ? text() : text),
      confirm: async () => confirmed,
      note: (text) => void notes.push(text),
      progress: () => undefined
    }
    return { context, sent, out, notes }
  }

  afterEach(() => void (process.exitCode = undefined))

  it('sends the words each command takes', async () => {
    const run = async (name: string, args: string[], opts: Record<string, unknown> = {}) => {
      const { context, sent } = fakeContext(args, opts)
      await phoneRunners[name](context)
      return sent
    }
    expect(await run('phone', [])).toEqual([['phone-status', undefined]])
    expect(await run('phone', ['status'])).toEqual([['phone-status', undefined]])
    expect(await run('phone status', [])).toEqual([['phone-status', undefined]])
    expect(await run('phone link', [])).toEqual([['phone-link', { mode: undefined, kind: 'phone', qr: undefined }]])
    expect(await run('phone link', [], { lan: true, browser: true, qr: true })).toEqual([['phone-link', { mode: 'lan', kind: 'browser', qr: true }]])
    expect(await run('phone link', [], { private: true })).toEqual([['phone-link', { mode: 'private', kind: 'phone', qr: undefined }]])
    expect(await run('phone pending', [])).toEqual([['phone-pending', undefined]])
    expect(await run('phone approve', ['042917'])).toEqual([['phone-approve', { code: '042917', access: undefined }]])
    expect(await run('phone approve', ['042917'], { access: 'read' })).toEqual([['phone-approve', { code: '042917', access: 'read' }]])
    expect(await run('phone deny', [])).toEqual([['phone-deny', undefined]])
    expect(await run('phone revoke', ['iPhone'])).toEqual([['phone-revoke', { device: 'iPhone' }]])
  })

  it('refuses what it can’t use before sending anything', async () => {
    for (const [name, args, opts] of [
      ['phone', ['everything'], {}],
      ['phone link', [], { lan: true, private: true }],
      ['phone link', ['now'], {}],
      ['phone approve', [], {}],
      ['phone approve', ['042917'], { access: 'everything' }],
      ['phone revoke', [], {}],
      ['phone deny', ['x'], {}]
    ] as [string, string[], Record<string, unknown>][]) {
      const { context, sent } = fakeContext(args, opts)
      await expect(phoneRunners[name](context), `${name} ${args.join(' ')}`).rejects.toMatchObject({ exitCode: 2 })
      expect(sent).toEqual([])
    }
  })

  it('revoke asks first, and a no revokes nothing', async () => {
    const { context, sent, notes } = fakeContext(['iPhone'], {}, false)
    await phoneRunners['phone revoke'](context)
    expect(sent).toEqual([])
    expect(notes).toEqual(['Nothing revoked.'])
    expect(process.exitCode).toBe(1)
  })

  it('has a runner, an example and a help page for every command, and resolves each path', () => {
    expect(Object.keys(phoneRunners).sort()).toEqual(PHONE_COMMANDS.map(commandName).sort())
    for (const spec of PHONE_COMMANDS) {
      const help = renderCommandHelp(spec)
      expect(help).toContain(spec.usage)
      for (const example of spec.examples ?? []) expect(findCommand(example.replace(/^foreman /, '').split(' ')), example).toMatchObject({ spec: { path: spec.path } })
    }
    expect(findCommand(['phone', 'approve', '042917'])).toMatchObject({ spec: { path: ['phone', 'approve'] }, rest: ['042917'] })
  })
})
