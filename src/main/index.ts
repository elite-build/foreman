import { ForemanDelegation } from './foremanDelegation'
import { ForemanCli } from './foremanCli'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor, powerSaveBlocker, protocol, safeStorage, shell, systemPreferences } from 'electron'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:net'
import { API_METHODS, SIGNAL_METHODS, type Api, type MainEvent, type Signals } from '../shared/types'
import { socketPath } from '../cli/protocol'
import { shimPath } from './cliInstall'
import { ensureCliToken, startCliServer, type CliHost } from './cliServer'
import { Core } from './core'
import { WorkspaceBrowser } from './workspaceBrowser'
import type { BrowserCommand } from '../shared/browser'
import { importLoginShellEnv } from './platform'
import { SecretStore } from './secrets'
import { allowPermission } from './speech/permissions'
import { Store } from './store'
import { MobileService } from './mobile'
import { captureConsoleErrors, errorLine, errorLog, rendererErrorLine } from './reportProblem'
import { launchPaths } from './dropFolders'
import { spawn } from 'node:child_process'
import { HOST_FLAG, hostArgs, hostDir } from './agentHost/protocol'
import { readHostBundle, type HostBundle } from './agentHost/sandboxPackage'
import { AppTray } from './tray'
import { LINK_SCHEME, linksIn } from '../shared/deepLink'
import type { TrayAction, TrayView } from '../shared/attention'
import { mainT, setSystemLanguages } from './i18n'
import { frameMayNavigate, PREVIEW_SCHEME } from '../shared/preview'
import { VISIBILITY_EVENTS, WindowVisibility } from './windowVisibility'
import { runScreens, screenshotRoot, SCREENSHOTS, screensSwitches, seedScreens } from './screenshots'

// The last few errors go into Report a problem's diagnostics (O20).
captureConsoleErrors()
// O13b: main's own text (menu, dialogs, tray, notifications) follows the OS's languages under System.
setSystemLanguages(() => [...app.getPreferredSystemLanguages(), app.getLocale()])

const here = path.dirname(fileURLToPath(import.meta.url))
const workspaceBrowsers = new Map<number, WorkspaceBrowser>()
let core: Core | null = null
let cliServer: Server | null = null
let mobile: MobileService | null = null

app.setName('Foreman')
// #19: the file viewer's sandboxed HTML/PDF previews load from foreman-preview:// (main/previewProtocol.ts).
// A standard, secure scheme so each workspace's previews are their own origin; registered before ready.
protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, stream: true } }])
// Dev-only screenshot run (FOREMAN_SCREENSHOTS=1, scripts/screenshots.mjs): a throwaway data folder and no network.
const screensRoot = SCREENSHOTS ? screenshotRoot() : null
if (screensRoot) screensSwitches((name, value) => app.commandLine.appendSwitch(name, value))
// Separate data folder for development and tests (SWITCHYARD_DATA_DIR is the older name).
const dataDirOverride = (screensRoot && path.join(screensRoot, 'data')) || process.env.FOREMAN_DATA_DIR || process.env.SWITCHYARD_DATA_DIR
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

// Listeners besides the window: the command-line server forwards long jobs' events as progress.
const eventListeners = new Set<(event: MainEvent) => void>()

