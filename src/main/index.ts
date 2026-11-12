import { ForemanDelegation } from './foremanDelegation'
import { ForemanCli } from './foremanCli'
import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, powerSaveBlocker, protocol, safeStorage, shell, systemPreferences } from 'electron'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:net'
import { API_METHODS, SIGNAL_METHODS, type Api, type MainEvent, type Signals } from '../shared/types'
import { WINDOW_SESSION } from '../shared/api'
import { ApiDispatcher } from './api/dispatch'
import { socketPath } from '../cli/protocol'
import { shimPath } from './cliInstall'
import { ensureCliToken, startCliServer, type CliHost } from './cliServer'
import { resolveLoadout } from './cli/agents'
import { Core } from './core'
import { WorkspaceBrowser } from './workspaceBrowser'
import type { BrowserCommand } from '../shared/browser'
import { findOnPath, importLoginShellEnv } from './platform'
import { SecretStore } from './secrets'
import { allowPermission } from './speech/permissions'
import { Store } from './store'
import { MobileService } from './mobile'
import { AgentAccessService } from './agentAccess/server'
import { OutsideTools } from './agentAccess/tools'
import { captureConsoleErrors, errorLine, errorLog, osName, rendererErrorLine } from './reportProblem'
import { diag, installProcessHandlers } from './diagnosticsLog'
import { buildDiagnostics } from './diagnostics'
import { heapSnapshotMain, heapSnapshotRenderer, MAX_PROFILE_MS, MIN_PROFILE_MS, profileFileName, profileMain, profileRenderer } from './profiler'
import { launchPaths } from './dropFolders'
import { spawn } from 'node:child_process'
import { HOST_FLAG, hostArgs, hostDir } from './agentHost/protocol'
import { readHostBundle, type HostBundle } from './agentHost/sandboxPackage'
import { AppTray } from './tray'
import { parseHeadless, quitsWhenWindowsClose, trayWanted, type HeadlessFacts } from './headless'
import { installNotes, launchArgs, parseDataDir, parseService, readRelaunchNote, RELAUNCH_FILE, relaunchNote, restartArgs, SERVICE_FLAG, serviceLaunch, ServiceManager, serviceUpdateDue, systemServiceDeps, type ServiceFacts } from './service'
import { commitTrial, endTrial, failTrial, parseRetry, readOutcome, RETRY_FLAG, startTrial, takeSnapshot, TRIAL_TIMEOUT_MS, type UpdateTrial } from './serviceUpdate'
import { LINK_SCHEME, linksIn } from '../shared/deepLink'
import type { TrayAction, TrayView } from '../shared/attention'
import { mainT, setSystemLanguages } from './i18n'
import { frameMayNavigate, PREVIEW_SCHEME } from '../shared/preview'
import { VISIBILITY_EVENTS, WindowVisibility } from './windowVisibility'
import { blockNetwork, runScreens, screenshotRoot, SCREENSHOTS, screensSwitches, seedScreens } from './screenshots'
import { claimDemoFolder, DEMO, demoDataDir, DEMO_RESET, demoFolder, seedDemo } from './demo'
import { registerDemoAgents, startDemoRun } from './demoRun'
import { configureReplay } from './agents/fixtures/replayDriver'
import { perf } from './perf'
import { RemoteRouter, type WindowRoute } from './remote/router'
import { electronUpdateInstaller, type ElectronUpdateInstaller } from './updateInstaller'

// The last few errors go into Report a problem's diagnostics (O20), and every one into the event log (docs/telemetry.md).
captureConsoleErrors(errorLog, (line) => diag.log('error', { line }))
// An uncaught exception or unhandled rejection in main is recorded with its stack before Electron's dialog shows.
installProcessHandlers(process)
// O13b: main's own text (menu, dialogs, tray, notifications) follows the OS's languages under System.
setSystemLanguages(() => [...app.getPreferredSystemLanguages(), app.getLocale()])

const here = path.dirname(fileURLToPath(import.meta.url))
const workspaceBrowsers = new Map<number, WorkspaceBrowser>()
let core: Core | null = null
// Other computers (shared/remote.ts): where the window's calls and this computer's events go while it shows another one.
let router: RemoteRouter | null = null
// Events for the window once it has loaded again (it switched computers).
const afterLoad: MainEvent[] = []
let cliServer: Server | null = null
let mobile: MobileService | null = null
let agentAccess: AgentAccessService | null = null

