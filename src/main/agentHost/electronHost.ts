// Keep agents running (O10): Foreman started as the background agent host (`--foreman-agent-host`).
// A windowless Electron process: the HostServer runs the turns, and this file draws what the OS
// shows while Foreman is closed: the menu-bar extra on macOS, a tray icon on Windows, and
// notifications. It has its own Electron data folder, so it never holds the app's locks.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { app, dialog, Menu, nativeImage, Notification, Tray, type MenuItemConstructorOptions } from 'electron'
import { shortAge, type HostView } from '../../shared/agentHost'
import type { TFunction } from '../../shared/i18n'
import { driverFor } from '../agents/registry'
import { saveCheckpoint } from '../checkpoints'
import { HOST_DIR_FLAG as DIR_FLAG, HOST_FLAG } from './protocol'
import { HostServer } from './server'

/** The command that starts Foreman itself again: the host's own command line without the host arguments. */
function appCommand(): { command: string; args: string[] } {
  return { command: process.execPath, args: process.argv.slice(1).filter((a) => a !== HOST_FLAG && !a.startsWith(DIR_FLAG)) }
}

function openForeman(): void {
  const { command, args } = appCommand()
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  spawn(command, args, { detached: true, stdio: 'ignore', env }).unref()
}

function trayIcon(): Electron.NativeImage {
  try {
    const image = nativeImage.createFromBuffer(readFileSync(path.join(app.getAppPath(), 'build', 'icon.png')))
    return image.resize({ width: 16, height: 16 })
  } catch {
    return nativeImage.createEmpty()
  }
}

export async function runAgentHost(): Promise<void> {
  const dir = process.argv.find((a) => a.startsWith(DIR_FLAG))?.slice(DIR_FLAG.length)
  if (!dir) return app.exit(1)
  app.setPath('userData', path.join(dir, 'electron'))
  await app.whenReady()
  app.dock?.hide()
  // Windows shows toasts only for an app id; the same one as the app's, so they read as Foreman's.
  if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'dev.foreman.app' : 'dev.foreman.app.dev')
  // No windows here; the host decides when to go.
  app.on('window-all-closed', () => undefined)

  let tray: Tray | null = null
  let last: { view: HostView; t: TFunction } | null = null
  let refresh: NodeJS.Timeout | null = null

  const server: HostServer = new HostServer({
    dir,
    driver: driverFor,
    saveCheckpoint: (cwd, id) => saveCheckpoint(cwd, id),
    exit: () => app.exit(0),
    ui: {
      update: (view, t) => {
        last = { view, t }
        draw()
      },
      notify: (title, body) => {
        if (Notification.isSupported()) new Notification({ title, body, silent: false }).show()
      }
    }
  })

  const stopAll = async () => {
    if (!last) return
    const { t, view } = last
    const choice = await dialog.showMessageBox({
      type: 'warning',
      message: t('keepRunning.tray.stopAllTitle', { count: view.count }),
      detail: t('keepRunning.tray.stopAllDetail'),
      buttons: [t('keepRunning.tray.stopAllConfirm'), t('stop.quit.cancel')],
      defaultId: 1,
      cancelId: 1
    })
    if (choice.response === 0) await server.stopAll()
  }

  function draw(): void {
    if (!last || !last.view.visible) {
      tray?.destroy()
      tray = null
      if (refresh) clearInterval(refresh)
      refresh = null
      return
    }
    const { view, t } = last
    const now = Date.now()
    const row = (r: HostView['running'][number]): MenuItemConstructorOptions => ({
      label: `${r.workspace}${r.title ? ` · ${r.title}` : ''}   ${shortAge(r.startedAt, now, t)}`,
      click: openForeman
    })
    const items: MenuItemConstructorOptions[] = [
      { label: `${t('keepRunning.tray.title', { count: view.count })} · ${t('keepRunning.tray.closed')}`, enabled: false },
      ...view.running.map(row)
    ]
    if (view.waiting.length) {
      items.push({ label: t('keepRunning.tray.waiting'), enabled: false })
      items.push(...view.waiting.map(row))
    }
    items.push({ type: 'separator' }, { label: t('keepRunning.tray.open'), click: openForeman }, { label: t('keepRunning.tray.stopAll'), click: () => void stopAll() })
    if (!tray) {
      tray = new Tray(trayIcon())
      tray.on('double-click', openForeman)
    }
    tray.setToolTip(t('keepRunning.tray.title', { count: view.count }))
    if (process.platform === 'darwin') tray.setTitle(String(view.count))
    tray.setContextMenu(Menu.buildFromTemplate(items))
    // The rows show how long each turn has run.
    refresh ??= setInterval(draw, 30_000)
  }

  if (!(await server.listen())) app.exit(0)
}
