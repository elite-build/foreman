// Renders the app icon from build/icons/*.svg into what the packagers need:
//   build/icon.icns  (macOS; built with iconutil, so run this on a Mac)
//   build/icon.ico   (Windows)
//   build/icon.png   (Linux, 512 px)
//   build/icon-dev.ico and build/icon-dev.png (unpackaged development runs)
// Run with: npx electron scripts/render-icons.mjs
import { app, BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const icons = path.join(root, 'build', 'icons')
const out = path.join(root, 'build')
const MASTER = 1024

app.disableHardwareAcceleration()

/** Render an SVG at 1024 px with a transparent background. */
async function renderMaster(win, file) {
  const svg = readFileSync(path.join(icons, file)).toString('base64')
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden"><img style="display:block;width:${MASTER}px;height:${MASTER}px" src="data:image/svg+xml;base64,${svg}"></body></html>`
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
  await new Promise((resolve) => setTimeout(resolve, 150))
  return win.webContents.capturePage({ x: 0, y: 0, width: MASTER, height: MASTER })
}

const png = (image, size) => image.resize({ width: size, height: size, quality: 'best' }).toPNG()

/** A .ico holding PNG images (supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, entry)
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    header.writeUInt8(0, entry + 2)
    header.writeUInt8(0, entry + 3)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(data.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...images.map((image) => image.data)])
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: MASTER,
    height: MASTER,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true }
  })
  win.webContents.setZoomFactor(1)
  const full = await renderMaster(win, 'foreman.svg')
  const mac = await renderMaster(win, 'foreman-mac.svg')
  const small = await renderMaster(win, 'foreman-small.svg')
  const dev = await renderMaster(win, 'foreman-dev.svg')
  const devSmall = await renderMaster(win, 'foreman-dev-small.svg')
  mkdirSync(out, { recursive: true })

  // macOS: Apple's grid for everything but the tiniest sizes, which get the bolder small master.
  const iconset = path.join(out, 'icon.iconset')
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset)
  const entries = [
    ['icon_16x16.png', small, 16],
    ['icon_16x16@2x.png', small, 32],
    ['icon_32x32.png', small, 32],
    ['icon_32x32@2x.png', mac, 64],
    ['icon_128x128.png', mac, 128],
    ['icon_128x128@2x.png', mac, 256],
    ['icon_256x256.png', mac, 256],
    ['icon_256x256@2x.png', mac, 512],
    ['icon_512x512.png', mac, 512],
    ['icon_512x512@2x.png', mac, 1024]
  ]
  for (const [name, image, size] of entries) writeFileSync(path.join(iconset, name), png(image, size))
  if (process.platform === 'darwin') {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(out, 'icon.icns')])
    rmSync(iconset, { recursive: true, force: true })
  }

  // Windows and Linux use the full-bleed tile.
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  writeFileSync(path.join(out, 'icon.ico'), ico(sizes.map((size) => ({ size, data: png(size <= 32 ? small : full, size) }))))
  writeFileSync(path.join(out, 'icon.png'), png(full, 512))
  writeFileSync(path.join(out, 'icon-dev.ico'), ico(sizes.map((size) => ({ size, data: png(size <= 32 ? devSmall : dev, size) }))))
  writeFileSync(path.join(out, 'icon-dev.png'), png(dev, 512))
  console.log(`Icons written to ${out}`)
  app.quit()
})
