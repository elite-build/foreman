import { afterEach, describe, expect, it, vi } from 'vitest'
import { LATEST_RELEASE_API, RELEASES_API, releaseApi, type InstallUnavailable, type UpdateChannel, type UpdateInterval, type UpdateMode } from '../src/shared/appUpdate'
import { UpdateCheck, type UpdateDeps, type UpdateInstaller } from '../src/main/updates'

// The check for a newer Foreman (main/updates.ts), against a stand-in for GitHub's release endpoints and for the
// installer (main/updateInstaller.ts).

const answer = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status })
const release = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, draft: false, prerelease: false, ...extra })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A stand-in installer: each download waits until the test finishes or fails it. */
function fakeInstaller(reason: InstallUnavailable | null = null) {
  let settle: { resolve: () => void; reject: (err: Error) => void; progress: (t: number, total: number) => void } | null = null
  const installer = {
    unavailable: vi.fn(async () => reason),
    download: vi.fn(
      (_version: string, _prerelease: boolean, progress: (t: number, total: number) => void) =>
        new Promise<void>((resolve, reject) => {
          settle = { resolve, reject, progress }
        })
    ),
    cancel: vi.fn(() => settle?.reject(new Error('cancelled'))),
    installOnQuit: vi.fn()
  } satisfies UpdateInstaller
  return {
    installer,
    progress: (t: number, total: number) => settle!.progress(t, total),
    finish: async () => {
      settle!.resolve()
      await flush()
    },
    fail: async () => {
      settle!.reject(new Error('404'))
      await flush()
    }
  }
}

interface RigOptions {
  current?: string
  enabled?: boolean
  reply?: (url: string) => Promise<Response>
  mode?: UpdateMode
  channel?: UpdateChannel
  interval?: UpdateInterval
  installer?: UpdateInstaller
  lastRun?: string
}

