// Downloads and installs a newer Foreman with electron-updater, for main/updates.ts. Only index.ts imports this (it needs
// Electron); the core sees the UpdateInstaller interface. The feed is the GitHub release's latest.yml / latest-mac.yml
// that electron-builder writes beside the installers (package.json build.publish), read from the app-update.yml it puts in
// the app's resources. Windows installs the NSIS installer; macOS installs the zip through Squirrel, which accepts only
// an update signed by the same Developer ID as the running app, so an ad-hoc signed build links to the release page.
import { app, autoUpdater as squirrel } from 'electron'
import electronUpdater from 'electron-updater'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { InstallUnavailable } from '../shared/appUpdate'
import type { UpdateInstaller } from './updates'

const { autoUpdater, CancellationToken } = electronUpdater

// How long Squirrel.Mac may take to stage a downloaded update.
const STAGE_TIMEOUT_MS = 5 * 60_000

/** The app's Developer ID team, or null for an ad-hoc or unsigned bundle (or when codesign can't say). */
function macTeam(bundle: string): Promise<string | null> {
  return new Promise((resolve) => {
    // codesign -dv prints to stderr: "TeamIdentifier=ABCDE12345", or "TeamIdentifier=not set" for an ad-hoc signature.
    execFile('/usr/bin/codesign', ['-dv', bundle], { timeout: 10_000 }, (err, _stdout, stderr) => {
      const team = /^TeamIdentifier=(.+)$/m.exec(String(stderr))?.[1]?.trim()
      resolve(!err && team && team !== 'not set' ? team : null)
    })
  })
}

/** Squirrel.Mac's own update-downloaded (staged, ready to install) or error, from before the download starts. */
function squirrelStaged(): { done: Promise<void>; dispose(): void } {
  let dispose = () => {}
  const done = new Promise<void>((resolve, reject) => {
    const ok = () => resolve()
    const fail = (err: Error) => reject(err)
    squirrel.once('update-downloaded', ok)
    squirrel.once('error', fail)
    // Squirrel unpacks and checks in seconds; one that never answers fails the download rather than hanging it.
    const timer = setTimeout(() => reject(new Error('Squirrel.Mac did not stage the update')), STAGE_TIMEOUT_MS)
    dispose = () => {
      clearTimeout(timer)
      squirrel.removeListener('update-downloaded', ok)
      squirrel.removeListener('error', fail)
    }
  })
  // Settled or not, a failed download shouldn't leave an unhandled rejection behind.
  done.catch(() => undefined)
  return { done, dispose: () => dispose() }
}

export interface ElectronUpdateInstaller extends UpdateInstaller {
  /** Install the downloaded update and start Foreman again. Call once Foreman has shut down its own work. */
  quitAndInstall(): void
}

export function electronUpdateInstaller(): ElectronUpdateInstaller {
  let token: InstanceType<typeof CancellationToken> | null = null
  let reason: Promise<InstallUnavailable | null> | null = null
  let progress: ((transferred: number, total: number) => void) | null = null

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowDowngrade = false
  // Its own log is chatty; failures reach updates.ts as rejected downloads.
  autoUpdater.logger = { info: () => undefined, warn: (m: unknown) => console.warn('Updater:', m), error: (m: unknown) => console.error('Updater:', m) }
  // An EventEmitter with no 'error' listener throws.
  autoUpdater.on('error', () => undefined)
  autoUpdater.on('download-progress', (p) => progress?.(p.transferred, p.total))

  const unavailable = async (): Promise<InstallUnavailable | null> => {
    if (!app.isPackaged) return 'development'
    if (process.platform !== 'win32' && process.platform !== 'darwin') return 'unsupported'
    if (!existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return 'unsupported'
    // Foreman.app/Contents/MacOS/Foreman → Foreman.app
    if (process.platform === 'darwin' && !(await macTeam(path.resolve(process.execPath, '../../..')))) return 'unsigned'
    return null
  }

  return {
    unavailable: () => (reason ??= unavailable()),
    async download(version, prerelease, onProgress) {
      autoUpdater.allowPrerelease = prerelease
      const found = await autoUpdater.checkForUpdates()
      // The feed must offer the release GitHub's API did: a release without update files (source only) or one that
      // moved on in between is a failed download, and the window offers the release page.
      if (!found?.isUpdateAvailable || found.updateInfo.version !== version) throw new Error(`The update feed doesn't offer ${version}`)
      token = new CancellationToken()
      progress = onProgress
      // On while downloading: electron-updater adds its install-at-quit hook (Windows), and has Squirrel stage the update
      // (macOS), only when this is on as the download ends. updates.ts then sets what the user chose. macOS installs a
      // staged update at the next quit either way.
      autoUpdater.autoInstallOnAppQuit = true
      // macOS: the download ends when Squirrel has fetched the zip; it is ready once Squirrel has checked its signature
      // against this app's and staged it. A mismatch (another signer) is Squirrel's error, so the download fails.
      const staged = process.platform === 'darwin' ? squirrelStaged() : null
      try {
        await autoUpdater.downloadUpdate(token)
        await staged?.done
      } finally {
        staged?.dispose()
        progress = null
        token = null
      }
    },
    cancel: () => token?.cancel(),
    installOnQuit: (on) => void (autoUpdater.autoInstallOnAppQuit = on),
    // Silent, then run Foreman again. On Windows this starts the installer, which waits for Foreman to exit.
    quitAndInstall: () => autoUpdater.quitAndInstall(true, true)
  }
}
