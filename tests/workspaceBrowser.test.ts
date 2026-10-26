import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserBounds, browserUrl, isBrowserUrl } from '../src/shared/browser'

const fake = vi.hoisted(() => ({ views: [] as any[], sessions: [] as any[] }))
vi.mock('electron', () => ({
  session: { fromPartition: vi.fn((partition) => {
    const ses = new EventEmitter() as any
    ses.partition = partition
    ses.setPermissionRequestHandler = vi.fn()
    ses.setPermissionCheckHandler = vi.fn()
    ses.setDevicePermissionHandler = vi.fn()
    fake.sessions.push(ses)
    return ses
  }) },
  WebContentsView: class {
    webContents: any
    setVisible = vi.fn()
    setBounds = vi.fn()
    constructor(public options: any) {
      const wc = new EventEmitter() as any
      wc.getURL = () => wc.url ?? ''
      wc.getTitle = () => 'Page'
      wc.isLoading = () => false
      wc.isDestroyed = () => Boolean(wc.destroyed)
      wc.setWindowOpenHandler = vi.fn()
      wc.loadURL = vi.fn(async (url) => { wc.url = url })
      wc.navigationHistory = { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() }
      wc.reload = vi.fn()
      wc.stop = vi.fn()
      wc.focus = vi.fn()
      wc.isFocused = () => false
      wc.close = vi.fn(() => { wc.destroyed = true })
      wc.capturePage = vi.fn(async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('png') }))
      this.webContents = wc
      fake.views.push(this)
    }
  }
}))
import { WorkspaceBrowser } from '../src/main/workspaceBrowser'

function window() {
  const win = new EventEmitter() as any
  win.id = 1
  win.webContents = new EventEmitter()
  win.webContents.getZoomFactor = () => 2
  win.webContents.send = vi.fn()
  win.webContents.focus = vi.fn()
  win.getContentSize = () => [1000, 800]
  win.contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
  win.isDestroyed = () => false
  return win
}
beforeEach(() => { fake.views.length = 0; fake.sessions.length = 0 })

describe('browser boundaries', () => {
  it('accepts web addresses and local ports but refuses executable, file and credential URLs', () => {
    expect(browserUrl('localhost:50230/pricing')).toBe('http://localhost:50230/pricing')
    expect(browserUrl('example.com')).toBe('https://example.com/')
    expect(browserUrl('http://[::1]:50230')).toBe('http://[::1]:50230/')
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'foreman://workspace/a/b', 'http://user:secret@example.com', '', 'https://']) expect(() => browserUrl(url)).toThrow()
    expect(isBrowserUrl('localhost:50230')).toBe(false)
    expect(isBrowserUrl('https://example.com')).toBe(true)
  })
  it('converts zoom and clips native bounds to the window, rejecting malformed sizes', () => {
    expect(browserBounds({ x: 10, y: 20, width: 100, height: 200 }, 2, [1000, 800])).toEqual({ x: 20, y: 40, width: 200, height: 400 })
    expect(browserBounds({ x: 400, y: 300, width: 300, height: 300 }, 2, [1000, 800])).toEqual({ x: 800, y: 600, width: 200, height: 200 })
    expect(browserBounds({ x: 0, y: 0, width: NaN, height: 20 }, 1, [1000, 800])).toBeNull()
  })
})