app.setName('Foreman')
// #19: the file viewer's sandboxed HTML/PDF previews load from foreman-preview:// (main/previewProtocol.ts).
// A standard, secure scheme so each workspace's previews are their own origin; registered before ready.
protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, stream: true } }])
// Dev-only screenshot run (FOREMAN_SCREENSHOTS=1, scripts/screenshots.mjs): a throwaway data folder and no network.
const screensRoot = SCREENSHOTS ? screenshotRoot() : null
if (screensRoot) screensSwitches((name, value) => app.commandLine.appendSwitch(name, value))
// Started with --headless (docs/server.md, "Headless"): every service runs and no window opens until one is asked for
// (the tray, a foreman:// link, `foreman run --open`, starting Foreman again). A screenshot run needs its window.
let headless = !screensRoot && parseHeadless(process.argv)
// Started by the background service (service.ts, `foreman service install`): headless, never quits when a window closes,
// and installs a downloaded update by itself. Also true when the service started again while this one ran, or when an
// update this one installed brought it back (the installer starts Foreman with no arguments; see takeRelaunchNote).
let service = !screensRoot && parseService(process.argv)
// Chromium reads --headless as its own headless mode and passes it to the GPU process, where no window Foreman opens
// later could ever show. The flag is Foreman's; take it off Chromium's command line before anything starts.
if (parseHeadless(process.argv)) app.commandLine.removeSwitch('headless')
// Dev-only demo (`npm run dev demo`, main/demo.ts): the screenshot fixture in a data folder kept between launches, and
// no network. The folder is claimed (or reset) here, before Electron opens files in it; it is seeded once ready.
const demoRoot = DEMO && !screensRoot && !app.isPackaged ? demoFolder(app.getPath('appData')) : null
let demoSeed = false
if (demoRoot) {
  try {
    demoSeed = claimDemoFolder(demoRoot, DEMO_RESET) === 'seed'
  } catch (err) {
    console.error(`[demo] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  blockNetwork((name, value) => app.commandLine.appendSwitch(name, value))
  // Agents answer from a script (main/demoRun.ts), so the demo's flow run moves with no model behind it.
  registerDemoAgents({ replayRoot: app.getAppPath() })
  console.log(`[demo] ${demoSeed ? 'Seeding' : 'Using'} the demo data in ${demoRoot}`)
}
// Separate data folder for development and tests (SWITCHYARD_DATA_DIR is the older name). --data-dir= is how the background
// service starts a Foreman installed from one with its own folder, as Task Scheduler can't set environment variables.
const ownDataDir = parseDataDir(process.argv) || process.env.FOREMAN_DATA_DIR || process.env.SWITCHYARD_DATA_DIR
const dataDirOverride = (screensRoot && path.join(screensRoot, 'data')) || (demoRoot && demoDataDir(demoRoot)) || ownDataDir
if (dataDirOverride) app.setPath('userData', dataDirOverride)

/**
 * The app used to be called Switchyard. On first run as Foreman, bring its
 * repositories, workspaces and chats across from the old data folder.
 */
function migrateFromSwitchyard(): void {
  if (dataDirOverride) return
  const target = app.getPath('userData')
  const source = path.join(app.getPath('appData'), 'Switchyard')
  if (path.resolve(source).toLowerCase() === path.resolve(target).toLowerCase()) return
  if (existsSync(path.join(target, 'state.json')) || !existsSync(path.join(source, 'state.json'))) return
  mkdirSync(target, { recursive: true })
  for (const entry of ['state.json', 'sessions', 'logs', 'Local Storage', 'secrets.bin']) {
    const from = path.join(source, entry)
    if (existsSync(from)) cpSync(from, path.join(target, entry), { recursive: true })
  }
}

// Listeners besides the window: the command-line server forwards long jobs' events as progress, and the phone and browser
// sockets (api/socket.ts) send each session what its view lets through.
const eventListeners = new Set<(event: MainEvent) => void>()

function broadcast(event: MainEvent): void {
  // Every event the window is sent, by type (`event.chat-append`, `event.state`): docs/telemetry.md.
  perf.count(`event.${event.type}`)
  if (event.type === 'state') {
    const live = new Set(event.snapshot.workspaces.filter((w) => w.state !== 'archived' && w.state !== 'history').map((w) => w.id))
    for (const browser of workspaceBrowsers.values()) browser.retain(live)
  }
  const route: WindowRoute = router ? router.toWindow(event) : { send: event }
  if ('leave' in route) void core?.remote.view(null, route.leave.workspaceId ? { workspaceId: route.leave.workspaceId, sessionId: route.leave.sessionId } : undefined)
  else if ('send' in route) for (const win of BrowserWindow.getAllWindows()) win.webContents.send('foreman:event', route.send)
  for (const listener of eventListeners) {
    try {
      listener(event)
    } catch (err) {
      console.error('Event listener failed:', err)
    }
  }
  if (event.type === 'notify') mobile?.notify(event)
}

/** Send an event to the window, once its page has loaded (a window opened just now hears nothing before). */
function sendToWindow(event: MainEvent): void {
  const win = showWindow()
  const route: WindowRoute = router ? router.toWindow(event) : { send: event }
  if ('leave' in route) return void core?.remote.view(null, route.leave.workspaceId ? { workspaceId: route.leave.workspaceId, sessionId: route.leave.sessionId } : undefined)
  if (!('send' in route)) return
  const send = () => win.webContents.send('foreman:event', route.send)
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
}

// #3: one tray (Windows) or menu-bar extra (macOS): attention, plus phone access on Windows.
const appTray = new AppTray({ act: trayAction, show: () => showWindow() })
let trayView: TrayView = { count: 0, attention: [], working: [] }

// The tray and menu read only the settings, straight from the store: never a whole snapshot, which reads repository
// folders and every service's view, and the tray is drawn on every attention pass.

/** Phone access keeps Windows' tray up (and the app running when the window closes), as it always did. */
function phoneTray(): boolean {
  const settings = core?.settings()
  return process.platform === 'win32' && Boolean(settings?.mobileEnabled || settings?.mobileLanEnabled)
}

/** What decides whether Foreman runs on with no window (headless.ts). */
function headlessFacts(): HeadlessFacts {
  const settings = core?.settings()
  return { platform: process.platform, headless, service, keepRunning: Boolean(settings?.keepRunning), phoneAccess: Boolean(settings?.mobileEnabled || settings?.mobileLanEnabled) }
}

function drawTray(): void {
  if (!core || screensRoot) return
  const settings = core.settings()
  const t = mainT(settings)
  // With no window wanted the tray stays up even with Settings → General → Tray icon off: it is the way back and the way to quit.
  appTray.update(trayView, { attention: settings.trayIcon !== false, phone: phoneTray(), keep: trayWanted(headlessFacts()), t })
}

/** A tray entry: show the window, then go where it says. Never answers or sends anything. */
function trayAction(action: TrayAction): void {
  if (action.kind === 'quit') return app.quit()
  if (action.kind === 'show') return void showWindow()
  if (action.kind === 'home') return sendToWindow({ type: 'navigate' })
  if (action.kind === 'open') return sendToWindow({ type: 'navigate', workspaceId: action.workspaceId, sessionId: action.sessionId })
  const next = core?.attention.view().attention[0]
  sendToWindow(next ? { type: 'navigate', workspaceId: next.workspaceId, sessionId: next.sessionId } : { type: 'navigate' })
}

// #3: foreman:// links that came before the window could take them.
const pendingLinks: string[] = []

/** A foreman:// link (Dock, browser, another app): the window routes it; navigation only. */
function receiveLink(url: string): void {
  if (!/^foreman:\/\//i.test(url)) return
  if (!core || !app.isReady()) {
    pendingLinks.push(url)
    return
  }
  sendToWindow({ type: 'open-link', url })
}

/** Make Foreman the app for foreman:// links. Not for test runs with their own data folder. */
function registerLinks(): void {
  if (dataDirOverride) return
  // Run from source, the OS has to start Electron with the app's folder.
  const ok =
    app.isPackaged || !process.defaultApp
      ? app.setAsDefaultProtocolClient(LINK_SCHEME)
      : app.setAsDefaultProtocolClient(LINK_SCHEME, process.execPath, [path.resolve(process.argv[1] ?? app.getAppPath())])
  if (!ok) console.error('Could not register foreman:// links.')
}

// O21: folders from a launch's command line that came before Core existed.
const pendingLaunchFolders: string[] = []

/** Folders named at launch go to the window's Add repository confirmation; nothing is added here. */
function receiveLaunchFolders(paths: string[]): void {
  if (!paths.length) return
  if (core) core.addLaunchFolders(paths)
  else pendingLaunchFolders.push(...paths)
}

function showWindow(): BrowserWindow {
  const win = BrowserWindow.getAllWindows()[0] ?? createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  // Asked for from a terminal, so the app isn't the active one yet.
  if (process.platform === 'darwin') app.focus({ steal: true })
  win.focus()
  return win
}

function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

// The default menu binds Cmd/Ctrl+R to reload, which the app uses for Run.
// Built again when the Language setting changes; roles name themselves.
function installMenu(): void {
  const isMac = process.platform === 'darwin'
  const t = mainT(core?.settings())
  // No ⌘W/Ctrl+W accelerators: the app uses them to close chat tabs.
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : [{ label: t('menu.file'), submenu: [{ role: 'quit' as const }] }]),
    { role: 'editMenu' },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.reload'), click: () => BrowserWindow.getFocusedWindow()?.webContents.reload() },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { label: t('menu.window'), submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])] },
    {
      role: 'help',
      label: t('menu.help'),
      submenu: [
        { label: t('tour.label'), click: () => showWindow().webContents.send('foreman:event', { type: 'tour' } satisfies MainEvent) },
        { type: 'separator' },
        // Opens the dialog (O20); nothing is sent from it.
        { label: t('report.command'), click: () => showWindow().webContents.send('foreman:event', { type: 'report-problem' } satisfies MainEvent) }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Windows and Linux show the window's own icon in the title bar. A packaged Windows build takes
 *  it from the .exe; run from source, the window needs it or Electron's icon shows. */
function windowIcon(): string | undefined {
  if (process.platform === 'darwin' || app.isPackaged) return undefined
  return path.join(app.getAppPath(), 'build', process.platform === 'win32' ? 'icon-dev.ico' : 'icon-dev.png')
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f0d0c' : '#ffffff',
    title: 'Foreman',
    icon: windowIcon(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Agents keep working while the window is in the background; so must timers (autosave, polling). The page hears
      // when it is minimized or hidden instead (window-visibility below) and stops drawing.
      backgroundThrottling: false
    }
  })

  // A screenshot run captures a window it may never show, so its page always counts as visible.
  if (!screensRoot) {
    const visibility = new WindowVisibility(win, (visible) => {
      if (!win.webContents.isDestroyed()) win.webContents.send('foreman:event', { type: 'window-visibility', visible } satisfies MainEvent)
    })
    for (const name of VISIBILITY_EVENTS) win.on(name as 'show', () => visibility.update())
    win.webContents.on('did-finish-load', () => visibility.loaded())
  }

  workspaceBrowsers.set(win.webContents.id, new WorkspaceBrowser(win))
  const contentsId = win.webContents.id
  // Other computers: what the window is told once it has loaded again after switching (where to go, or why it came back).
  win.webContents.on('did-finish-load', () => {
    for (const event of afterLoad.splice(0)) win.webContents.send('foreman:event', event)
  })
  // Electron grants every permission request when nothing handles it. The only change here is the microphone
  // (speech to text): audio alone, from this window's own page. Camera and screen capture requests are refused.
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowPermission(permission, details as { mediaTypes?: ('video' | 'audio')[]; isMainFrame?: boolean }, workspaceBrowsers.has(contents.id)))
  })
  win.on('closed', () => workspaceBrowsers.delete(contentsId))

  // The Windows taskbar groups windows by app id and draws that app's icon, which run from source
  // is electron.exe's. A separate id plus a relaunch icon makes it draw Foreman's instead.
  const icon = windowIcon()
  if (process.platform === 'win32' && icon) {
    win.setAppDetails({
      appId: 'dev.foreman.app.dev',
      appIconPath: icon,
      relaunchCommand: `"${process.execPath}" "${app.getAppPath()}"`,
      relaunchDisplayName: 'Foreman (dev)'
    })
  }

  // Links open in the system browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    if (isExternalUrl(url)) void shell.openExternal(url)
  })
  // #19: a frame (a file preview) may only move between previews and the PDF viewer's own pages; a link to the web
  // inside a previewed page goes nowhere (its CSP can't stop navigation).
  win.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && !frameMayNavigate(event.url)) event.preventDefault()
  })

  // Terminals belong to the page that draws them. After a reload or a closed window nobody can see or
  // stop them, so they end, and their tabs come back as restored ones (O3) rather than running unseen.
  win.webContents.on('did-start-loading', () => core?.ptys.killAll())
  // G4 O20: the window's errors go into Report a problem's log too, not only main's.
  win.webContents.on('console-message', (details) => {
    const line = rendererErrorLine(details)
    if (line) errorLog.record(line)
  })
  win.webContents.on('render-process-gone', (_event, gone) => {
    errorLog.record(errorLine([`[renderer] window process gone: ${gone.reason} (exit ${gone.exitCode})`]))
    diag.log('renderer.gone', { reason: gone.reason, exitCode: gone.exitCode })
  })
  // The page stopped answering (a long render, an endless loop), and when it came back: evidence for a hang report.
  win.on('unresponsive', () => diag.log('window.unresponsive'))
  win.on('responsive', () => diag.log('window.responsive'))
  win.on('closed', () => core?.ptys.killAll())
  // #1: where the close button quits the app, it asks first while something is running, as Quit does.
  win.on('close', (event) => {
    if (quitting || quitApproved || !core || !closingQuits() || BrowserWindow.getAllWindows().length > 1) return
    if (!core.stopSafely.needsAsking()) return
    event.preventDefault()
    askToQuit()
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(here, '../renderer/index.html'))
  return win
}

async function main(): Promise<void> {
  // A second instance would corrupt the state file; focus the first one instead. A screenshot run has its own data folder.
  // Whether this one was started headless goes with the request: the running one can't read it from the command line, which
  // no longer has the switch (see removeSwitch above).
  if (!screensRoot && !app.requestSingleInstanceLock({ headless: parseHeadless(process.argv), service: parseService(process.argv) })) {
    app.quit()
    return
  }
  // Brought back by an update the service's Foreman installed: the service's again, with a window only if one was open.
  const relaunch = !screensRoot && !demoRoot ? takeRelaunchNote() : null
  if (relaunch) {
    service = true
    headless = headless || !relaunch.window
  }
  // An update the service's Foreman installed is on trial until this version serves (serviceUpdate.ts): the data an
  // earlier try left half done goes back first, and a version that failed every try puts it back and stops here.
  if (!screensRoot && !demoRoot) {
    try {
      const { step, trial } = startTrial(app.getPath('userData'), { version: app.getVersion(), human: !service && !parseRetry(process.argv), now: Date.now() })
      if (step.action === 'stop') {
        console.error(`Foreman ${app.getVersion()} didn’t start after its update ${step.outcome.tries} times; the data is back as ${step.outcome.from} left it.`)
        return app.exit(0)
      }
      if (trial) {
        trialRun = trial
        trialWatchdog = setTimeout(() => failTry(new Error(`It hadn’t started serving after ${TRIAL_TIMEOUT_MS / 60_000} minutes.`)), TRIAL_TIMEOUT_MS)
      }
    } catch (err) {
      // Opening data an update may have half changed is worse than not starting.
      console.error('Could not put the data back after a failed update; Foreman won’t open it:', err)
      return app.exit(1)
    }
    const last = readOutcome(app.getPath('userData'))
    rolledBackVersion = last?.outcome === 'rolled-back' ? last.to : undefined
  }
  // A folder dropped on the taskbar button, shortcut or Dock icon while Foreman runs (O21).
  app.on('second-instance', (_event, argv, workingDirectory, data) => {
    receiveLaunchFolders(launchPaths(argv, { cwd: workingDirectory, skip: [app.getAppPath()] }))
    // #3: Windows hands a foreman:// link to the running app this way.
    for (const url of linksIn(argv)) receiveLink(url)
    // Starting it again headless (a login item, a script) leaves it as it is; anything else brings the window. The
    // service starting at login while Foreman was already open makes this one the service's.
    const asked = data as { headless?: unknown; service?: unknown } | null
    if (asked?.service === true && !demoRoot) {
      service = true
      drawTray()
    }
    if (!asked?.headless) showWindow()
  })
  // #3: macOS hands foreman:// links over as open-url, at launch too (before ready).
  app.on('open-url', (event, url) => {
    event.preventDefault()
    receiveLink(url)
  })
  // macOS hands a folder dropped on the Dock icon over as open-file (see CFBundleDocumentTypes).
  app.on('open-file', (event, file) => {
    event.preventDefault()
    receiveLaunchFolders([file])
    if (app.isReady()) showWindow()
  })
  receiveLaunchFolders(launchPaths(process.argv, { cwd: process.cwd(), skip: [app.getAppPath()] }))
  // #3: a link that started Foreman (Windows: on the command line).
  pendingLinks.push(...linksIn(process.argv))

  await app.whenReady()
  await importLoginShellEnv()
  // powerSaveBlocker id while agents keep the computer awake.
  let blocker: number | null = null
  migrateFromSwitchyard()
  // Show the development icon in the Dock so it is distinct from an installed build.
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(path.join(app.getAppPath(), 'build', 'icon-dev.png'))
  // Same id as the shortcut the Windows installer makes (build.appId), so taskbar pins and
  // notifications show Foreman's name and icon instead of Electron's.
  if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId('dev.foreman.app')
  const fixture = screensRoot ? await seedScreens(screensRoot, app.getPath('userData')) : null
  // The demo shows every screen the screenshots do, Flows included, with the computer's own shell in its terminals.
  // A seeding that fails says why and quits; the next launch starts it again.
  if (demoRoot && demoSeed) {
    try {
      await seedDemo(demoRoot, (root, dataDir) => seedScreens(root, dataDir, { flows: true, terminalShell: 'auto' }))
    } catch (err) {
      console.error(`[demo] Could not seed the demo data: ${err instanceof Error ? err.message : String(err)}`)
      return app.exit(1)
    }
  }
  const store = new Store(app.getPath('userData'))
  // Diagnostics (docs/telemetry.md, "Evidence"): the event log, the performance samples file and local crash dumps,
  // on while Settings → Experimental → Keep diagnostics is on (core.applySettings). Nothing is uploaded: the crash
  // reporter only writes minidumps into the data folder. A screenshot run keeps none of it.
  const logsDir = path.join(app.getPath('userData'), 'logs')
  const startedAt = Date.now()
  let crashReporting = false
  const applyDiagnostics = (on: boolean): void => {
    if (screensRoot) return
    if (!on) {
      if (diag.file) diag.log('diagnostics.off')
      diag.close()
      perf.stopRecording()
      return
    }
    if (!crashReporting) {
      crashReporting = true
      try {
        crashReporter.start({ uploadToServer: false, submitURL: '', compress: false })
      } catch (err) {
        console.error('Could not start the crash reporter:', err)
      }
    }
    if (!diag.file) {
      void diag.open(path.join(logsDir, 'foreman.log')).then(
        () => diag.log('app.start', { version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node }),
        (err: unknown) => console.error('Could not open foreman.log:', err)
      )
    }
    if (!perf.recording) void perf.record(path.join(logsDir, 'perf.jsonl')).catch((err: unknown) => console.error('Could not open perf.jsonl:', err))
  }
  const diagnosticsBundle = () =>
    buildDiagnostics({
      app: {
        version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, arch: process.arch, os: osName(),
        electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node
      },
      settings: store.state.settings,
      workspaces: store.state.workspaces,
      sessions: store.state.sessions,
      perf,
      events: diag,
      errors: errorLog,
      logsDir,
      crashDumpsDir: crashReporting ? app.getPath('crashDumps') : undefined,
      resourceUsage: () => core!.api.resourceUsage(),
      redact: { home: os.homedir(), user: os.userInfo().username },
      startedAt
    })
  // The window's DevTools session, for a renderer profile or heap snapshot (profiler.ts).
  const rendererDebugger = () => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win) throw new Error('No window is open to profile.')
    return win.webContents.debugger
  }
  await store.load()
  // Development builds only: Settings → Experimental → Replay recorded traffic (agents/fixtures/replayDriver.ts). A packaged
  // build never configures it, so the setting does nothing there. The demo has already turned it on for its chats.
  if (!app.isPackaged && !demoRoot) configureReplay({ enabled: () => store.state.settings.replayTraffic, root: app.getAppPath(), notice: () => mainT(store.state.settings)('replay.notice') })

  const secrets = new SecretStore(path.join(app.getPath('userData'), 'secrets.bin'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data)
  })
  secrets.load()

  // Drives prefers-color-scheme in the page and the native title bar and dialogs.
  nativeTheme.themeSource = store.state.settings.theme
  core = new Core(store, secrets, {
    broadcast,
    // Other computers: the window starts over from the computer it now shows; that computer's events go straight to it.
    reloadWindow: () => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.reload()
    },
    afterReload: (event) => void afterLoad.push(event),
    showRemoteEvent: (event) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('foreman:event', event)
    },
    applyTheme: (theme) => {
      nativeTheme.themeSource = theme
    },
    // O13b: the menu and tray in the new language (notifications and dialogs look it up each time).
    applyLanguage: () => {
      installMenu()
      drawTray()
    },
    pickDirectory: async () => {
      const win = BrowserWindow.getFocusedWindow() ?? undefined
      const options = { properties: ['openDirectory' as const], title: mainT(store.state.settings)('dialog.addRepository.title') }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    pickFiles: async () => {
      const win = BrowserWindow.getFocusedWindow() ?? undefined
      const options = { properties: ['openFile' as const, 'multiSelections' as const], title: mainT(store.state.settings)('dialog.attachFiles.title') }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return result.canceled ? [] : result.filePaths
    },
    pickPath: async ({ title, kind, defaultPath }) => {
      const win = BrowserWindow.getFocusedWindow() ?? undefined
      if (kind === 'save') {
        const saveOptions = { title, defaultPath }
        const saved = win ? await dialog.showSaveDialog(win, saveOptions) : await dialog.showSaveDialog(saveOptions)
        return saved.canceled ? null : (saved.filePath ?? null)
      }
      const options = {
        title,
        defaultPath,
        properties: [kind === 'directory' ? ('openDirectory' as const) : ('openFile' as const), 'showHiddenFiles' as const]
      }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    openPath: async (target) => {
      const error = await shell.openPath(target)
      if (error) throw new Error(error)
    },
    revealPath: (target) => shell.showItemInFolder(target),
    // G4 #14: Open menus show each app's own icon.
    fileIcon: async (target) => {
      const icon = await app.getFileIcon(target, { size: 'normal' })
      return icon.isEmpty() ? null : icon.toDataURL()
    },
    shrinkImage: async (bytes, pixels) => {
      const image = nativeImage.createFromBuffer(bytes)
      if (image.isEmpty()) return null
      const { width, height } = image.getSize()
      const scale = Math.min(1, pixels / Math.max(width, height))
      return (scale < 1 ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' }) : image).toDataURL()
    },
    openExternal: (url) => shell.openExternal(url),
    setZoom: (level) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.setZoomFactor(level)
    },
    keepAwake: (on) => {
      if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
      else if (!on && blocker !== null) {
        powerSaveBlocker.stop(blocker)
        blocker = null
      }
    },
    // O17. Thermal state is macOS-only in Electron (elsewhere it just says "unknown"), so it's null there.
    power: () => ({
      onBattery: powerMonitor.isOnBatteryPower(),
      thermal: process.platform === 'darwin' ? powerMonitor.getCurrentThermalState() : null
    }),
    metrics: () => {
      const all = app.getAppMetrics()
      return {
        cpuPercent: Math.round(all.reduce((n, m) => n + m.cpu.percentCPUUsage, 0)),
        memoryMb: Math.round(all.reduce((n, m) => n + m.memory.workingSetSize, 0) / 1024)
      }
    },
    applyDiagnostics,
    diagnosticsBundle,
    cliShim: () => shimPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
    // Integrations and Foreman's own tools: the MCP bridge is this app's own binary in Node mode running the bundled
    // bridge (bridge.js: only the bridge, not the whole CLI, as one runs per agent turn), by absolute path, so it needs
    // neither the installed `foreman` command nor anything on the agent's PATH.
    bridgeLaunch: () => {
      const script = path.join(app.getAppPath(), 'out', 'main', 'bridge.js')
      return existsSync(script) || app.isPackaged ? { command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } } : null
    },
    cliSocket: () => (cliServer ? socketPath(app.getPath('userData')) : null),
    away: () => ['idle', 'locked'].includes(powerMonitor.getSystemIdleState(300)),
    screenReader: () => app.accessibilitySupportEnabled,
    // Speech to text. macOS asks once (and answers false for good if it was refused); Windows has a privacy switch we can read.
    microphone: async () => {
      if (process.platform === 'darwin') return systemPreferences.askForMediaAccess('microphone')
      if (process.platform === 'win32') return systemPreferences.getMediaAccessStatus('microphone') !== 'denied'
      return true
    },
    // The speech helper is this app's own binary in Node mode running the built script (like bridgeLaunch).
    sttHelper: () => {
      const script = path.join(app.getAppPath(), 'out', 'main', 'sttHelper.js')
      return existsSync(script) || app.isPackaged ? { command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } } : null
    },
    appInfo: () => ({ version: app.getVersion(), packaged: app.isPackaged, appPath: app.getAppPath() }),
    quit: () => {
      quitApproved = true
      app.quit()
    },
    updateInstaller: (updateInstaller = electronUpdateInstaller()),
    // The update card's Restart: the usual shutdown, then the installer instead of a plain exit (see before-quit).
    restartToUpdate: () => {
      quitApproved = true
      installUpdate = true
      app.quit()
    },
    // O10: start Foreman again as the background agent host (detached, so it outlives this process). Not in the demo:
    // its turns stay here, with the scripted agents.
    agentHost: demoRoot ? undefined : {
      dir: hostDir(app.getPath('userData')),
      spawn: () => {
        const env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        const args = [...(app.isPackaged ? [] : [app.getAppPath()]), ...hostArgs(hostDir(app.getPath('userData')))]
        spawn(process.execPath, args, { detached: true, stdio: 'ignore', env, windowsHide: true }).unref()
      }
    },
    setBadge: (count) => {
      // Windows has no numeric dock badge; macOS and Linux do.
      if (process.platform !== 'win32') app.setBadgeCount(count)
    },
    showAttention: (view) => {
      trayView = view
      drawTray()
    }
  })
  core.ensureChats()
  // #19: the previews' files, answered only from the workspace's own worktree (main/previewProtocol.ts).
  protocol.handle(PREVIEW_SCHEME, (request) => core!.preview.handle(request.url, request.method))
  // O10: take back the turns the background host kept running while Foreman was closed.
  await core.agentHost.recover().catch((err: unknown) => console.error('Could not reconnect to the agent host:', err))
  // Cloud workspaces: the agent host files uploaded to sandboxes (built next to this file).
  let hostBundle: HostBundle | null | undefined
  core.sandboxes.hostBundle = () => (hostBundle === undefined ? (hostBundle = readHostBundle(here, app.getVersion())) : hostBundle)
  core.addLaunchFolders(pendingLaunchFolders.splice(0))
  const api = core.api as unknown as Record<string, (...args: unknown[]) => unknown>
  const signals = core.signals as unknown as Record<string, (...args: unknown[]) => void>
  // The dispatcher phones and browsers call through with their device's session; the window has its own (below).
  const dispatcher = new ApiDispatcher({ api, signals })
  mobile = new MobileService({
    // The same 3 s reuse of repository files as the window's snapshot: the phone's stall check runs every minute.
    store, secrets, dispatcher, snapshot: () => core!.snapshot({ maxAgeMs: 3000 }),
    approvals: () => core!.sessions.pendingApprovals(),
    consentNeeded: (workspaceId) => core!.checks.consentNeeded(workspaceId),
    appPath: app.getAppPath(),
    onChanged: () => undefined, onEnabledChange: () => drawTray(),
    // The phone sockets hear every broadcast, as the command line does, and filter it by each session's view.
    onEvent: (listener) => {
      eventListeners.add(listener)
      return () => void eventListeners.delete(listener)
    },
    version: app.getVersion(), platform: process.platform, name: () => core!.devices.self().name
  })
  core.bindMobile(mobile)
  if (!screensRoot && !demoRoot) await mobile.start()
  // Agents on this computer (docs/agent-access.md): a loopback listener of its own, never the phone's.
  // Revoking a sign-in drops what its tree queued (docs/agent-access.md §4).
  // Its changes reach every window, phone and browser, and a sign-in that starts waiting raises a notification.
  agentAccess = new AgentAccessService({ store, secrets, onChanged: () => core?.agentAccessChanged(), onRevoked: (grantId) => core?.agentGrantRevoked(grantId) })
  core.bindAgentAccess(agentAccess)
  if (!screensRoot && !demoRoot) await agentAccess.start()
  registerLinks()

  // Only the trusted desktop main frame can call any privileged IPC channel.
  const desktopSender = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
    const browser = workspaceBrowsers.get(event.sender.id)
    if (!browser || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted IPC sender')
    return browser
  }
  const browserSender = (event: Electron.IpcMainInvokeEvent, workspaceId: string) => {
    const browser = desktopSender(event)
    // From the store: a whole snapshot per browser command (bounds, while the panel moves) would read repository folders.
    const ws = store.state.workspaces.find((w) => w.id === workspaceId)
    if (!ws || ws.state === 'archived' || ws.state === 'history') throw new Error('Workspace is not available')
    return browser
  }
  ipcMain.handle('foreman:browser', (event, workspaceId: string, command: BrowserCommand) => browserSender(event, workspaceId).command(workspaceId, command))
  ipcMain.handle('foreman:browser-select', (event, workspaceId: string) => browserSender(event, workspaceId).selectElement(workspaceId))
  ipcMain.handle('foreman:browser-capture', (event, workspaceId: string) => browserSender(event, workspaceId).capture(workspaceId))
  const routed = core
  // The window's own calls and signals reach the core through the dispatcher with the window's session, which holds
  // every scope; the router decides first whether they go to another computer instead.
  // Not timed there: the handler below times every window call as `ipc.<method>`, the ones routed to another computer too.
  const windowDispatcher = new ApiDispatcher({ api, signals, perfPrefix: () => null })
  const windowApi = Object.fromEntries(API_METHODS.map((m) => [m, (...args: unknown[]) => windowDispatcher.invoke(WINDOW_SESSION, m, args)]))
  const windowSignals = Object.fromEntries(SIGNAL_METHODS.map((m) => [m, (...args: unknown[]) => windowDispatcher.signal(WINDOW_SESSION, m, args)]))
  router = new RemoteRouter({
    remote: routed.remote,
    local: windowApi,
    localSignals: windowSignals,
    selfName: () => routed.devices.self().name,
    readFile: (file) => readFile(file),
    t: () => mainT(routed.settings())
  })
  const routes = router
  ipcMain.handle('foreman:invoke', (event, method: keyof Api, args: unknown[]) => {
    desktopSender(event)
    if (!API_METHODS.includes(method)) throw new Error('Unknown API method')
    const fn = api[method]
    if (typeof fn !== 'function') throw new Error(`Unknown method ${String(method)}`)
    // Every call from the window, by method, with how long main took to answer (`ipc.getDiff`, `ipc.gitStatus`).
    // While the window shows another computer, most go there (remote/router.ts).
    return perf.timed(`ipc.${method}`, () => routes.invoke(method, args))
  })
  ipcMain.on('foreman:send', (event, method: keyof Signals, args: unknown[]) => {
    if (!workspaceBrowsers.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame) return
    if (SIGNAL_METHODS.includes(method)) routes.signal(method, args)
  })

  // The menu needs no window (macOS shows it with none); headless, the first window is made when something asks for it.
  installMenu()
  const win = headless ? null : createWindow()
  // A screenshot run starts none of what follows (sockets, network, timers, schedules); it captures its screens and quits.
  if (screensRoot && fixture && win) {
    const screensCore = core
    return void runScreens({
      win,
      core: screensCore,
      fixture,
      page: process.env.ELECTRON_RENDERER_URL ? { url: process.env.ELECTRON_RENDERER_URL } : { file: path.join(here, '../renderer/index.html') },
      out: process.env.FOREMAN_SCREENSHOTS_OUT || path.join(screensRoot, 'out'),
      // Its data is thrown away: stop terminals and agents, then exit without the Quit sheet's checks. A shutdown that
      // hangs doesn't hold the run.
      done: (failed) => {
        const stopped = Promise.race([screensCore.shutdown(), new Promise((resolve) => setTimeout(resolve, 5000))])
        void stopped.finally(() => app.exit(failed ? 1 : 0))
      }
    })
  }
  // The demo starts nothing that reaches another service: GitHub's pull requests, integrations, cloud sandboxes, paired
  // computers and phones, the agents' model lists.
  const online = !demoRoot
  // Cloud workspaces: the turns their hosts kept running while Foreman was closed, taken back or ended at the session
  // cap. Over the network, so after the window is up and never ahead of the rest of launch.
  if (online) void core.cloudTurns.recover().catch((err: unknown) => console.error('Could not reconnect to cloud workspaces:', err))
  // #3: the first look is the baseline for history; it also draws the tray. Then open PRs every 60 s.
  core.attention.observe()
  // Phase 4: a screen reader starting or stopping flips terminals set to Automatic.
  app.on('accessibility-support-changed', () => core?.screenReaderChanged())
  // The flag can be stale when the reader was running before Foreman started: re-read it whenever a window gains focus.
  app.on('browser-window-focus', () => core?.screenReaderChanged())
  if (online) core.prPoll.start()
  for (const url of pendingLinks.splice(0)) receiveLink(url)
  const started = core
  // Integrations: check each connection soon after launch and then every six hours, so a revoked key shows up.
  if (online) {
    setTimeout(() => void started.integrations.checkAll(), 8_000).unref()
    setInterval(() => void started.integrations.checkAll(), 6 * 60 * 60_000).unref()
  }
  // A newer Foreman: an installed build asks soon after start, then on Settings → General → Updates' schedule and when the
  // computer wakes. A development build's version says nothing about the releases, so only Settings' "Check now" asks there.
  if (app.isPackaged) {
    setTimeout(() => void started.updates.start(), 5_000).unref()
    powerMonitor.on('resume', () => started.updates.woke())
    // The service's Foreman installs a downloaded update by itself once nobody is using it (service.ts): no window open and
    // nothing Quit would ask about. A window's update card decides otherwise. Restarting writes the relaunch note. The data
    // is copied aside first, for the new version's trial (serviceUpdate.ts); without a copy there is no update.
    let heldUntil = 0
    setInterval(() => {
      const readyVersion = started.updates.readyVersion()
      if (Date.now() < heldUntil || !readyVersion) return
      if (!serviceUpdateDue({ service, readyVersion, windows: visibleWindows(), busy: started.stopSafely.needsAsking(), failedVersion: rolledBackVersion })) return
      const dataDir = app.getPath('userData')
      try {
        store.flush()
        takeSnapshot(dataDir, { from: app.getVersion(), to: readyVersion, now: Date.now(), copyDb: (file) => store.db.backupTo(file) })
      } catch (err) {
        heldUntil = Date.now() + 60 * 60_000
        return console.error('Could not copy the data aside before installing the Foreman update; trying again in an hour:', err)
      }
      void started.api.restartToUpdate(false).catch((err: unknown) => {
        endTrial(dataDir)
        console.error('Could not restart to install the Foreman update:', err)
      })
    }, 60_000).unref()
  }
  // Cloud workspaces: idle sleep every minute (nothing to do without one), and orphans stopped once if Settings say so.
  if (online) {
    started.sandboxes.startIdleTicker()
    setTimeout(() => void started.sandboxes.stopOrphans().catch(() => undefined), 10_000).unref()
  }
  // The command's launch token, in the data folder for the launcher to read back. If it can't be written, the app still serves, with a token nothing can present.
  const cliToken = await ensureCliToken(app.getPath('userData')).catch((err: unknown) => {
    console.error('Could not write the command-line token:', err)
    return randomBytes(32).toString('hex')
  })
  const cliHost: CliHost = {
    api: started.api,
    snapshot: () => started.snapshot(),
    resolvedRepoSettings: (repoId) => started.workspaces.resolvedSettings(repoId),
    platform: process.platform,
    onEvent: (listener) => {
      eventListeners.add(listener)
      return () => void eventListeners.delete(listener)
    },
    appInfo: () => ({ version: app.getVersion(), packaged: app.isPackaged, dataDir: app.getPath('userData') }),
    cliToken: () => cliToken,
    state: () => store.state,
    approvals: () => started.sessions.pendingApprovals(),
    turnStatus: (turnId) => started.sessions.turnStatus(turnId),
    deliver: (sessionId, text, options) => started.sessions.deliver(sessionId, text, options),
    cancelTurn: (turnId) => started.sessions.cancelTurn(turnId),
    lendSlot: (sessionId) => started.sessions.lendSlot(sessionId),
    armLimitResume: (sessionId, turnId, cap) => started.limitResume.arm(sessionId, turnId, cap),
    cancelLimitResume: (sessionId) => started.limitResume.cancel(sessionId),
    firstTurn: (workspaceId) => started.firstTurn(workspaceId),
    createWorkspace: (repoId, options, extra) => started.createWorkspaceFor(repoId, options, extra),
    startFlowRun: async (input, origin) => started.startFlowRunFrom(input, origin),
    setupOutcome: (workspaceId) => started.setupOutcome(workspaceId),
    startHeldMessage: (workspaceId, cap) => started.startHeldMessage(workspaceId, cap),
    // docs/agent-access.md §4: a capped turn's `foreman` command starts what it starts under that turn's cap.
    capped: (cap) => started.cappedApi(cap),
    runChecks: (workspaceId) => started.checks.runForCli(workspaceId),
    exportInfo: (workspaceId) => started.portability.exportInfo(workspaceId),
    exportWorkspace: (workspaceId, options) => started.portability.exportWorkspace(workspaceId, options),
    stageImport: (file, passphrase) => started.portability.stage(file, passphrase),
    importStaged: (stageId, choice) => started.portability.importStaged(stageId, choice),
    discardImport: (stageId) => started.portability.discard(stageId),
    identifyCaller: (caller) => started.agentReports.identify(caller),
    recordReport: (input) => started.agentReports.record(input),
    agentsMayStart: (repoId) => started.agentReports.mayStart(repoId),
    // Integrations: an agent's `foreman mcp-bridge` connection.
    bridge: (conn, params, rest) => params?.service === 'app'
      ? started.foremanMcp.attach(conn, params, rest)
      : started.bridge.attach(conn, params, rest),
    // A window opened just now (macOS keeps running with none) hears events once its page loads.
    reveal: (workspaceId) => sendToWindow({ type: 'show-workspace', workspaceId }),
    showSetting: (id) => sendToWindow({ type: 'show-setting', id }),
    checkConsent: (workspaceId) => started.checks.consentNeeded(workspaceId),
    // `foreman app perf`: the meter's report, and a fresh start for its counters when asked.
    perf: ({ reset } = {}) => {
      const report = perf.report()
      if (reset) perf.reset()
      return report
    },
    // `foreman app diagnostics`, `app profile` and `app heap` (docs/telemetry.md, "Evidence"). Profiles and snapshots
    // go into the data folder's logs, as V8 files DevTools opens.
    diagnostics: () => diagnosticsBundle(),
    profile: async ({ target, seconds }) => {
      const ms = Math.min(MAX_PROFILE_MS, Math.max(MIN_PROFILE_MS, Math.round(seconds * 1000)))
      diag.log('profile.start', { target, ms })
      const profile = target === 'renderer' ? await profileRenderer(rendererDebugger(), ms) : await profileMain(ms)
      await mkdir(logsDir, { recursive: true })
      const file = path.join(logsDir, profileFileName(target, 'cpuprofile'))
      await writeFile(file, JSON.stringify(profile))
      diag.log('profile.end', { target, file })
      return { file, ms }
    },
    heapSnapshot: async ({ target }) => {
      await mkdir(logsDir, { recursive: true })
      const file = path.join(logsDir, profileFileName(target, 'heapsnapshot'))
      if (target === 'renderer') await heapSnapshotRenderer(rendererDebugger(), file)
      else heapSnapshotMain(file)
      diag.log('heap.snapshot', { target, file })
      return { file }
    },
    // `foreman service`: not in the demo, whose data folder and scripted agents a login item mustn't start.
    service: demoRoot ? undefined : serviceHost(started)
  }
  // The assistant's Run button runs commands against the same host, in process.
  started.assistant.attachCli(cliHost)
  started.foremanMcp.cli = new ForemanCli(cliHost)
  const delegation = new ForemanDelegation(cliHost)
  started.assistant.delegation = delegation
  started.foremanMcp.delegation = delegation
  // Agents on this computer call the same tools over the loopback endpoint (docs/agent-access.md §7).
  const outside = agentAccess
  outside?.setMcpHandler(new OutsideTools({
    grant: (id) => outside.grant(id),
    delegation,
    actions: started.foremanActions,
    approvals: () => started.sessions.pendingApprovals(),
    session: (id) => store.state.sessions.find((s) => s.id === id),
    workspace: (id) => store.state.workspaces.find((w) => w.id === id),
    answerQuestion: (id, response, name) => started.answerAsOutside(id, response, name),
    flowsOn: () => Boolean(store.state.settings.flows),
    schedules: {
      snapshot: () => cliHost.snapshot(),
      listFlows: (repoId) => started.api.listFlows(repoId),
      // The model checked as `foreman schedules add --model` checks it.
      claudeModel: (model) => resolveLoadout(cliHost, { agent: 'claude', model }).loadout.model,
      propose: (input, by) => started.proposeSchedule(input, by)
    }
  }).handle)
  cliServer = await startCliServer(socketPath(app.getPath('userData')), cliHost).catch((err: unknown) => {
    // The app works without it; only the `foreman` command needs it.
    console.error('Could not start the command-line socket:', err)
    return null
  })
  // An update on trial has opened the data and is serving: it stays, and the copy of the data goes (serviceUpdate.ts).
  // Before schedules, flows and the rest start writing, which putting the data back would lose.
  if (trialRun) {
    const trial = trialRun
    trialRun = undefined
    if (trialWatchdog) clearTimeout(trialWatchdog)
    try {
      commitTrial(app.getPath('userData'), trial, Date.now())
    } catch (err) {
      console.error('Could not finish the update’s trial:', err)
    }
  }
  void core.refreshAllDiffStats()
  if (online) core.prWatch.start()
  // #5: fix turns that were running when Foreman closed get their time cap back, or are settled from how they ended.
  void core.autoFix.resume().catch((err: unknown) => console.error('Auto-fix CI:', err))
  // #17: a review that was running when Foreman closed is stopped and says so (its turn is no longer unattended).
  void core.autoReview.resume().catch((err: unknown) => console.error('Auto review:', err))
  core.baseWatch.start()
  core.schedules.start()
  // Flow runs that were in flight when Foreman closed are uncertain, never retried.
  core.flows.start()
  // The demo: a flow run going from the start (main/demoRun.ts).
  if (demoRoot) void startDemoRun(core, store).catch((err: unknown) => console.error(`[demo] Could not start the demo's flow run: ${err instanceof Error ? err.message : String(err)}`))
  // Deletes auto-archived workspaces past Settings → Git's cleanup window (off unless chosen).
  core.autoArchive.start()
  // #11: an armed usage-limit resume whose time came while Foreman was closed, or the computer asleep, asks instead of sending.
  const limitResume = core.limitResume
  limitResume.start()
  powerMonitor.on('resume', () => limitResume.woke())
  core.transfers.recover()
  if (online) {
    void core.applyDeviceListening().catch((err: unknown) => console.error('Hand-offs:', err))
    // Other computers: background links to the paired ones, for the computer chip and their alerts.
    core.startComputers()
    void core.baseWatch.poll()
  }
  core.data.start()
  core.gitBackup.start()
  core.applySettings()
  // Icons for repositories added before Foreman picked them, one at a time in the background.
  core.findMissingRepoIcons()
  // #2: which commands "Teach agents Foreman" may mention depends on whether `foreman` is installed.
  void core.refreshCliInstalled()
  // Keep-awake cutoffs (O17) react at once to plugging in or out and to heat; a minute timer covers the rest.
  const powerChanged = () => started.powerChanged()
  powerMonitor.on('on-ac', powerChanged)
  powerMonitor.on('on-battery', powerChanged)
  if (process.platform === 'darwin') powerMonitor.on('thermal-state-change', powerChanged)
  if (online) void core.models.refreshAll()
  // The performance meter's samples (docs/telemetry.md): the app's processes every few seconds, written to perf.jsonl
  // while Keep diagnostics is on (applyDiagnostics). A screenshot run measures nothing.
  if (!screensRoot) {
    perf.start({
      processes: () => app.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, cpuPercent: Math.round(m.cpu.percentCPUUsage * 10) / 10, memoryMb: Math.round(m.memory.workingSetSize / 1024) })),
      // The stall watchdog: a main-thread stall, with what ran during it, goes to the event log.
      onStall: (stall) => diag.log('stall', { ...stall })
    })
    // A GPU, utility or other helper process that crashed or was killed.
    app.on('child-process-gone', (_event, details) => diag.log('process.gone', { type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name, serviceName: details.serviceName }))
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

let quitting = false
// #1: the Quit sheet already said yes (Quit now, or the wait for turns ended), so quit without asking again.
let quitApproved = false
// Downloads and installs updates (main/updates.ts decides when). Made in main(): the background agent host has none.
let updateInstaller: ElectronUpdateInstaller | undefined
// The update card's Restart: once shut down, run the installer, which starts Foreman again.
let installUpdate = false
// The update this start is trying (serviceUpdate.ts), until it serves; and what ends the try if it hangs.
let trialRun: UpdateTrial | undefined
let trialWatchdog: NodeJS.Timeout | undefined
// A version whose update was rolled back here: the service doesn't install it by itself again.
let rolledBackVersion: string | undefined

/** Windows someone could be looking at. */
function visibleWindows(): number {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible()).length
}