function rig(options: RigOptions = {}) {
  let skipped: string | undefined
  let lastRun = options.lastRun
  const settings = { enabled: options.enabled ?? true, mode: options.mode ?? 'notify', channel: options.channel ?? 'stable', interval: options.interval ?? 'every-4-hours' }
  const fetch = vi.fn(options.reply ?? (async () => answer(200, release('v0.2.0', { body: '## New\n- Things', published_at: '2026-10-01T00:00:00Z' }))))
  const changed = vi.fn()
  const deps: UpdateDeps = {
    currentVersion: () => options.current ?? '0.1.0',
    enabled: () => settings.enabled,
    mode: () => settings.mode,
    channel: () => settings.channel,
    interval: () => settings.interval,
    skipped: () => skipped,
    setSkipped: (version) => void (skipped = version),
    lastRun: () => lastRun,
    setLastRun: (version) => void (lastRun = version),
    installer: options.installer,
    changed,
    fetch: fetch as unknown as typeof globalThis.fetch
  }
  return { updates: new UpdateCheck(deps), fetch, changed, settings, skipped: () => skipped, lastRun: () => lastRun }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('UpdateCheck: asking GitHub', () => {
  it('asks GitHub for the latest release and offers a newer one, with its notes', async () => {
    const { updates, fetch } = rig()
    expect(updates.view().notice).toBeUndefined()
    await updates.check()
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(LATEST_RELEASE_API)
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('Foreman/0.1.0')
    expect(updates.view().notice).toEqual({
      version: '0.2.0',
      current: '0.1.0',
      url: 'https://github.com/elite-build/foreman/releases/tag/v0.2.0',
      notes: '## New\n- Things',
      publishedAt: '2026-10-01T00:00:00Z',
      phase: { state: 'available' }
    })
    expect(updates.view()).toMatchObject({ checking: false, lastResult: 'available', latest: { version: '0.2.0' } })
  })

  it('Beta asks for the release list and offers the newest prerelease', async () => {
    const reply = async () => answer(200, [release('v0.3.0-beta.1', { prerelease: true }), release('v0.2.0'), release('v0.4.0', { draft: true })])
    const { updates, fetch } = rig({ channel: 'beta', reply })
    expect(await updates.check()).toMatchObject({ state: 'available', update: { version: '0.3.0-beta.1', prerelease: true } })
    expect(fetch.mock.calls[0][0]).toBe(RELEASES_API)
  })

  it('says up to date when the latest release is this one, or when there is no release yet', async () => {
    expect(await rig({ current: '0.2.0' }).updates.check()).toEqual({ state: 'current', current: '0.2.0' })
    const none = rig({ reply: async () => answer(404, { message: 'Not Found' }) })
    expect(await none.updates.check()).toEqual({ state: 'current', current: '0.1.0' })
    expect(none.updates.view().notice).toBeUndefined()
    expect(none.updates.view().lastResult).toBe('current')
  })

  it('reports a failure for an error answer, no network, a body that is not JSON, or a version that is not semver', async () => {
    for (const reply of [async () => answer(403, { message: 'rate limited' }), async () => Promise.reject(new TypeError('fetch failed')), async () => new Response('<html>', { status: 200 })]) {
      const { updates } = rig({ reply })
      expect(await updates.check()).toEqual({ state: 'failed', current: '0.1.0' })
      expect(updates.view()).toMatchObject({ lastResult: 'failed' })
      expect(updates.view().notice).toBeUndefined()
    }
    expect(await rig({ current: 'dev' }).updates.check()).toEqual({ state: 'failed', current: 'dev' })
  })

  it('shares a check that is already under way, and says it is checking meanwhile', async () => {
    const { updates, fetch } = rig()
    const a = updates.check()
    expect(updates.view().checking).toBe(true)
    const b = updates.check()
    expect(await a).toBe(await b)
    expect(fetch).toHaveBeenCalledTimes(1)
    await updates.check()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('Later hides the notice until the next start; asking again about the same release keeps it hidden', async () => {
    const { updates, skipped } = rig()
    await updates.check()
    updates.dismiss(false)
    expect(updates.view().notice).toBeUndefined()
    expect(skipped()).toBeUndefined()
    await updates.check()
    expect(updates.view().notice).toBeUndefined()
    // Settings still knows about it.
    expect(updates.view().latest?.version).toBe('0.2.0')
  })

  it('Skip this version saves it and hides that release; a newer one is offered again', async () => {
    let tag = 'v0.2.0'
    const { updates, skipped } = rig({ reply: async () => answer(200, release(tag)) })
    await updates.check()
    updates.dismiss(true)
    expect(skipped()).toBe('0.2.0')
    expect(updates.view().notice).toBeUndefined()
    tag = 'v0.3.0'
    await updates.check()
    expect(updates.view().notice?.version).toBe('0.3.0')
  })

  it('a release that is withdrawn takes the notice with it', async () => {
    let reply = answer(200, release('v0.2.0'))
    const { updates } = rig({ reply: async () => reply })
    await updates.check()
    reply = answer(404)
    await updates.check()
    expect(updates.view().notice).toBeUndefined()
  })

  it('notes: the offered release’s from the last check, any other release’s from GitHub by its tag', async () => {
    const { updates, fetch } = rig({
      reply: async (url) => (url === releaseApi('0.1.0') ? answer(200, release('v0.1.0', { body: 'Old notes' })) : answer(200, release('v0.2.0', { body: 'New notes' })))
    })
    await updates.check()
    expect(await updates.notes('0.2.0')).toMatchObject({ version: '0.2.0', notes: 'New notes' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await updates.notes('0.1.0')).toMatchObject({ version: '0.1.0', notes: 'Old notes', url: 'https://github.com/elite-build/foreman/releases/tag/v0.1.0' })
    fetch.mockImplementation(async () => Promise.reject(new TypeError('offline')))
    expect(await updates.notes('0.0.9')).toBeNull()
  })
})

describe('UpdateCheck: the schedule', () => {
  it('start checks at once while automatic checks are on, then again after the chosen interval', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { updates, fetch, settings } = rig({ interval: 'hourly' })
    await updates.start()
    expect(fetch).toHaveBeenCalledTimes(1)
    const next = updates.view().nextCheck!
    expect(new Date(next).getTime() - new Date(updates.view().lastChecked!).getTime()).toBe(60 * 60_000)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    // A different interval moves the next check.
    settings.interval = 'daily'
    updates.settingsChanged()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(22 * 60 * 60_000)
    expect(fetch).toHaveBeenCalledTimes(3)
    updates.stop()
    expect(warn).not.toHaveBeenCalled()
  })

  it('asks nothing at start while automatic checks are off, but Check now still asks; turning them on checks', async () => {
    vi.useFakeTimers()
    const { updates, fetch, settings } = rig({ enabled: false })
    await updates.start()
    expect(fetch).not.toHaveBeenCalled()
    expect(updates.view().nextCheck).toBeUndefined()
    await vi.advanceTimersByTimeAsync(48 * 60 * 60_000)
    expect(fetch).not.toHaveBeenCalled()
    settings.enabled = true
    updates.settingsChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    updates.stop()
  })

  it('a start-up failure is only logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { updates } = rig({ reply: async () => answer(500) })
    await updates.start()
    expect(warn).toHaveBeenCalledWith('Could not check for a newer Foreman.')
    updates.stop()
  })

  it('waking checks only when the last check is a while ago', async () => {
    vi.useFakeTimers()
    const { updates, fetch } = rig()
    updates.woke()
    expect(fetch).not.toHaveBeenCalled() // not started (a development build)
    await updates.start()
    updates.woke()
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    updates.woke()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    updates.stop()
  })

  it('a different channel checks again at once', async () => {
    const { updates, fetch, settings } = rig({ reply: async (url) => (url === RELEASES_API ? answer(200, [release('v0.3.0-beta.1', { prerelease: true })]) : answer(404)) })
    await updates.start()
    expect(updates.view().notice).toBeUndefined()
    settings.channel = 'beta'
    updates.settingsChanged({ channel: true })
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(updates.view().notice?.version).toBe('0.3.0-beta.1')
    updates.stop()
  })
})

describe('UpdateCheck: downloading and installing', () => {
  it('says why it can’t install, and then never downloads, whatever the mode', async () => {
    const fake = fakeInstaller('unsigned')
    const { updates } = rig({ mode: 'download', installer: fake.installer })
    await flush()
    expect(updates.view().installUnavailable).toBe('unsigned')
    await updates.check()
    expect(fake.installer.download).not.toHaveBeenCalled()
    expect(updates.view().notice?.phase).toEqual({ state: 'available' })
    await expect(updates.download()).rejects.toThrow()
    // Without an installer at all (tests, no Electron) it can't either.
    expect(rig().updates.view().installUnavailable).toBe('unsupported')
  })

  it('Tell me only offers; Download fetches it with progress, then it is ready and installs only on Restart', async () => {
    let clock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const fake = fakeInstaller()
    const { updates, changed } = rig({ mode: 'notify', installer: fake.installer })
    await flush()
    expect(updates.view().installUnavailable).toBeUndefined()
    await updates.check()
    expect(fake.installer.download).not.toHaveBeenCalled()
    const done = updates.download()
    expect(fake.installer.download).toHaveBeenCalledWith('0.2.0', false, expect.any(Function))
    expect(updates.view().notice?.phase).toEqual({ state: 'downloading', transferred: 0, total: 0 })
    const before = changed.mock.calls.length
    clock = 500
    fake.progress(10, 100)
    clock = 1500
    fake.progress(20, 100)
    clock = 1600
    fake.progress(30, 100)
    // The phase follows every step; the window is redrawn at most once a second.
    expect(updates.view().notice?.phase).toEqual({ state: 'downloading', transferred: 30, total: 100 })
    expect(changed.mock.calls.length - before).toBe(1)
    await fake.finish()
    await done
    expect(updates.view().notice?.phase).toEqual({ state: 'ready', onQuit: false })
    expect(fake.installer.installOnQuit).toHaveBeenLastCalledWith(false)
    expect(updates.ready()).toBe(true)
  })

  it('the download modes fetch a found release at once; “install when I quit” installs it at quit', async () => {
    const fake = fakeInstaller()
    const { updates } = rig({ mode: 'quit', installer: fake.installer })
    await flush()
    await updates.check()
    expect(fake.installer.download).toHaveBeenCalledTimes(1)
    await fake.finish()
    expect(updates.view().notice?.phase).toEqual({ state: 'ready', onQuit: true })
    expect(fake.installer.installOnQuit).toHaveBeenLastCalledWith(true)
  })

  it('the card’s Install when I quit, in the download-then-ask mode', async () => {
    const fake = fakeInstaller()
    const { updates } = rig({ mode: 'download', installer: fake.installer })
    await flush()
    await updates.check()
    await fake.finish()
    expect(updates.view().notice?.phase).toEqual({ state: 'ready', onQuit: false })
    updates.installOnQuit(true)
    expect(updates.view().notice?.phase).toEqual({ state: 'ready', onQuit: true })
    expect(fake.installer.installOnQuit).toHaveBeenLastCalledWith(true)
  })

  it('a failed download offers Try again (and the release page) rather than retrying by itself; Stop just stops', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fake = fakeInstaller()
    const { updates } = rig({ mode: 'download', installer: fake.installer })
    await flush()
    await updates.check()
    await fake.fail()
    expect(updates.view().notice?.phase).toEqual({ state: 'available', failed: true })
    expect(warn).toHaveBeenCalled()
    await updates.check()
    expect(fake.installer.download).toHaveBeenCalledTimes(1)
    void updates.download()
    expect(fake.installer.download).toHaveBeenCalledTimes(2)
    updates.stopDownload()
    await flush()
    expect(fake.installer.cancel).toHaveBeenCalled()
    expect(updates.view().notice?.phase).toEqual({ state: 'available' })
  })

  it('Skip this version stops its download, and a downloaded one no longer installs at quit', async () => {
    const fake = fakeInstaller()
    const { updates } = rig({ mode: 'quit', installer: fake.installer })
    await flush()
    await updates.check()
    await fake.finish()
    updates.dismiss(true)
    expect(fake.installer.installOnQuit).toHaveBeenLastCalledWith(false)
    expect(updates.view().notice).toBeUndefined()
  })

  it('waiting for agents to restart, and cancelling that wait', async () => {
    const fake = fakeInstaller()
    const { updates } = rig({ mode: 'download', installer: fake.installer })
    await flush()
    await updates.check()
    updates.setWaiting(true)
    // Nothing downloaded yet: nothing to wait for.
    expect(updates.view().notice?.phase.state).toBe('downloading')
    await fake.finish()
    updates.setWaiting(true)
    expect(updates.view().notice?.phase).toEqual({ state: 'waiting' })
    expect(updates.ready()).toBe(true)
    updates.setWaiting(false)
    expect(updates.view().notice?.phase).toEqual({ state: 'ready', onQuit: false })
  })
})

describe('UpdateCheck: after an update', () => {
  it('a later version than the last run says “Updated to …” until the window has said it, and remembers this version', () => {
    const { updates, lastRun } = rig({ current: '0.2.0', lastRun: '0.1.0' })
    expect(updates.view().updatedFrom).toBe('0.1.0')
    expect(lastRun()).toBe('0.2.0')
    updates.dismissUpdated()
    expect(updates.view().updatedFrom).toBeUndefined()
  })

  it('says nothing on a first run, the same version, or an older one', () => {
    expect(rig({ current: '0.2.0' }).updates.view().updatedFrom).toBeUndefined()
    expect(rig({ current: '0.2.0', lastRun: '0.2.0' }).updates.view().updatedFrom).toBeUndefined()
    expect(rig({ current: '0.1.0', lastRun: '0.2.0' }).updates.view().updatedFrom).toBeUndefined()
  })
})