describe('workspace browser lifecycle', () => {
  it('creates pages lazily, preserves DOM on hide/show and isolates workspace sessions', () => {
    const manager = new WorkspaceBrowser(window())
    manager.command('one', { type: 'bounds', bounds: null })
    expect(fake.views).toHaveLength(0)
    manager.command('one', { type: 'open', url: 'http://localhost:50230/' })
    const view = fake.views[0]
    expect(view.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true })
    expect(view.options.webPreferences.preload).toBeUndefined()
    const bounds = { x: 0, y: 0, width: 200, height: 200 }
    manager.command('one', { type: 'bounds', bounds })
    view.webContents.isFocused = () => true
    manager.command('one', { type: 'bounds', bounds: null })
    manager.command('one', { type: 'open', url: 'http://localhost:50230/' })
    manager.command('one', { type: 'bounds', bounds })
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1)
    manager.command('two', { type: 'open', url: 'https://example.com' })
    manager.command('two', { type: 'bounds', bounds })
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
    expect(fake.sessions[0].partition).not.toEqual(fake.sessions[1].partition)
    expect(fake.sessions.every(s => !s.partition.startsWith('persist:'))).toBe(true)
  })
  it('repeated preview actions focus the existing page without resetting its current route', async () => {
    const manager = new WorkspaceBrowser(window())
    manager.command('one', { type: 'open', url: 'http://localhost:50230/' })
    const wc = fake.views[0].webContents
    await wc.loadURL('http://localhost:50230/form')
    wc.emit('did-navigate')
    manager.command('one', { type: 'open', url: 'http://localhost:50230/' })
    expect(wc.loadURL).toHaveBeenCalledTimes(2)
    expect(wc.getURL()).toBe('http://localhost:50230/form')
    manager.command('one', { type: 'open', url: 'http://localhost:50231/' })
    expect(wc.loadURL).toHaveBeenLastCalledWith('http://localhost:50231/')
  })
  it('blocks privileged navigation, popups, downloads and device permissions', () => {
    const manager = new WorkspaceBrowser(window())
    manager.command('one', { type: 'open', url: 'https://example.com' })
    const wc = fake.views[0].webContents
    const event = { preventDefault: vi.fn() }
    wc.emit('will-navigate', event, 'file:///etc/passwd')
    wc.emit('will-redirect', event, 'foreman://workspace/a/b')
    wc.emit('will-attach-webview', event)
    fake.sessions[0].emit('will-download', event)
    expect(event.preventDefault).toHaveBeenCalledTimes(4)
    const callback = vi.fn()
    fake.sessions[0].setPermissionRequestHandler.mock.calls[0][0](wc, 'camera', callback)
    expect(callback).toHaveBeenCalledWith(false)
    expect(fake.sessions[0].setPermissionCheckHandler.mock.calls[0][0]()).toBe(false)
    const popup = wc.setWindowOpenHandler.mock.calls[0][0]
    expect(popup({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(wc.loadURL).toHaveBeenCalledTimes(1)
    popup({ url: 'https://example.com/next' })
    expect(wc.loadURL).toHaveBeenLastCalledWith('https://example.com/next')
  })
  it('closes on archive, reload and window destruction without keeping hidden renderers', () => {
    const win = window()
    const manager = new WorkspaceBrowser(win)
    manager.command('one', { type: 'open', url: 'https://example.com' })
    manager.command('two', { type: 'open', url: 'https://example.com' })
    manager.retain(new Set(['two']))
    expect(fake.views[0].webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    expect(fake.views[1].webContents.close).not.toHaveBeenCalled()
    win.webContents.emit('did-start-loading')
    expect(fake.views[1].webContents.close).toHaveBeenCalledOnce()
    win.emit('closed')
    expect(fake.views[1].webContents.close).toHaveBeenCalledOnce()
  })
  it('captures only visible pages and reports navigation failures', async () => {
    const win = window()
    const manager = new WorkspaceBrowser(win)
    manager.command('one', { type: 'open', url: 'https://example.com' })
    await expect(manager.capture('one')).rejects.toThrow('Open the browser')
    manager.command('one', { type: 'bounds', bounds: { x: 0, y: 0, width: 200, height: 200 } })
    expect(await manager.capture('one')).toEqual({ base64: Buffer.from('png').toString('base64'), url: 'https://example.com/' })
    fake.views[0].webContents.emit('did-fail-load', {}, -102, 'Connection refused', 'https://example.com', true)
    expect(win.webContents.send).toHaveBeenLastCalledWith('foreman:event', expect.objectContaining({ type: 'browser-state', state: expect.objectContaining({ error: 'Connection refused' }) }))
  })
})
