// Installer third-party notices, generated from the packaged app rather than the lockfile: every package root
// in app.asar, every package the bundles inlined (third-party-packages.mjs), and every native executable or
// library, each matched to license text. Packaging fails when one has none. This writes notices; it does not
// clear redistribution: `npm run check:licenses:distribution` and docs/dependency-licenses.md cover that.
// Runs as electron-builder's afterPack hook (before signing), or `node scripts/third-party-notices.mjs <resources dir>`.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED_PACKAGES_FILE } from './third-party-packages.mjs'

export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt'
export const INVENTORY_FILE = 'third-party-inventory.json'
export const ELECTRON_NOTICES = ['LICENSE.electron.txt', 'LICENSES.chromium.html']
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice|unlicense|copyright)(?:[-._].*)?$/i
const NATIVE_NAME = /(?:\.(?:exe|dll|node|dylib|so(?:\.\d+)*)|\/[^/.]+)$/i
const RULE = `${'='.repeat(78)}\n`
const LINE = `${'-'.repeat(78)}\n`

/** '*' stays within one path segment, '**' crosses them. */
export function globRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] !== '*') re += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    else if (glob[i + 1] === '*') { re += '.*'; i++ }
    else re += '[^/]*'
  }
  return new RegExp(`^${re}$`)
}
const matches = (globs, value) => globs.some((g) => globRegExp(g).test(value))

/** 'node_modules/a/node_modules/@s/b/package.json' → 'node_modules/a/node_modules/@s/b'. */
export function packageRootOf(file) {
  return file.match(/^((?:node_modules\/(?:@[^/]+\/)?[^/]+\/)+)package\.json$/)?.[1].slice(0, -1) ?? null
}

/** The folder a package is installed as ('node_modules/x/node_modules/@s/b' → '@s/b'); aliases differ from package.json's name. */
const installName = (root) => root.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1] ?? root
/** electron-builder re-hoists node_modules, so packaged paths are matched to the lockfile by install name and version. */
const identity = (root, version) => `${installName(root)}@${version}`

/** PE, ELF or Mach-O (thin or universal) from a file's first four bytes. */
export function isNativeCode(head) {
  if (head.length < 4) return false
  if (head[0] === 0x4d && head[1] === 0x5a) return true
  return [0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(head.readUInt32BE(0))
}

function repositoryOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  return repo ? repo.replace(/^git\+/, '').replace(/\.git$/, '') : null
}

function declaredLicense(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license?.type) return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ')
  return 'UNKNOWN'
}

const normalized = (text) => text.replace(/\r\n/g, '\n')

/**
 * app: { files, read(file) → Buffer, head(file) → Buffer } for the packaged app (paths inside app.asar, '/').
 * project: { read(file) → string, list(dir) → names } for the source tree the app was built from.
 */
