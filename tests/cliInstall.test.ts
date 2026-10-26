import { chmod, mkdir, readlink, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cliStatus, installCli, shimPath } from '../src/main/cliInstall'
import { tempDir } from './helpers'

// Exercise POSIX link replacement on Windows without requiring Developer Mode.
// Directory junctions preserve realpath/readlink/lstat behaviour for these fixtures.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    symlinkSync: (target: string, link: string) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'file'),
    rmSync: (link: string) => process.platform === 'win32' && fs.lstatSync(link).isSymbolicLink() ? fs.unlinkSync(link) : fs.rmSync(link)
  }
})

async function setup() {
  const dir = await tempDir()
  const shim = path.join(dir, 'app', 'resources', 'cli', 'foreman')
  await mkdir(path.dirname(shim), { recursive: true })
  if (process.platform === 'win32') await mkdir(shim)
  else await writeFile(shim, '#!/bin/sh\n')
  const system = path.join(dir, 'usr-local-bin')
  const user = path.join(dir, 'home', '.local', 'bin')
  await mkdir(system)
  return { dir, shim, system, user, linkDirs: [system, user], pathDirs: async () => [system, user] }
}

describe('installing the foreman command', () => {
  it('finds the launcher for packaged and source builds', () => {
    expect(shimPath({ packaged: true, resourcesPath: '/A/Resources', appPath: '/x', platform: 'darwin' })).toBe(path.join('/A/Resources', 'cli', 'foreman'))
    expect(shimPath({ packaged: true, resourcesPath: '/A/resources', appPath: '/x', platform: 'win32' })).toBe(path.join('/A/resources', 'cli', 'foreman.cmd'))
    expect(shimPath({ packaged: false, resourcesPath: '/A', appPath: '/repo', platform: 'darwin' })).toBe(path.join('/repo', 'bin', 'foreman.mjs'))
  })

  it('links into the first folder and reports it', async () => {
    const { shim, system, linkDirs, pathDirs } = await setup()
    const opts = { shim, platform: 'linux' as const, linkDirs, pathDirs }
    expect(await cliStatus(opts)).toEqual({ installed: false, path: null })
    expect(await installCli(opts)).toEqual({ installed: true, path: path.join(system, 'foreman'), note: undefined })
    expect(await readlink(path.join(system, 'foreman'))).toBe(shim)
    expect(await cliStatus(opts)).toEqual({ installed: true, path: path.join(system, 'foreman') })
    // Again is fine.
    expect((await installCli(opts)).installed).toBe(true)
  })

  it('replaces an old link but not a file it did not make', async () => {
    const { dir, shim, system, linkDirs, pathDirs } = await setup()
    if (process.platform === 'win32') await mkdir(path.join(dir, 'old-app', 'foreman'), { recursive: true })
    await symlink(path.join(dir, 'old-app', 'foreman'), path.join(system, 'foreman'), process.platform === 'win32' ? 'junction' : 'file')
    await installCli({ shim, platform: 'linux', linkDirs, pathDirs })
    expect(await readlink(path.join(system, 'foreman'))).toBe(shim)

    const other = await setup()
    await writeFile(path.join(other.system, 'foreman'), 'someone else')
    await expect(installCli({ shim: other.shim, platform: 'linux', linkDirs: other.linkDirs, pathDirs: other.pathDirs })).rejects.toThrow("already exists and isn't Foreman's")
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('falls back to ~/.local/bin, or asks for a password on macOS', async () => {
    const { shim, system, user, linkDirs } = await setup()
    await chmod(system, 0o555)
    try {
      const linux = await installCli({ shim, platform: 'linux', linkDirs, pathDirs: async () => [system] })
      expect(linux).toEqual({ installed: true, path: path.join(user, 'foreman'), note: `${user} isn't on your PATH; add it in your shell profile.` })

      const commands: string[] = []
      const mac = await installCli({ shim, platform: 'darwin', linkDirs, runAsAdmin: async (c) => void commands.push(c) })
      expect(mac).toEqual({ installed: true, path: path.join(system, 'foreman') })
      expect(commands).toEqual([`mkdir -p '${system}' && ln -sfn '${shim}' '${path.join(system, 'foreman')}'`])

      await expect(installCli({ shim, platform: 'darwin', linkDirs, runAsAdmin: async () => Promise.reject(new Error('Installation was cancelled')) })).rejects.toThrow('cancelled')
    } finally {
      await chmod(system, 0o755)
    }
  })

  it('needs the packaged launcher on Windows', async () => {
    await expect(installCli({ shim: '/repo/bin/foreman.mjs', platform: 'win32' })).rejects.toThrow('npm link')
    const status = await cliStatus({ shim: 'C:\\Foreman\\resources\\cli\\foreman.cmd', platform: 'win32', pathDirs: async () => ['C:\\Foreman\\resources\\cli'] })
    expect(status.installed).toBe(process.platform === 'win32')
  })
})