function broadcast(event: MainEvent): void {
  if (event.type === 'state') {
    const live = new Set(event.snapshot.workspaces.filter((w) => w.state !== 'archived' && w.state !== 'history').map((w) => w.id))
    for (const browser of workspaceBrowsers.values()) browser.retain(live)
  }
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('foreman:event', event)
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
  const send = () => win.webContents.send('foreman:event', event)
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

function drawTray(): void {
  if (!core || screensRoot) return
  const settings = core.settings()
  const t = mainT(settings)
  appTray.update(trayView, { attention: settings.trayIcon !== false, phone: phoneTray(), t })
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
  win.webContents.on('render-process-gone', (_event, gone) => errorLog.record(errorLine([`[renderer] window process gone: ${gone.reason} (exit ${gone.exitCode})`])))
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
  if (!screensRoot && !app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  // A folder dropped on the taskbar button, shortcut or Dock icon while Foreman runs (O21).
  app.on('second-instance', (_event, argv, workingDirectory) => {
    receiveLaunchFolders(launchPaths(argv, { cwd: workingDirectory, skip: [app.getAppPath()] }))
    // #3: Windows hands a foreman:// link to the running app this way.
    for (const url of linksIn(argv)) receiveLink(url)
    showWindow()
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
  const store = new Store(app.getPath('userData'))
  await store.load()

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
    // O10: start Foreman again as the background agent host (detached, so it outlives this process).
    agentHost: {
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
  mobile = new MobileService({
    store, secrets, api: core.api, snapshot: () => core!.snapshot(),
    approvals: () => core!.sessions.pendingApprovals(),
    consentNeeded: (workspaceId) => core!.checks.consentNeeded(workspaceId),
    appPath: app.getAppPath(),
    onChanged: () => undefined, onEnabledChange: () => drawTray()
  })
  core.bindMobile(mobile)
  if (!screensRoot) await mobile.start()
  registerLinks()

  const api = core.api as unknown as Record<string, (...args: unknown[]) => unknown>
  const signals = core.signals as unknown as Record<string, (...args: unknown[]) => void>
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
  ipcMain.handle('foreman:invoke', (event, method: keyof Api, args: unknown[]) => {
    desktopSender(event)
    if (!API_METHODS.includes(method)) throw new Error('Unknown API method')
    const fn = api[method]
    if (typeof fn !== 'function') throw new Error(`Unknown method ${String(method)}`)
    return fn(...args)
  })
  ipcMain.on('foreman:send', (event, method: keyof Signals, args: unknown[]) => {
    if (!workspaceBrowsers.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame) return
    if (SIGNAL_METHODS.includes(method)) signals[method]?.(...args)
  })

  installMenu()
  const win = createWindow()
  // A screenshot run starts none of what follows (sockets, network, timers, schedules); it captures its screens and quits.
  if (screensRoot && fixture) {
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
  // Cloud workspaces: the turns their hosts kept running while Foreman was closed, taken back or ended at the session
  // cap. Over the network, so after the window is up and never ahead of the rest of launch.
  void core.cloudTurns.recover().catch((err: unknown) => console.error('Could not reconnect to cloud workspaces:', err))
  // #3: the first look is the baseline for history; it also draws the tray. Then open PRs every 60 s.
  core.attention.observe()
  // Phase 4: a screen reader starting or stopping flips terminals set to Automatic.
  app.on('accessibility-support-changed', () => core?.screenReaderChanged())
  // The flag can be stale when the reader was running before Foreman started: re-read it whenever a window gains focus.
  app.on('browser-window-focus', () => core?.screenReaderChanged())
  core.prPoll.start()
  for (const url of pendingLinks.splice(0)) receiveLink(url)
  const started = core
  // Integrations: check each connection soon after launch and then every six hours, so a revoked key shows up.
  setTimeout(() => void started.integrations.checkAll(), 8_000).unref()
  setInterval(() => void started.integrations.checkAll(), 6 * 60 * 60_000).unref()
  // A newer Foreman: asked once per start of an installed build, while Settings → General allows it. A development
  // build's version says nothing about the releases, so only Settings' "Check now" asks there.
  if (app.isPackaged) setTimeout(() => void started.updates.atStartup(), 5_000).unref()
  // Cloud workspaces: idle sleep every minute (nothing to do without one), and orphans stopped once if Settings say so.
  started.sandboxes.startIdleTicker()
  setTimeout(() => void started.sandboxes.stopOrphans().catch(() => undefined), 10_000).unref()
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
    armLimitResume: (sessionId, turnId) => started.limitResume.arm(sessionId, turnId),
    cancelLimitResume: (sessionId) => started.limitResume.cancel(sessionId),
    firstTurn: (workspaceId) => started.firstTurn(workspaceId),
    createWorkspace: (repoId, options) => started.api.createWorkspace(repoId, options),
    setupOutcome: (workspaceId) => started.setupOutcome(workspaceId),
    startHeldMessage: (workspaceId) => started.startHeldMessage(workspaceId),
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
    checkConsent: (workspaceId) => started.checks.consentNeeded(workspaceId)
  }
  // The assistant's Run button runs commands against the same host, in process.
  started.assistant.attachCli(cliHost)
  started.foremanMcp.cli = new ForemanCli(cliHost)
  const delegation = new ForemanDelegation(cliHost)
  started.assistant.delegation = delegation
  started.foremanMcp.delegation = delegation
  cliServer = await startCliServer(socketPath(app.getPath('userData')), cliHost).catch((err: unknown) => {
    // The app works without it; only the `foreman` command needs it.
    console.error('Could not start the command-line socket:', err)
    return null
  })
  void core.refreshAllDiffStats()
  core.prWatch.start()
  // #5: fix turns that were running when Foreman closed get their time cap back, or are settled from how they ended.
  void core.autoFix.resume().catch((err: unknown) => console.error('Auto-fix CI:', err))
  // #17: a review that was running when Foreman closed is stopped and says so (its turn is no longer unattended).
  void core.autoReview.resume().catch((err: unknown) => console.error('Auto review:', err))
  core.baseWatch.start()
  core.schedules.start()
  // #11: an armed usage-limit resume whose time came while Foreman was closed, or the computer asleep, asks instead of sending.
  const limitResume = core.limitResume
  limitResume.start()
  powerMonitor.on('resume', () => limitResume.woke())
  core.transfers.recover()
  void core.applyDeviceListening().catch((err: unknown) => console.error('Hand-offs:', err))
  void core.baseWatch.poll()
  core.data.start()
  core.gitBackup.start()
  core.applySettings()
  // #2: which commands "Teach agents Foreman" may mention depends on whether `foreman` is installed.
  void core.refreshCliInstalled()
  // Keep-awake cutoffs (O17) react at once to plugging in or out and to heat; a minute timer covers the rest.
  const powerChanged = () => started.powerChanged()
  powerMonitor.on('on-ac', powerChanged)
  powerMonitor.on('on-battery', powerChanged)
  if (process.platform === 'darwin') powerMonitor.on('thermal-state-change', powerChanged)
  void core.models.refreshAll()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

let quitting = false
// #1: the Quit sheet already said yes (Quit now, or the wait for turns ended), so quit without asking again.
let quitApproved = false

/** Closing the last window quits the app (not on macOS, nor on Windows while the tray keeps phone access up). */
function closingQuits(): boolean {
  return process.platform !== 'darwin' && !(appTray.shown && phoneTray())
}

/** #1: something is running, so the window shows the Quit sheet instead of quitting. */
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
  void Promise.all([core.shutdown(), mobile?.close(), core.bridge.close()]).finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (closingQuits()) app.quit()
})

// O10: started as the background agent host, Foreman runs only that (no window, no app state).
if (process.argv.includes(HOST_FLAG)) void import('./agentHost/electronHost').then((m) => m.runAgentHost())
else void main()
