import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compareVersions, nextVersion, parseVersion, setVersion, tagProblems } from '../scripts/release.mjs'

// The release script (scripts/release.mjs): the version bump and the checks before a tag.

describe('release', () => {
  it('reads semver and rejects anything else', () => {
    expect(parseVersion('1.2.3-beta.4')).toEqual({ major: 1, minor: 2, patch: 3, pre: ['beta', '4'] })
    for (const bad of ['1.2', '01.2.3', 'v1.2.3', '1.2.3-', '1.2.3-01', ' 1.2.3']) expect(parseVersion(bad), bad).toBeNull()
  })

  it('orders versions by semver precedence, prereleases before their release', () => {
    const sorted = ['1.0.0', '1.0.0-rc.1', '0.10.0', '1.0.0-alpha', '1.0.0-beta.11', '0.9.9', '1.0.0-beta.2', '1.0.0-alpha.1', '1.0.0-alpha.beta']
    expect(sorted.sort(compareVersions)).toEqual(['0.9.9', '0.10.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'])
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0)
  })

  it('bumps a release, and finishes a prerelease when its release is the next step', () => {
    expect(['patch', 'minor', 'major'].map((b) => nextVersion('0.1.0', b))).toEqual(['0.1.1', '0.2.0', '1.0.0'])
    expect(['patch', 'minor', 'major'].map((b) => nextVersion('1.2.0-beta.1', b))).toEqual(['1.2.0', '1.2.0', '2.0.0'])
    expect(nextVersion('2.0.0-rc.1', 'major')).toBe('2.0.0')
  })

  it('takes an explicit version only when it comes after the current one', () => {
    expect(nextVersion('0.1.0', '0.2.0-beta.1')).toBe('0.2.0-beta.1')
    expect(nextVersion('0.1.0', 'v0.3.0')).toBe('0.3.0')
    expect(() => nextVersion('0.2.0', '0.2.0')).toThrow('must come after')
    expect(() => nextVersion('0.2.0', '0.2.0-rc.1')).toThrow('must come after')
    expect(() => nextVersion('0.2.0', 'next')).toThrow('Expected patch, minor, major')
    expect(() => nextVersion('0.2.0', undefined)).toThrow('not nothing')
  })

  it('changes only the package version in package.json and package-lock.json, keeping line endings', () => {
    const pkg = readFileSync('package.json', 'utf8')
    const lock = readFileSync('package-lock.json', 'utf8')
    const current = JSON.parse(pkg).version as string
    const out = setVersion(pkg, lock, '9.8.7')
    expect(JSON.parse(out.packageJson)).toEqual({ ...JSON.parse(pkg), version: '9.8.7' })
    const before = JSON.parse(lock)
    expect(JSON.parse(out.packageLock)).toEqual({ ...before, version: '9.8.7', packages: { ...before.packages, '': { ...before.packages[''], version: '9.8.7' } } })
    expect(setVersion(out.packageJson, out.packageLock, current)).toEqual({ packageJson: pkg, packageLock: lock })

    const crlf = setVersion('{\r\n  "name": "foreman",\r\n  "version": "0.1.0"\r\n}\r\n', '{\r\n  "version": "0.1.0",\r\n  "packages": {\r\n    "": {\r\n      "name": "foreman",\r\n      "version": "0.1.0"\r\n    },\r\n    "node_modules/x": {\r\n      "version": "0.1.0"\r\n    }\r\n  }\r\n}\r\n', '0.2.0')
    expect(crlf.packageJson).toBe('{\r\n  "name": "foreman",\r\n  "version": "0.2.0"\r\n}\r\n')
    expect(crlf.packageLock).toBe('{\r\n  "version": "0.2.0",\r\n  "packages": {\r\n    "": {\r\n      "name": "foreman",\r\n      "version": "0.2.0"\r\n    },\r\n    "node_modules/x": {\r\n      "version": "0.1.0"\r\n    }\r\n  }\r\n}\r\n')
  })

  it('refuses a file without the version fields rather than writing it half-changed', () => {
    expect(() => setVersion('{"name":"foreman","version":"0.1.0"}', '{"lockfileVersion":3,"packages":{}}', '0.2.0')).toThrow('Could not find the version fields')
  })

  it('tags a new version, but not one that exists or would come before the latest tag', () => {
    expect(tagProblems({ version: '0.2.0', tags: [] })).toEqual([])
    expect(tagProblems({ version: '0.2.0', tags: ['v0.1.0', 'v0.2.0-rc.1', 'unrelated', 'vnext'] })).toEqual([])
    expect(tagProblems({ version: '0.2.0', tags: ['v0.1.0', 'v0.2.0'] })).toEqual([expect.stringContaining('v0.2.0 already exists')])
    expect(tagProblems({ version: '0.2.0', tags: ['v0.3.0'] })).toEqual(['v0.2.0 would come before the existing v0.3.0'])
    expect(tagProblems({ version: 'main', tags: [] })).toEqual([expect.stringContaining('no semver version')])
  })
})
