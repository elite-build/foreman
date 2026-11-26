import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BROWSER_EXTENSION_ID, BROWSER_HOST_NAME } from '../src/shared/browserLink'
import { installBrowserHost } from '../src/main/browserHostInstall'
import { tempDir } from './helpers'

const ORIGIN = `chrome-extension://${BROWSER_EXTENSION_ID}/`

describe('browser host installer', () => {
  let root: string
  beforeEach(async () => {
    root = await tempDir('foreman-browser-host-')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('registers Chrome only on Linux, with a launcher that quotes a path containing a single quote', async () => {
    const home = path.join(root, 'home')
    await mkdir(path.join(home, '.config', 'google-chrome'), { recursive: true })
    const dataDir = path.join(root, 'data')
    const execPath = path.join(root, "O'Brien", 'foreman')
    const script = path.join(root, 'out', 'main', 'browserHost.js')

    const result = await installBrowserHost({
      dataDir,
      execPath,
      script,
      socket: path.join(dataDir, 'cli.sock'),
      tokenFile: path.join(dataDir, 'cli.token'),
      platform: 'linux',
      home,
      run: async () => {
        throw new Error('reg must not run on Linux')
      }
    })

    const launcher = path.join(dataDir, 'browser-host', 'foreman-browser-host.sh')
    const chromeManifest = path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts', `${BROWSER_HOST_NAME}.json`)
    expect(result.registered).toEqual([chromeManifest])
    expect(result.manifestPath).toBe(path.join(dataDir, 'browser-host', `${BROWSER_HOST_NAME}.json`))
    await expect(stat(path.join(home, '.config', 'chromium'))).rejects.toThrow()

    const manifest = JSON.parse(await readFile(chromeManifest, 'utf8')) as Record<string, unknown>
    expect(manifest).toEqual({
      name: BROWSER_HOST_NAME,
      description: 'Foreman for Chrome',
      path: launcher,
      type: 'stdio',
      allowed_origins: [ORIGIN]
    })

    const text = await readFile(launcher, 'utf8')
    expect(text.startsWith('#!/bin/sh\n')).toBe(true)
    expect(text).toContain(`export FOREMAN_BROWSER_SOCKET='${path.join(dataDir, 'cli.sock')}'`)
    expect(text).toContain(`exec '${execPath.replace(/'/g, `'\''`)}' '${script}' "$@"`)
    if (process.platform !== 'win32') expect((await stat(launcher)).mode & 0o777).toBe(0o755)
  })

  it('skips a browser that refuses and registers the rest on Windows', async () => {
    const dataDir = path.join(root, 'data')
    const calls: { command: string; args: string[] }[] = []
    const result = await installBrowserHost({
      dataDir,
      execPath: 'C:\Program Files\Foreman\Foreman.exe',
      script: 'C:\Program Files\Foreman\resources\out\main\browserHost.js',
      socket: '\\.\pipe\foreman-abc',
      tokenFile: 'C:\Users\me\foreman\cli.token',
      platform: 'win32',
      home: root,
      run: async (command, args) => {
        calls.push({ command, args })
        if (args[1].includes('Microsoft\\Edge')) throw new Error('reg refused')
      }
    })

    // Spelled out in full, so a lost backslash in the installer can't pass by being lost here too.
    const keys = [
      'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.foreman.browser',
      'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.foreman.browser',
      'HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.foreman.browser'
    ]
    expect(calls).toHaveLength(4)
    expect(calls.every((call) => call.command === 'reg')).toBe(true)
    expect(calls[0].args).toEqual(['add', keys[0], '/ve', '/t', 'REG_SZ', '/d', result.manifestPath, '/f'])
    expect(result.registered).toEqual([keys[0], keys[1], keys[2]])

    const launcher = await readFile(path.join(dataDir, 'browser-host', 'foreman-browser-host.cmd'), 'utf8')
    expect(launcher).toBe(
      [
        '@echo off',
        'set ELECTRON_RUN_AS_NODE=1',
        'set "FOREMAN_BROWSER_SOCKET=\\.\pipe\foreman-abc"',
        'set "FOREMAN_BROWSER_TOKEN_FILE=C:\Users\me\foreman\cli.token"',
        '"C:\Program Files\Foreman\Foreman.exe" "C:\Program Files\Foreman\resources\out\main\browserHost.js" %*',
        ''
      ].join('\r\n')
    )
  })
})