/** What the background service is made from (service.ts): this Foreman as it was started, and this computer. */
function serviceFacts(): ServiceFacts {
  const env = process.env
  return {
    platform: process.platform,
    home: os.homedir(),
    execPath: process.execPath,
    appPath: app.getAppPath(),
    packaged: app.isPackaged,
    appImage: env.APPIMAGE,
    dataDir: ownDataDir ? path.resolve(ownDataDir) : undefined,
    configHome: env.XDG_CONFIG_HOME,
    display: { DISPLAY: env.DISPLAY, WAYLAND_DISPLAY: env.WAYLAND_DISPLAY, XAUTHORITY: env.XAUTHORITY },
    xvfbRun: process.platform === 'linux' ? findOnPath('xvfb-run') : null,
    user: env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${env.USERNAME}` : os.userInfo().username,
    tempDir: os.tmpdir()
  }
}

/** `foreman service` (cli/service.ts): install, remove and describe the background service for this Foreman. */
function serviceHost(started: Core): CliHost['service'] {
  const manager = new ServiceManager({ facts: serviceFacts(), ...systemServiceDeps() })
  return {
    status: () => manager.status(),
    install: () => manager.install(),
    uninstall: () => manager.uninstall(),
    get startedByService() {
      return service
    },
    canUpdate: () => !started.updates.view().installUnavailable,
    notes: () => installNotes(serviceFacts()),
    pid: process.pid,
    busy: () => started.stopSafely.needsAsking(),
    windowOpen: () => visibleWindows() > 0,
    // After the reply has gone: Quit without asking (the command checked, or was forced), and Electron starts the
    // service's Foreman once this one has exited, past the single-instance lock.
    restart: (window) => {
      const launch = serviceLaunch(serviceFacts())
      setTimeout(() => {
        app.relaunch({ execPath: launch.command, args: restartArgs(launch, window) })
        quitApproved = true
        app.quit()
      }, 250)
    },
    lastUpdate: () => readOutcome(app.getPath('userData'))
  }
}

/**
 * The update on trial failed in this process (it threw while starting, or hung): note why, and start Foreman again with
 * RETRY_FLAG, which puts the data back before trying again or stopping (serviceUpdate.ts). Exits at once: a shutdown
 * would write more into data that is about to be replaced.
 */
function failTry(err: unknown): void {
  const trial = trialRun
  if (!trial) return
  trialRun = undefined
  console.error(`Foreman ${app.getVersion()} didn’t start after its update:`, err)
  try {
    failTrial(app.getPath('userData'), trial, err instanceof Error ? err.message : String(err))
  } catch (noted) {
    console.error('Could not note why:', noted)
  }
  const flags = [...(headless ? ['--headless'] : []), ...(service ? [SERVICE_FLAG] : []), RETRY_FLAG]
  app.relaunch({ execPath: serviceLaunch(serviceFacts()).command, args: launchArgs(serviceFacts(), flags) })
  app.exit(1)
}

/** Just before the installer runs: how the new version should start, read once by takeRelaunchNote. */
function writeRelaunchNote(version: string, window: boolean): void {
  try {
    writeFileSync(path.join(app.getPath('userData'), RELAUNCH_FILE), relaunchNote(version, window))
  } catch (err) {
    console.error('Could not note how Foreman should start after the update:', err)
  }
}

/** At startup: the note an update left, if it is for this version and recent. Read once; the file goes either way. */
function takeRelaunchNote(): ReturnType<typeof readRelaunchNote> {
  const file = path.join(app.getPath('userData'), RELAUNCH_FILE)
  if (!existsSync(file)) return null
  let text: string | null = null
  try {
    text = readFileSync(file, 'utf8')
    rmSync(file, { force: true })
  } catch {
    // Unreadable: start as if there were none.
  }
  return readRelaunchNote(text, app.getVersion())
}

/**
 * Closing the last window quits the app unless something wants it to stay (headless.ts: macOS, --headless, Keep running
 * without a window, phone access on Windows). Off macOS it stays only behind a tray icon: one that couldn't be made
 * would leave Foreman running with no way back to it but starting it again.
 */
function closingQuits(): boolean {
  return quitsWhenWindowsClose(headlessFacts()) || (process.platform !== 'darwin' && !appTray.shown)
}

/**
 * #1: something is running, so the window shows the Quit sheet instead of quitting. With no window (headless, or the
 * last one closed), Quit from the tray opens one to ask: the person who asked to quit sees the question.
 */
function askToQuit(): void {
  const win = showWindow()
  const send = () => win.webContents.send('foreman:event', { type: 'quit-requested' } satisfies MainEvent)
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
}

app.on('before-quit', (event) => {
  if (quitting || !core) return
  event.preventDefault()
  // #1: with turns, check runs or run scripts going, ask first. With nothing running, quit at once as before.
  if (!quitApproved && core.stopSafely.needsAsking()) return askToQuit()
  quitting = true
  // What's still running is recorded for Home's "Review and retry…"; shutdown then stops it (turns end as Stopped).
  core.stopSafely.recordQuit()
  // Stop agents and terminals and flush state before exiting.
  cliServer?.close()
  perf.stop()
  diag.log('app.quit')
  // The service's Foreman comes back after the update as it was: in the background, with a window only if one is open now.
  const updating = installUpdate && service ? core.updates.readyVersion() : undefined
  const windowOpen = visibleWindows() > 0
  void Promise.all([core.shutdown(), mobile?.close(), agentAccess?.close(), core.bridge.close(), perf.flushed(), diag.flushed()]).finally(() => {
    if (!installUpdate || !updateInstaller) return app.quit()
    if (updating) writeRelaunchNote(updating, windowOpen)
    // electron-updater quits once the installer is under way. When it can't start one it only reports an error, so
    // quit anyway rather than leave a stopped app open; the update stays downloaded for the next try.
    setTimeout(() => app.quit(), 10_000).unref()
    try {
      updateInstaller.quitAndInstall()
    } catch (err) {
      console.error('Could not install the Foreman update:', err)
      app.quit()
    }
  })
})

app.on('window-all-closed', () => {
  if (closingQuits()) app.quit()
})

// O10: started as the background agent host, Foreman runs only that (no window, no app state).
if (process.argv.includes(HOST_FLAG)) void import('./agentHost/electronHost').then((m) => m.runAgentHost())
else
  void main().catch((err: unknown) => {
    // A start that fails while an update is on trial puts the data back (failTry); any other failure is as it was.
    if (trialRun) return failTry(err)
    throw err
  })
