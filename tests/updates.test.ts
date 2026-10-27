import { describe, expect, it, vi } from 'vitest'
import { LATEST_RELEASE_API } from '../src/shared/appUpdate'
import { UpdateCheck, type UpdateDeps } from '../src/main/updates'

// The check for a newer Foreman (main/updates.ts), against a stand-in for GitHub's latest-release endpoint.

const answer = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status })
const release = (tag: string) => ({ tag_name: tag, draft: false, prerelease: false })

function rig(options: { current?: string; enabled?: boolean; reply?: () => Promise<Response> } = {}) {
  let skipped: string | undefined
  const fetch = vi.fn(options.reply ?? (async () => answer(200, release('v0.2.0'))))
  const changed = vi.fn()
  const deps: UpdateDeps = {
    currentVersion: () => options.current ?? '0.1.0',
    enabled: () => options.enabled ?? true,
    skipped: () => skipped,
    setSkipped: (version) => void (skipped = version),
    changed,
    fetch: fetch as unknown as typeof globalThis.fetch
  }
  return { updates: new UpdateCheck(deps), fetch, changed, skipped: () => skipped }
}

describe('UpdateCheck', () => {
  it('asks GitHub for the latest release and offers a newer one', async () => {
    const { updates, fetch, changed } = rig()
    expect(updates.notice()).toBeUndefined()
    await updates.atStartup()
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(LATEST_RELEASE_API)
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('Foreman/0.1.0')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(updates.notice()).toEqual({ version: '0.2.0', current: '0.1.0', url: 'https://github.com/elite-build/foreman/releases/tag/v0.2.0' })
  })

  it('asks nothing at startup while the setting is off, but Check now still asks', async () => {
    const { updates, fetch } = rig({ enabled: false })
    await updates.atStartup()
    expect(fetch).not.toHaveBeenCalled()
    expect(await updates.check()).toMatchObject({ state: 'available', update: { version: '0.2.0' } })
  })

  it('says up to date when the latest release is this one, or when there is no release yet', async () => {
    expect(await rig({ current: '0.2.0' }).updates.check()).toEqual({ state: 'current', current: '0.2.0' })
    const none = rig({ reply: async () => answer(404, { message: 'Not Found' }) })
    expect(await none.updates.check()).toEqual({ state: 'current', current: '0.1.0' })
    expect(none.updates.notice()).toBeUndefined()
    expect(none.changed).not.toHaveBeenCalled()
  })

  it('reports a failure for an error answer, no network, a body that is not JSON, or a version that is not semver', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const reply of [async () => answer(403, { message: 'rate limited' }), async () => Promise.reject(new TypeError('fetch failed')), async () => new Response('<html>', { status: 200 })]) {
      const { updates } = rig({ reply })
      expect(await updates.check()).toEqual({ state: 'failed', current: '0.1.0' })
      expect(updates.notice()).toBeUndefined()
    }
    expect(await rig({ current: 'dev' }).updates.check()).toEqual({ state: 'failed', current: 'dev' })
    // At startup a failure is only logged.
    await rig({ reply: async () => answer(500) }).updates.atStartup()
    expect(warn).toHaveBeenCalledWith('Could not check for a newer Foreman.')
    warn.mockRestore()
  })

  it('shares a check that is already under way', async () => {
    const { updates, fetch } = rig()
    const [a, b] = await Promise.all([updates.check(), updates.check()])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    await updates.check()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('Later hides the notice until the next start; asking again about the same release keeps it hidden', async () => {
    const { updates, changed, skipped } = rig()
    await updates.check()
    updates.dismiss(false)
    expect(updates.notice()).toBeUndefined()
    expect(skipped()).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(2)
    await updates.check()
    expect(updates.notice()).toBeUndefined()
  })

  it('Skip this version saves it and hides that release; a newer one is offered again', async () => {
    let tag = 'v0.2.0'
    const { updates, skipped } = rig({ reply: async () => answer(200, release(tag)) })
    await updates.check()
    updates.dismiss(true)
    expect(skipped()).toBe('0.2.0')
    expect(updates.notice()).toBeUndefined()
    tag = 'v0.3.0'
    await updates.check()
    expect(updates.notice()?.version).toBe('0.3.0')
  })

  it('a release that is withdrawn takes the notice with it', async () => {
    let reply = answer(200, release('v0.2.0'))
    const { updates, changed } = rig({ reply: async () => reply })
    await updates.check()
    reply = answer(404)
    await updates.check()
    expect(updates.notice()).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