export function buildNotices({ app, project, lock, reviews, config, meta }) {
  const errors = []
  const reviewOf = new Map(reviews.reviews.flatMap((r) => r.packages.map((p) => [identity(p.path, p.version), r])))
  const reviewById = new Map(reviews.reviews.map((r) => [r.id, r]))
  const locked = new Map(Object.entries(lock.packages).filter(([p]) => p).map(([p, pkg]) => [identity(p, pkg.version), pkg]))
  const readNotice = (file) => {
    try { return normalized(project.read(file)) } catch { errors.push(`${file}: notice missing`); return '' }
  }

  // Package roots shipped as files, then packages the bundles inlined.
  const packages = new Map()
  for (const file of app.files) {
    const root = packageRootOf(file)
    if (!root) continue
    const pkg = JSON.parse(app.read(file).toString('utf8'))
    const texts = app.files.filter((f) => path.posix.dirname(f) === root && LICENSE_FILE.test(path.posix.basename(f)))
      .map((f) => app.read(f).toString('utf8'))
    packages.set(root, { path: root, pkg, texts, locations: ['app.asar'] })
  }
  for (const list of app.files.filter((f) => path.posix.basename(f) === BUNDLED_PACKAGES_FILE)) {
    const bundle = `${path.posix.dirname(list)} bundle`
    for (const entry of JSON.parse(app.read(list).toString('utf8')).packages) {
      const known = packages.get(entry.path)
      if (known) { known.locations.push(bundle); continue }
      const pkg = JSON.parse(project.read(`${entry.path}/package.json`))
      if (pkg.name !== entry.name || pkg.version !== entry.version) errors.push(`${entry.path}: ${list} records ${entry.name}@${entry.version} but the build tree has ${pkg.name}@${pkg.version}; rebuild before packaging`)
      const texts = project.list(entry.path).filter((n) => LICENSE_FILE.test(n)).sort().map((n) => project.read(`${entry.path}/${n}`))
      packages.set(entry.path, { path: entry.path, pkg, texts, locations: [bundle] })
    }
  }

  const inventoryPackages = []
  const sourceOffers = []
  const packageSections = []
  const ordered = [...packages.values()].sort((a, b) => a.pkg.name.localeCompare(b.pkg.name) || a.path.localeCompare(b.path))
  for (const { path: at, pkg, texts, locations } of ordered) {
    const id = identity(at, pkg.version)
    const review = reviewOf.get(id)
    const extra = config.packageNotices.find((n) => matches(n.packages, `${pkg.name}@${pkg.version}`))
    const all = [...texts, ...(review ? [readNotice(review.notice)] : []), ...(extra?.notices ?? []).map(readNotice)]
    const seen = new Set()
    const unique = all.map((t) => normalized(t).trimEnd()).filter((t) => {
      const key = createHash('sha256').update(t.trim()).digest('hex')
      return t.trim() && !seen.has(key) && seen.add(key)
    })
    if (!unique.length) errors.push(`${pkg.name}@${pkg.version} (${at}): no license text in the package, its review or scripts/distribution-components.json`)
    const license = review?.license ?? extra?.license ?? declaredLicense(pkg)
    const distribution = review?.distribution ?? 'allowed'
    const source = review?.source ?? extra?.source ?? repositoryOf(pkg)
    if (distribution === 'source-required') sourceOffers.push(`  ${pkg.name} ${pkg.version} (${license}), in ${locations.join(', ')}:\n    ${source}`)
    const integrity = locked.get(id)?.integrity ?? null
    if (!integrity) errors.push(`${id} (${at}): not in package-lock.json`)
    inventoryPackages.push({ name: pkg.name, version: pkg.version, license, path: at, locations, integrity, distribution, source })
    packageSections.push(`${pkg.name} ${pkg.version}\nLicense: ${license}\nLocation: ${locations.join(', ')} (${at})\n${source ? `Source: ${source}\n` : ''}\n${unique.map((t) => `${t}\n`).join('\n')}`)
  }

  // Every native executable or library needs a reviewed component; excluded files must not ship at all.
  const componentFiles = new Map(config.components.map((c) => [c.id, []]))
  for (const file of app.files) {
    if (config.excluded.some((x) => matches(x.files, file))) { errors.push(`${file}: excluded from distribution in scripts/distribution-components.json but packaged`); continue }
    if (!NATIVE_NAME.test(`/${file}`) || !isNativeCode(app.head(file))) continue
    const component = config.components.find((c) => matches(c.files, file))
    if (component) componentFiles.get(component.id).push(file)
    else errors.push(`${file}: native code without a reviewed component in scripts/distribution-components.json`)
  }
  const inventoryComponents = []
  const componentSections = []
  for (const component of config.components) {
    const files = componentFiles.get(component.id)
    if (!files.length) continue
    const distribution = component.review ? reviewById.get(component.review)?.distribution ?? 'review-required' : 'allowed'
    inventoryComponents.push({ id: component.id, name: component.name, version: component.version, license: component.license, files, distribution, source: component.source })
    const texts = component.notices.map((n) => `${readNotice(n).trimEnd()}\n`)
    if (component.packageLicense) texts.push('Covered by the license of the package that contains it, above.\n')
    componentSections.push(`${component.name}\nLicense: ${component.license}\nFiles: ${files.join(', ')}\nSource: ${component.source}\n\n${texts.join('\n')}`)
  }
  for (const missing of ELECTRON_NOTICES.filter((n) => !meta.electronNotices.includes(n))) errors.push(`${missing}: Electron's license file is missing from the packaged app`)

  const text = `Third-party notices for ${meta.product} ${meta.version} (${meta.platform}-${meta.arch})

Generated when this copy was packaged, from the files it contains. Foreman's own
code is licensed under the Apache License 2.0 (LICENSE and NOTICE in app.asar).
The software below keeps its own license; nothing here relicenses it.

Electron and Chromium, including the libraries they bundle: see
${ELECTRON_NOTICES.join(' and ')} in the application folder.

Source code for components whose licenses require it to be made available:
${sourceOffers.length ? sourceOffers.join('\n') : '  None.'}

${RULE}Packages
${RULE}
${packageSections.join(LINE)}
${RULE}Native and vendored components
${RULE}
${componentSections.join(LINE)}`
  return { text, inventory: { schemaVersion: 1, ...meta, packages: inventoryPackages, components: inventoryComponents }, errors }
}

