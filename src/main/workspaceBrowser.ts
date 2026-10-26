import { WebContentsView, session, type BrowserWindow } from 'electron'
import { browserBounds, browserUrl, isBrowserUrl, type BrowserCommand, type BrowserState } from '../shared/browser'
import { CANCEL_BROWSER_SELECTION, SELECT_BROWSER_ELEMENT } from './browserSelection'
import type { MainEvent } from '../shared/types'

const configuredSessions = new WeakSet<Electron.Session>()

type Entry = { view: WebContentsView; openUrl: string; selecting?: boolean; state: BrowserState; visible: boolean }

/** One isolated, lazily created page per workspace in a desktop window. Hidden pages retain their DOM. */
export class WorkspaceBrowser {
  private entries = new Map<string, Entry>()
  constructor(private win: BrowserWindow) {
    win.webContents.on('did-start-loading', () => this.dispose())
    win.on('closed', () => this.dispose())
  }

  private emit(workspaceId: string, entry: Entry) {
    if (this.entries.get(workspaceId) !== entry || this.win.isDestroyed()) return
    const wc = entry.view.webContents
    if (wc.isDestroyed()) return
    entry.state = { ...entry.state, url: wc.getURL() || entry.state.url, title: wc.getTitle(), loading: wc.isLoading(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() }
    this.win.webContents.send('foreman:event', { type: 'browser-state', workspaceId, state: entry.state } satisfies MainEvent)
  }

  private create(workspaceId: string, url: string): Entry {
    // No persist: prefix, no default session, no preload and no Foreman protocol handler.
    const ses = session.fromPartition(`foreman-browser:${this.win.id}:${workspaceId}`)
    if (!configuredSessions.has(ses)) {
      configuredSessions.add(ses)
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
      ses.setPermissionCheckHandler(() => false)
      ses.setDevicePermissionHandler(() => false)
      ses.on('will-download', (event) => event.preventDefault())
    }
    const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false } })
    const entry: Entry = { view, openUrl: url, visible: false, state: { url, title: '', loading: true, canGoBack: false, canGoForward: false } }
    this.entries.set(workspaceId, entry)
    view.setVisible(false)
    this.win.contentView.addChildView(view)
    const wc = view.webContents
    // A link requesting a new window reuses this workspace's one page; never launch an external protocol.
    wc.setWindowOpenHandler(({ url }) => {
      if (isBrowserUrl(url)) void this.navigate(workspaceId, entry, url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (event, target) => { if (!isBrowserUrl(target)) event.preventDefault() })
    wc.on('will-redirect', (event, target) => { if (!isBrowserUrl(target)) event.preventDefault() })
    wc.on('will-frame-navigate', event => { if (!isBrowserUrl(event.url) && event.url !== 'about:blank') event.preventDefault() })
    wc.on('will-attach-webview', event => event.preventDefault())
    wc.on('did-start-navigation', (_event, _url, _inPlace, main) => { if (main) entry.state.error = undefined })
    wc.on('did-fail-load', (_event, code, description, _url, main) => {
      if (!main || code === -3) return
      entry.state.error = description
      this.emit(workspaceId, entry)
    })
    wc.on('render-process-gone', (_event, details) => {
      entry.state.error = details.reason
      this.emit(workspaceId, entry)
    })
    const emit = () => this.emit(workspaceId, entry)
    wc.on('did-start-loading', emit)
    wc.on('did-stop-loading', emit)
    wc.on('did-navigate', emit)
    wc.on('did-navigate-in-page', emit)
    wc.on('page-title-updated', emit)
    wc.on('before-input-event', (event, input) => {
      const mod = process.platform === 'darwin' ? input.meta : input.control
      if (!mod || input.type !== 'keyDown' || input.alt) return
      if (input.key.toLowerCase() === 'r') { event.preventDefault(); wc.reload(); return }
      const action = input.key.toLowerCase() === 'l' ? 'address' : input.key.toLowerCase() === 'w' ? 'close' : null
      if (!action) return
      event.preventDefault()
      this.win.webContents.focus()
      this.win.webContents.send('foreman:event', { type: 'browser-shortcut', workspaceId, action } satisfies MainEvent)
    })
    return entry
  }

  private async navigate(workspaceId: string, entry: Entry, url: string) {
    this.cancelSelection(entry)
    entry.state.error = undefined
    entry.state.url = url
    try { await entry.view.webContents.loadURL(url) } catch (err) {
      if (this.entries.get(workspaceId) !== entry || entry.view.webContents.isDestroyed()) return
      if ((err as { code?: string }).code !== 'ERR_ABORTED') entry.state.error = (err as Error).message
    }
    this.emit(workspaceId, entry)
  }

  command(workspaceId: string, command: BrowserCommand): BrowserState | null {
    if (!command || typeof command !== 'object' || !['open', 'navigate', 'back', 'forward', 'reload', 'stop', 'close', 'focus', 'bounds', 'cancel-selection'].includes(command.type)) throw new Error('Invalid browser command')
    if (command.type === 'close') { this.close(workspaceId); return null }
    let entry = this.entries.get(workspaceId)
    if (command.type === 'open' || command.type === 'navigate') {
      const url = browserUrl(command.url)
      if (!entry) { entry = this.create(workspaceId, url); void this.navigate(workspaceId, entry, url) }
      else if (command.type === 'navigate' || entry.openUrl !== url) {
        if (command.type === 'open') entry.openUrl = url
        void this.navigate(workspaceId, entry, url)
      }
    } else if (entry) {
      const wc = entry.view.webContents
      switch (command.type) {
        case 'bounds': {
          const bounds = command.bounds && browserBounds(command.bounds, this.win.webContents.getZoomFactor(), this.win.getContentSize())
          if (bounds) {
            for (const other of this.entries.values()) if (other !== entry) { this.cancelSelection(other); other.view.setVisible(false); other.visible = false }
            entry.view.setBounds(bounds)
          }
          if (!bounds) {
            this.cancelSelection(entry)
            if (wc.isFocused()) this.win.webContents.focus()
          }
          entry.visible = Boolean(bounds)
          entry.view.setVisible(entry.visible)
          break
        }
        case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break
        case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break
        case 'reload': entry.state.error = undefined; wc.reload(); break
        case 'stop': wc.stop(); break
        case 'cancel-selection': this.cancelSelection(entry); break
        case 'focus': if (entry.visible) wc.focus(); break
        default: throw new Error('Unknown browser command')
      }
    }
    return entry?.state ?? null
  }

  private cancelSelection(entry: Entry) {
    if (!entry.selecting || entry.view.webContents.isDestroyed()) return
    void entry.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: CANCEL_BROWSER_SELECTION }]).catch(() => undefined)
  }

  async selectElement(workspaceId: string) {
    const entry = this.entries.get(workspaceId)
    if (!entry?.visible || entry.selecting) throw new Error('Open the browser before selecting an element')
    const wc = entry.view.webContents
    entry.selecting = true
    try {
      wc.focus()
      const selection = await wc.executeJavaScriptInIsolatedWorld(999, [{ code: SELECT_BROWSER_ELEMENT }]) as { selector: string; text: string } | null
      if (!selection || !entry.visible || this.entries.get(workspaceId) !== entry) return null
      return { url: wc.getURL(), selector: String(selection.selector).slice(0, 1000), text: String(selection.text).slice(0, 2000) }
    } catch {
      // Closing the page or navigating destroys its execution context and cancels the picker.
      return null
    } finally { entry.selecting = false }
  }

  async capture(workspaceId: string) {
    const entry = this.entries.get(workspaceId)
    if (!entry || !entry.visible) throw new Error('Open the browser before capturing a screenshot')
    const url = entry.view.webContents.getURL()
    const image = await entry.view.webContents.capturePage()
    if (image.isEmpty()) throw new Error('The browser has no page to capture')
    return { base64: image.toPNG().toString('base64'), url }
  }

  retain(workspaceIds: Set<string>) { for (const id of this.entries.keys()) if (!workspaceIds.has(id)) this.close(id) }
  close(workspaceId: string) {
    const entry = this.entries.get(workspaceId)
    if (!entry) return
    this.cancelSelection(entry)
    this.entries.delete(workspaceId)
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(entry.view)
    if (!entry.view.webContents.isDestroyed()) {
      if (!this.win.isDestroyed() && entry.view.webContents.isFocused()) this.win.webContents.focus()
      entry.view.webContents.close({ waitForBeforeUnload: false })
    }
  }
  dispose() { for (const id of this.entries.keys()) this.close(id) }
}
