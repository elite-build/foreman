// `npm run dev`'s data folder (scripts/devData.mjs, scripts/dev.mjs): each worktree's own by default, outside the
// worktree; FOREMAN_DATA_DIR still chooses it; `--real-data` uses the installed app's.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appDataFolder, devDataDir, REAL_DATA_FLAG, worktreeDataDir } from '../scripts/devData.mjs'

const home = path.resolve('/home/dev')
const appData = path.resolve('/appdata')

describe('the development data folder', () => {
  it('gives each worktree a folder of its own in the application data folder, never inside the worktree', () => {
    const a = path.resolve('/code/workspaces/foreman/my-feature')
    const b = path.resolve('/code/workspaces/foreman/other')
    const dir = worktreeDataDir(a, appData)
    expect(path.dirname(dir)).toBe(path.join(appData, 'Foreman Dev'))
    expect(path.basename(dir)).toMatch(/^my-feature-[0-9a-f]{10}$/)
    expect(path.relative(a, dir).startsWith('..')).toBe(true)
    // The same worktree always gets the same folder, so its data survives Foreman making the worktree again.
    expect(worktreeDataDir(`${a}${path.sep}`, appData)).toBe(dir)
    // Another worktree, even one with the same folder name elsewhere, gets another.
    expect(worktreeDataDir(b, appData)).not.toBe(dir)
    expect(worktreeDataDir(path.resolve('/elsewhere/my-feature'), appData)).not.toBe(dir)
    // Windows paths compare without case.
    if (process.platform === 'win32') expect(worktreeDataDir('C:\\Code\\my-feature', appData, 'win32')).toBe(worktreeDataDir('c:\\code\\my-feature', appData, 'win32'))
  })

  it('finds the application data folder where Electron does', () => {
    expect(appDataFolder('win32', { APPDATA: 'D:\\Users\\dev\\AppData\\Roaming' }, home)).toBe('D:\\Users\\dev\\AppData\\Roaming')
    expect(appDataFolder('darwin', {}, home)).toBe(path.join(home, 'Library', 'Application Support'))
    expect(appDataFolder('linux', {}, home)).toBe(path.join(home, '.config'))
    expect(appDataFolder('linux', { XDG_CONFIG_HOME: path.resolve('/xdg') }, home)).toBe(path.resolve('/xdg'))
  })

  it('uses the worktree’s folder by default, FOREMAN_DATA_DIR when set, and the installed app’s only when asked', () => {
    const cwd = path.resolve('/code/my-feature')
    const own = devDataDir({ cwd, env: { XDG_CONFIG_HOME: appData }, args: ['--inspect'], platform: 'linux', home })
    const dir = worktreeDataDir(cwd, appData, 'linux')
    expect(own).toEqual({ source: 'worktree', dir, shown: dir, args: ['--inspect'] })
    // FOREMAN_DATA_DIR (or the older name) is left to the app, which reads it as before.
    expect(devDataDir({ cwd, env: { FOREMAN_DATA_DIR: '/tmp/fd' }, args: [], home })).toEqual({ source: 'env', shown: '/tmp/fd', args: [] })
    expect(devDataDir({ cwd, env: { SWITCHYARD_DATA_DIR: '/tmp/sy' }, args: [], home })).toMatchObject({ source: 'env', shown: '/tmp/sy' })
    // --real-data sets nothing, and isn't passed on to electron-vite.
    expect(devDataDir({ cwd, env: {}, args: [REAL_DATA_FLAG, '--inspect'], home })).toEqual({ source: 'real', args: ['--inspect'] })
    // FOREMAN_DATA_DIR wins over the flag.
    expect(devDataDir({ cwd, env: { FOREMAN_DATA_DIR: '/tmp/fd' }, args: [REAL_DATA_FLAG], home })).toMatchObject({ source: 'env', args: [] })
  })
})
