// Registers Foreman's native-messaging host (src/cli/browserHostMain.ts) with every Chromium browser on the computer.
// Writes a launcher and the host's manifest into <dataDir>/browser-host/, then points each browser at the manifest:
// a registry key on Windows, a NativeMessagingHosts folder on macOS and Linux. Browsers that aren't installed are
// skipped, and a browser that refuses is skipped too; only a data folder that can't be written is an error.
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { BROWSER_EXTENSION_ID, BROWSER_HOST_NAME } from '../shared/browserLink'

const execFileAsync = promisify(execFile)

export type BrowserHostInstallOptions = {
  dataDir: string // Foreman's data folder; files go in <dataDir>/browser-host/
  execPath: string // the Electron binary (process.execPath)
  script: string // absolute path to out/main/browserHost.js
  socket: string // the CLI socket path
  tokenFile: string // the CLI token file
  platform?: NodeJS.Platform
  home?: string // os.homedir() by default
  run?: (command: string, args: string[]) => Promise<void> // execFile by default (for `reg`)
}

// Registry keys under HKCU, one per Chromium-based browser.
const WINDOWS_BROWSERS = ['Software\\Google\\Chrome', 'Software\\Microsoft\\Edge', 'Software\\BraveSoftware\\Brave-Browser', 'Software\\Chromium']

// macOS: folders under ~/Library/Application Support/.
const MAC_BROWSERS = ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome Canary', 'Microsoft Edge', 'BraveSoftware/Brave-Browser', 'Chromium']

// Linux: folders under ~/.config/.
const LINUX_BROWSERS = ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'microsoft-edge', 'BraveSoftware/Brave-Browser', 'chromium']

const defaultRun = async (command: string, args: string[]): Promise<void> => {
  await execFileAsync(command, args, { windowsHide: true })
}

/** A POSIX shell single-quoted word. */
function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`
}

function launcherWindows(options: BrowserHostInstallOptions): string {
  return [
    '@echo off',
    'set ELECTRON_RUN_AS_NODE=1',
    `set "FOREMAN_BROWSER_SOCKET=${options.socket}"`,
    `set "FOREMAN_BROWSER_TOKEN_FILE=${options.tokenFile}"`,
    `"${options.execPath}" "${options.script}" %*`,
    ''
  ].join('\r\n')
}

function launcherPosix(options: BrowserHostInstallOptions): string {
  return [
    '#!/bin/sh',
    'export ELECTRON_RUN_AS_NODE=1',
    `export FOREMAN_BROWSER_SOCKET=${shellWord(options.socket)}`,
    `export FOREMAN_BROWSER_TOKEN_FILE=${shellWord(options.tokenFile)}`,
    `exec ${shellWord(options.execPath)} ${shellWord(options.script)} "$@"`,
    ''
  ].join('\n')
}

/** Write `content` unless the file already holds exactly that. */
async function writeIfChanged(file: string, content: string): Promise<void> {
  const current = await readFile(file, 'utf8').catch(() => null)
  if (current !== content) await writeFile(file, content)
}

async function isFolder(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory()
  } catch {
    return false
  }
}

export async function installBrowserHost(options: BrowserHostInstallOptions): Promise<{ manifestPath: string; registered: string[] }> {
  const platform = options.platform ?? process.platform
  const home = options.home ?? os.homedir()
  const run = options.run ?? defaultRun
  const hostDir = path.join(options.dataDir, 'browser-host')
  const windows = platform === 'win32'

  // The data folder: failures here are real and propagate.
  await mkdir(hostDir, { recursive: true })
  const launcherPath = path.join(hostDir, windows ? 'foreman-browser-host.cmd' : 'foreman-browser-host.sh')
  await writeIfChanged(launcherPath, windows ? launcherWindows(options) : launcherPosix(options))
  if (!windows) await chmod(launcherPath, 0o755)

  const manifestPath = path.join(hostDir, `${BROWSER_HOST_NAME}.json`)
  const manifest = {
    name: BROWSER_HOST_NAME,
    description: 'Foreman for Chrome',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${BROWSER_EXTENSION_ID}/`]
  }
  await writeIfChanged(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const registered: string[] = []

  if (windows) {
    for (const base of WINDOWS_BROWSERS) {
      const key = `HKCU\\${base}\\NativeMessagingHosts\\${BROWSER_HOST_NAME}`
      try {
        await run('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'])
        registered.push(key)
      } catch {
        // This browser refused the key (or isn't there to read it): the others still count.
      }
    }
    return { manifestPath, registered }
  }

  const [base, names] = platform === 'darwin' ? [path.join(home, 'Library', 'Application Support'), MAC_BROWSERS] : [path.join(home, '.config'), LINUX_BROWSERS]
  for (const name of names) {
    const folder = path.join(base, name)
    // Only browsers with a profile folder on this computer: a missing browser gets no directory of ours.
    if (!(await isFolder(folder))) continue
    const target = path.join(folder, 'NativeMessagingHosts', `${BROWSER_HOST_NAME}.json`)
    try {
      await mkdir(path.dirname(target), { recursive: true })
      await writeIfChanged(target, `${JSON.stringify(manifest, null, 2)}\n`)
      registered.push(target)
    } catch {
      // This browser's folder isn't writable: the others still count.
    }
  }
  return { manifestPath, registered }
}
