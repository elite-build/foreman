import { describe, expect, it } from 'vitest'
import { compareVersions as releaseCompare } from '../scripts/release.mjs'
import { compareVersions, isVersion, newerRelease, releaseUrl } from '../src/shared/appUpdate'

// Which release is newer (shared/appUpdate.ts): the app reads versions as the release script writes and tags them.

describe('compareVersions', () => {
  // Semver 2.0.0's precedence example, in order.
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '10.0.0']

  it('orders versions by semver precedence', () => {
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) expect(Math.sign(compareVersions(ordered[i], ordered[j])), `${ordered[i]} vs ${ordered[j]}`).toBe(Math.sign(i - j))
    }
  })

  it('agrees with the release script on every pair', () => {
    for (const a of ordered) for (const b of ordered) expect(Math.sign(compareVersions(a, b)), `${a} vs ${b}`).toBe(Math.sign(releaseCompare(a, b)))
  })

  it('refuses what is not a version', () => {
    expect(() => compareVersions('v1.0.0', '1.0.0')).toThrow(/Not a version: v1.0.0/)
    expect(() => compareVersions('1.0.0', '1.0')).toThrow(/Not a version: 1.0/)
    expect(isVersion('0.2.0-beta.1')).toBe(true)
    expect(isVersion('01.0.0')).toBe(false)
  })
})

describe('newerRelease', () => {
  const release = (tag: unknown, extra: Record<string, unknown> = {}) => ({ tag_name: tag, draft: false, prerelease: false, html_url: 'https://example.com/elsewhere', ...extra })

  it('offers a later published release, linking to its page on GitHub whatever the answer says', () => {
    expect(newerRelease('0.1.0', release('v0.2.0'))).toEqual({ version: '0.2.0', current: '0.1.0', url: 'https://github.com/elite-build/foreman/releases/tag/v0.2.0' })
    expect(releaseUrl('1.2.3')).toBe('https://github.com/elite-build/foreman/releases/tag/v1.2.3')
  })

  it('offers a release over the prerelease that led up to it', () => {
    expect(newerRelease('0.2.0-beta.1', release('v0.2.0'))?.version).toBe('0.2.0')
  })

  it('offers nothing for the same or an older version', () => {
    expect(newerRelease('0.2.0', release('v0.2.0'))).toBeNull()
    expect(newerRelease('0.3.0', release('v0.2.0'))).toBeNull()
  })

  it('offers nothing for a draft, a prerelease, or an answer that is not a release', () => {
    expect(newerRelease('0.1.0', release('v0.2.0', { draft: true }))).toBeNull()
    expect(newerRelease('0.1.0', release('v0.2.0-beta.1', { prerelease: true }))).toBeNull()
    expect(newerRelease('0.1.0', release('nightly'))).toBeNull()
    expect(newerRelease('0.1.0', release('v0.2.0/../../evil'))).toBeNull()
    expect(newerRelease('0.1.0', release(2))).toBeNull()
    expect(newerRelease('0.1.0', null)).toBeNull()
    expect(newerRelease('0.1.0', 'v0.2.0')).toBeNull()
  })

  it('throws when the running version is not a version', () => {
    expect(() => newerRelease('', release('v0.2.0'))).toThrow(/Not a version/)
  })
})