/** Lists and reads app.asar (and app.asar.unpacked) without extracting it. */
export function readAsar(asarPath) {
  const readAt = (position, length) => {
    const fd = openSync(asarPath, 'r')
    try {
      const buffer = Buffer.alloc(length)
      if (readSync(fd, buffer, 0, length, position) !== length) throw new Error(`${asarPath}: truncated archive`)
      return buffer
    } finally { closeSync(fd) }
  }
  const headerSize = readAt(0, 8).readUInt32LE(4)
  const pickle = readAt(8, headerSize)
  const header = JSON.parse(pickle.toString('utf8', 8, 8 + pickle.readUInt32LE(4)))
  const entries = new Map()
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const file = prefix ? `${prefix}/${name}` : name
      if (child.files) walk(child, file)
      else if (!child.link) entries.set(file, child)
    }
  }
  walk(header, '')
  const bytes = (file, limit) => {
    const entry = entries.get(file)
    if (!entry) throw new Error(`${file}: not in ${asarPath}`)
    if (entry.unpacked) {
      const all = readFileSync(path.join(`${asarPath}.unpacked`, ...file.split('/')))
      return limit ? all.subarray(0, limit) : all
    }
    const size = limit ? Math.min(limit, entry.size) : entry.size
    return size ? readAt(8 + headerSize + Number(entry.offset), size) : Buffer.alloc(0)
  }
  return { files: [...entries.keys()].sort(), read: (file) => bytes(file), head: (file) => bytes(file, 4) }
}

function findElectronNotices(appOutDir) {
  const found = []
  const visit = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && ELECTRON_NOTICES.includes(entry.name)) found.push(entry.name)
      else if (entry.isDirectory() && depth < 3 && !entry.name.endsWith('.asar.unpacked')) visit(path.join(dir, entry.name), depth + 1)
    }
  }
  visit(appOutDir, 0)
  return found
}

export function writeNotices({ resourcesDir, appOutDir, projectDir, platform, arch, product, version }) {
  const fromProject = (file) => path.join(projectDir, ...file.split('/'))
  const project = { read: (file) => readFileSync(fromProject(file), 'utf8'), list: (dir) => readdirSync(fromProject(dir)) }
  const json = (file) => JSON.parse(project.read(file))
  const { text, inventory, errors } = buildNotices({
    app: readAsar(path.join(resourcesDir, 'app.asar')),
    project,
    lock: json('package-lock.json'),
    reviews: json('scripts/dependency-license-reviews.json'),
    config: json('scripts/distribution-components.json'),
    meta: { product, version, platform, arch, electronNotices: findElectronNotices(appOutDir) }
  })
  if (errors.length) throw new Error(`Third-party notices are incomplete (see docs/dependency-licenses.md):\n${errors.join('\n')}`)
  writeFileSync(path.join(resourcesDir, NOTICES_FILE), text)
  writeFileSync(path.join(resourcesDir, INVENTORY_FILE), `${JSON.stringify(inventory, null, 2)}\n`)
  return inventory
}

const ARCH = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

export default async function afterPack(context) {
  const { packager, appOutDir } = context
  writeNotices({
    resourcesDir: packager.getResourcesDir(appOutDir),
    appOutDir,
    projectDir: packager.projectDir,
    platform: context.electronPlatformName,
    arch: ARCH[context.arch] ?? String(context.arch),
    product: packager.appInfo.productName,
    version: packager.appInfo.version
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [resourcesDir, appOutDir] = process.argv.slice(2)
  if (!resourcesDir || !existsSync(path.join(resourcesDir, 'app.asar'))) throw new Error('Usage: node scripts/third-party-notices.mjs <packaged resources directory> [application folder]')
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const inventory = writeNotices({
    resourcesDir,
    appOutDir: appOutDir ?? path.dirname(resourcesDir),
    projectDir: process.cwd(),
    platform: process.platform,
    arch: process.arch,
    product: pkg.build?.productName ?? pkg.name,
    version: pkg.version
  })
  console.log(`Wrote ${NOTICES_FILE} and ${INVENTORY_FILE}: ${inventory.packages.length} packages, ${inventory.components.length} native components.`)
}
