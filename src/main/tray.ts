// #3: Foreman's one tray icon (Windows) or menu-bar extra (macOS) while the app runs. It has sections:
// the attention count and jump list (Settings → General, on by default), and on Windows the phone
// access that used to have a tray of its own. While Foreman is closed, the background agent host
// (O10) draws its own; the two never show together, because the host hides its icon once the app
// attaches. Entries only navigate: there are no Approve buttons here.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import { trayMenu, type TrayAction, type TrayView } from '../shared/attention'
import { elapsed } from '../shared/triage'
import type { TFunction } from '../shared/i18n'
import { badgeText, drawBadge, templateBitmap } from './trayImage'

export interface AppTrayOptions {
  // What the menu's entries do (show the window, then navigate).
  act(action: TrayAction): void
  // Double-click on Windows.
  show(): void
}

function appIcon(): Electron.NativeImage | null {
  try {
    const image = nativeImage.createFromBuffer(readFileSync(path.join(app.getAppPath(), 'build', 'icon.png')))
    return image.isEmpty() ? null : image
  } catch {
    return null
  }
}

/** The icon at 16 px and 32 px (@2x), each pixel row through `draw`. */
function bothSizes(icon: Electron.NativeImage, draw: (bitmap: Buffer, size: number) => Buffer): Electron.NativeImage {
  const at = (size: number) => draw(icon.resize({ width: size, height: size, quality: 'best' }).toBitmap(), size)
  const image = nativeImage.createFromBitmap(at(16), { width: 16, height: 16, scaleFactor: 1 })
  image.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: at(32) })
  return image
}

/**
 * G2: the tray's image. Windows: the app icon with the attention count drawn in (a red badge). macOS: a
 * template image cut from the icon, which the menu bar tints; the count is the title beside it.
 */
export function trayIcon(count: number): Electron.NativeImage {
  const icon = appIcon()
  if (!icon) return nativeImage.createEmpty()
  try {
    if (process.platform === 'darwin') {
      const image = bothSizes(icon, (bitmap, size) => templateBitmap(bitmap, size, size))
      image.setTemplateImage(true)
      return image
    }
    return bothSizes(icon, (bitmap, size) => drawBadge(bitmap, size, count))
  } catch (err) {
    console.error('Could not draw the Foreman tray icon:', err)
    return icon.resize({ width: 16, height: 16 })
  }
}

export class AppTray {
  private tray: Tray | null = null
  private last: { view: TrayView; attention: boolean; phone: boolean; t: TFunction } | null = null
  private timer: NodeJS.Timeout | null = null
  // What the image shows now: the badge's text on Windows (redrawn only when it changes); macOS never redraws.
  private drawn: string | null = null

  constructor(private options: AppTrayOptions) {}

  /** Whether the icon is up (phone access on Windows keeps the app running behind it). */
  get shown(): boolean {
    return this.tray !== null
  }

  /**
   * Draw (or remove) the icon. `attention`: the setting is on. `phone`: phone access is on (Windows only
   * has the tray for it). With neither, there is no icon.
   */
  update(view: TrayView, options: { attention: boolean; phone: boolean; t: TFunction }): void {
    this.last = { view, ...options }
    this.draw()
  }

  private draw(): void {
    if (!this.last) return
    const { view, attention, phone, t } = this.last
    if (!attention && !phone) return this.destroy()
    if (!this.tray) {
      try {
        this.drawn = process.platform === 'darwin' ? '' : badgeText(attention ? view.count : 0)
        this.tray = new Tray(trayIcon(attention ? view.count : 0))
      } catch (err) {
        console.error('Could not create the Foreman tray icon:', err)
        return
      }
      this.tray.on('double-click', () => this.options.show())
    }
    const now = Date.now()
    const age = (since: string) => elapsed(since, now)
    const items = attention
      ? trayMenu(
          view,
          {
            header: (count, oldest) => (count ? `${t('attention.tray.count', { count })}${oldest ? ` · ${t('attention.tray.oldest', { age: oldest })}` : ''}` : t('attention.tray.none')),
            working: t('attention.tray.working'),
            next: t('attention.tray.next'),
            home: t('attention.tray.home'),
            show: t('attention.tray.show'),
            quit: t('attention.tray.quit'),
            phone: phone ? t('attention.tray.phone') : undefined
          },
          age
        )
      : // Phone access alone: the tray it always had.
        trayMenu({ count: 0, attention: [], working: [] }, { header: () => t('attention.tray.phone'), working: '', next: '', home: t('attention.tray.home'), show: t('attention.tray.show'), quit: t('attention.tray.quit') }, age)
    const template: MenuItemConstructorOptions[] = items.map((item) =>
      item.kind === 'separator' ? { type: 'separator' } : item.kind === 'label' ? { label: item.text, enabled: false } : { label: item.text, click: () => this.options.act(item.action) }
    )
    this.tray.setContextMenu(Menu.buildFromTemplate(template))
    const count = attention ? view.count : 0
    // G2: Windows draws the count into the icon; the image changes only when the badge's text does.
    if (process.platform !== 'darwin' && badgeText(count) !== this.drawn) {
      this.drawn = badgeText(count)
      this.tray.setImage(trayIcon(count))
    }
    this.tray.setToolTip(count ? `Foreman · ${t('attention.tray.count', { count })}` : 'Foreman')
    // The menu bar shows the number beside the icon; Windows has it in the icon, the tooltip and the menu's first line.
    if (process.platform === 'darwin') this.tray.setTitle(count ? String(count) : '')
    // The rows say how long each has waited.
    this.timer ??= setInterval(() => this.draw(), 60_000)
    this.timer.unref?.()
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.tray?.destroy()
    this.tray = null
    this.drawn = null
  }
}
