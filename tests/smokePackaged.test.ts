import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { socketPath } from '../src/cli/protocol'
import { startCliServer } from '../src/main/cliServer'
import { ADMIN_PROBE, acceptedProblems, DB_FILE, findInstaller, healthProblems, installPlan, isSqlite, refusalProblems, request, socketPathFor, TOKEN_FILE } from '../scripts/smoke-packaged.mjs'
import { stubHost } from './cliHost'
import { tempDir } from './helpers'

// The packaged app's smoke test (scripts/smoke-packaged.mjs), which the Installers workflow runs on each installer. The
// launch itself needs a built installer and a desktop session; these check its parts against the real CLI server.

describe('packaged smoke test', () => {
  let close: (() => void) | undefined
  afterEach(() => close?.())

  it('finds the socket where the app listens, on every platform', () => {
    const long = path.join('/tmp', 'x'.repeat(120))
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const dir of [path.resolve('data'), long]) expect(socketPathFor(dir, platform), `${platform} ${dir}`).toBe(socketPath(dir, platform))
    }
  })

  it('picks the one installer for the platform and refuses none or several', () => {
    const dist = ['Foreman-1.2.3-arm64.dmg', 'Foreman-1.2.3-arm64.zip', 'Foreman-Setup-1.2.3.exe', 'latest.yml', 'Foreman-Setup-1.2.3.exe.blockmap']
    expect(findInstaller(dist, 'darwin')).toBe('Foreman-1.2.3-arm64.dmg')
    expect(findInstaller(dist, 'win32')).toBe('Foreman-Setup-1.2.3.exe')
    expect(() => findInstaller(['latest.yml'], 'win32')).toThrow('found none')
    expect(() => findInstaller(['a.dmg', 'b.dmg'], 'darwin')).toThrow('found 2')
    expect(() => findInstaller(dist, 'linux')).toThrow('No packaged smoke test')
  })

  it('installs silently for this user on Windows, into a folder without spaces, and copies the app out of the DMG on macOS', () => {
    const win = installPlan('win32', 'C:\\dist\\Foreman-Setup-1.2.3.exe', 'C:\\t\\smoke')
    expect(win.install).toEqual([['C:\\dist\\Foreman-Setup-1.2.3.exe', ['/S', '/currentuser', `/D=${path.join('C:\\t\\smoke', 'app')}`]]])
    expect(win.executable).toBe(path.join('C:\\t\\smoke', 'app', 'Foreman.exe'))
    expect(win.uninstall[0][0]).toBe(path.join('C:\\t\\smoke', 'app', 'Uninstall Foreman.exe'))
    expect(() => installPlan('win32', 'x.exe', 'C:\\Program Files\\t')).toThrow('no spaces')
    const mac = installPlan('darwin', '/d/Foreman.dmg', '/t')
    expect(mac.install.map(([file]) => file)).toEqual(['hdiutil', 'ditto', 'hdiutil'])
    expect(mac.executable).toBe(path.join('/t', 'Foreman.app', 'Contents', 'MacOS', 'Foreman'))
  })

  it('knows a SQLite file', () => {
    expect(isSqlite(Buffer.from('SQLite format 3\0more', 'latin1'))).toBe(true)
    expect(isSqlite(Buffer.from('not a database at all'))).toBe(false)
    expect(isSqlite(Buffer.alloc(4))).toBe(false)
    expect([DB_FILE, TOKEN_FILE]).toEqual(['foreman.db', 'cli.token'])
  })

  it('passes a packaged app of this version in this folder, and says what is wrong with anything else', () => {
    const expected = { version: '1.2.3', dataDir: '/data', platform: 'darwin' as const }
    const good = { ok: true, result: { version: '1.2.3', packaged: true, dataDir: '/data' } }
    expect(healthProblems(good, expected)).toEqual([])
    expect(healthProblems({ ok: true, result: { version: '1.2.2', packaged: false, dataDir: '/other' } }, expected)).toEqual([
      'app-info says this is not a packaged build',
      'app-info reports version 1.2.2, expected 1.2.3',
      'app-info reports the data folder /other, expected /data'
    ])
    expect(healthProblems({ ok: false, error: 'x', code: 'failed' }, expected)[0]).toMatch(/^app-info failed/)
    // Windows paths compare without regard to case.
    expect(healthProblems({ ok: true, result: { version: '1.2.3', packaged: true, dataDir: 'C:\\Data' } }, { ...expected, dataDir: 'c:\\data', platform: 'win32' })).toEqual([])
  })

  it('agrees with the real CLI server: app-info answers, and the admin probe is refused without the right token', async () => {
    const dataDir = await tempDir('smoke-packaged-')
    writeFileSync(path.join(dataDir, TOKEN_FILE), 'a'.repeat(64))
    const host = stubHost({ appInfo: () => ({ version: '1.2.3', packaged: true, dataDir }), cliToken: () => 'a'.repeat(64) })
    const socket = socketPathFor(dataDir)
    const server = await startCliServer(socket, host)
    close = () => server.close()

    const info = await request(socket, { v: 2, method: 'app-info' })
    expect(healthProblems(info, { version: '1.2.3', dataDir, socket, platform: process.platform })).toEqual([])

    const none = await request(socket, ADMIN_PROBE)
    expect(refusalProblems(none, 'no token')).toEqual([])
    expect(refusalProblems(await request(socket, { ...ADMIN_PROBE, token: '0'.repeat(64) }), 'wrong token')).toEqual([])
    const right = await request(socket, { ...ADMIN_PROBE, token: 'a'.repeat(64) })
    // Past the token check, the empty request fails on its own terms and changes nothing.
    expect(right).toMatchObject({ ok: false, code: 'invalid' })
    expect(acceptedProblems(right)).toEqual([])
    expect(acceptedProblems(none)[0]).toMatch(/was refused/)
    expect(refusalProblems(right, 'right token')[0]).toMatch(/was not refused/)
  })
})
