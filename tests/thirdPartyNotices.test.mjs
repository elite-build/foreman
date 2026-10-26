import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { packagePathOf } from '../scripts/third-party-packages.mjs'
import { afterExtract, buildNotices, globRegExp, isNativeCode, packageRootOf } from '../scripts/third-party-notices.mjs'

const MZ = Buffer.from([0x4d, 0x5a, 0x90, 0x00])
const SCRIPT = Buffer.from('#!/u')
const ELECTRON = ['LICENSE.electron.txt', 'LICENSES.chromium.html']

// A packaged app: one package with a license and a native file, plus a renderer bundle list.
function fixture({ files = {}, bundled = [], project = {}, config = {}, reviews = [], electronNotices = ELECTRON } = {}) {
  const app = {
    'node_modules/kept/package.json': JSON.stringify({ name: 'kept', version: '1.0.0', license: 'MIT' }),
    'node_modules/kept/LICENSE': 'Copyright kept\n',
    'node_modules/kept/kept.node': MZ,
    'out/renderer/third-party-packages.json': JSON.stringify({ schemaVersion: 1, packages: bundled }),
    ...files
  }
  const tree = {
    'node_modules/inlined/package.json': JSON.stringify({ name: 'inlined', version: '2.0.0', license: 'ISC' }),
    'node_modules/inlined/LICENSE.md': 'Copyright inlined\n',
    'docs/licenses/kept-native.txt': 'Native notice\n',
    ...project
  }
  const lock = { packages: { '': {}, 'node_modules/kept': { version: '1.0.0', integrity: 'sha512-kept' }, 'node_modules/deep/node_modules/inlined': { version: '2.0.0', integrity: 'sha512-inlined' }, 'node_modules/@x/alias-win': { version: '3.0.0-win', integrity: 'sha512-alias' } } }
  const buffer = (f) => Buffer.isBuffer(app[f]) ? app[f] : Buffer.from(app[f])
  return buildNotices({
    app: { files: Object.keys(app).sort(), read: buffer, head: (f) => buffer(f).subarray(0, 4) },
    project: {
      read: (f) => { if (!(f in tree)) throw new Error(`missing ${f}`); return tree[f] },
      list: (dir) => Object.keys(tree).filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/')).map((f) => f.slice(dir.length + 1))
    },
    lock,
    reviews: { schemaVersion: 1, reviews },
    config: {
      packageNotices: [],
      components: [{ id: 'kept-native', name: 'kept native', version: '1.0.0', license: 'MIT', files: ['node_modules/kept/*.node'], notices: ['docs/licenses/kept-native.txt'], source: 'https://example.org/kept' }],
      excluded: [{ files: ['node_modules/kept/voice/**'], reason: 'unused' }],
      ...config
    },
    meta: { product: 'Foreman', version: '0.0.0', platform: 'win32', arch: 'x64', electronNotices }
  })
}

test('packaged and inlined packages and native components all carry their notices', () => {
  const { text, inventory, errors } = fixture({ bundled: [{ path: 'node_modules/inlined', name: 'inlined', version: '2.0.0' }] })
  assert.deepEqual(errors, [])
  for (const notice of ['Copyright kept', 'Copyright inlined', 'Native notice']) assert.ok(text.includes(notice), notice)
  assert.deepEqual(inventory.packages.map((p) => [p.name, p.locations]), [['inlined', ['out/renderer bundle']], ['kept', ['app.asar']]])
  assert.deepEqual(inventory.components.map((c) => [c.id, c.files]), [['kept-native', ['node_modules/kept/kept.node']]])
})

test('a shipped package without license text fails instead of shipping without a notice', () => {
  const { errors } = fixture({ files: { 'node_modules/bare/package.json': JSON.stringify({ name: 'bare', version: '1.0.0', license: 'MIT' }) } })
  assert.match(errors.join(), /bare@1\.0\.0 .*no license text/)
})

test('supplemental notices apply to the exact name and version only', () => {
  const files = { 'node_modules/@x/alias-win/package.json': JSON.stringify({ name: '@x/alias', version: '3.0.0-win', license: 'Apache-2.0' }) }
  const project = { 'docs/licenses/alias.txt': 'Alias license\n' }
  const notice = (packages) => ({ packageNotices: [{ packages, license: 'Apache-2.0', notices: ['docs/licenses/alias.txt'], source: 'https://example.org/alias', reason: 'no file' }] })
  const ok = fixture({ files, project, config: notice(['@x/alias@3.0.0-*']) })
  assert.deepEqual(ok.errors, [])
  assert.ok(ok.text.includes('Alias license'))
  assert.match(fixture({ files, project, config: notice(['@x/alias@2.*']) }).errors.join(), /no license text/)
})

test('reviews and lock entries match re-hoisted packages by install name and version', () => {
  // electron-builder put the lockfile's node_modules/deep/node_modules/inlined at the top level.
  const review = { id: 'copyleft', license: 'MPL-2.0', notice: 'docs/licenses/kept-native.txt', source: 'https://example.org/copyleft/commit', distribution: 'source-required', packages: [{ path: 'node_modules/deep/node_modules/inlined', version: '2.0.0' }] }
  const files = { 'node_modules/inlined/package.json': JSON.stringify({ name: 'inlined', version: '2.0.0', license: 'MPL-2.0' }) }
  const { text, inventory, errors } = fixture({ files, reviews: [review] })
  assert.deepEqual(errors, [])
  const inlined = inventory.packages.find((p) => p.name === 'inlined')
  assert.deepEqual([inlined.distribution, inlined.integrity, inlined.source], ['source-required', 'sha512-inlined', 'https://example.org/copyleft/commit'])
  assert.match(text, /inlined 2\.0\.0 \(MPL-2\.0\)[^\n]*\n {4}https:\/\/example\.org\/copyleft\/commit/)
})

test('a packaged package missing from the lockfile fails', () => {
  const files = { 'node_modules/stray/package.json': JSON.stringify({ name: 'stray', version: '1.0.0' }), 'node_modules/stray/LICENSE': 'Copyright stray\n' }
  assert.match(fixture({ files }).errors.join(), /stray@1\.0\.0 .*not in package-lock\.json/)
})

test('unreviewed native code, excluded files and missing Electron notices fail', () => {
  const { errors } = fixture({ files: { 'node_modules/kept/bin/helper': MZ, 'node_modules/kept/bin/script': SCRIPT, 'node_modules/kept/voice/lib.dll': MZ }, electronNotices: ['LICENSE.electron.txt'] })
  assert.ok(errors.some((e) => e.startsWith('node_modules/kept/bin/helper: native code without a reviewed component')))
  assert.ok(!errors.some((e) => e.includes('bin/script')))
  assert.ok(errors.some((e) => e.startsWith('node_modules/kept/voice/lib.dll: excluded from distribution')))
  assert.ok(errors.some((e) => e.startsWith('LICENSES.chromium.html: ')))
})

test('bundle lists that disagree with the build tree require a rebuild', () => {
  const { errors } = fixture({ bundled: [{ path: 'node_modules/inlined', name: 'inlined', version: '1.9.0' }] })
  assert.match(errors.join(), /rebuild before packaging/)
})

test('a macOS app keeps Electron\'s license files, which electron-builder deletes beside the bundle', async () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'notices-extract-'))
  try {
    const resources = path.join(out, 'Electron.app', 'Contents', 'Resources')
    mkdirSync(resources, { recursive: true })
    await afterExtract({ appOutDir: out, electronPlatformName: 'win32' })
    assert.ok(!existsSync(path.join(resources, 'LICENSE.electron.txt')))
    await assert.rejects(afterExtract({ appOutDir: out, electronPlatformName: 'darwin' }), /LICENSE: not in the extracted Electron distribution/)
    writeFileSync(path.join(out, 'LICENSE'), 'Electron MIT\n')
    writeFileSync(path.join(out, 'LICENSES.chromium.html'), '<p>Chromium credits</p>\n')
    await afterExtract({ appOutDir: out, electronPlatformName: 'darwin' })
    assert.equal(readFileSync(path.join(resources, 'LICENSE.electron.txt'), 'utf8'), 'Electron MIT\n')
    assert.equal(readFileSync(path.join(resources, 'LICENSES.chromium.html'), 'utf8'), '<p>Chromium credits</p>\n')
  } finally { rmSync(out, { recursive: true, force: true }) }
})

test('path helpers', () => {
  assert.equal(packageRootOf('node_modules/a/node_modules/@s/b/package.json'), 'node_modules/a/node_modules/@s/b')
  assert.equal(packageRootOf('node_modules/a/dist/package.json'), null)
  assert.equal(packagePathOf('\0/repo/node_modules/a/node_modules/@s/b/lib/x.js?commonjs-proxy', '/repo'), 'node_modules/a/node_modules/@s/b')
  assert.equal(packagePathOf('/repo/src/main.ts', '/repo'), null)
  assert.ok(globRegExp('node_modules/@x/sdk-*/bin/*').test('node_modules/@x/sdk-win32-x64/bin/rg.exe'))
  assert.ok(!globRegExp('node_modules/@x/sdk-*/bin/*').test('node_modules/@x/sdk-win32-x64/bin/sub/rg.exe'))
  assert.ok(globRegExp('a/**').test('a/b/c.dll'))
  assert.ok(isNativeCode(MZ) && isNativeCode(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])) && isNativeCode(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
  assert.ok(!isNativeCode(SCRIPT) && !isNativeCode(Buffer.alloc(2)))
})

test('every configured notice exists and installer packaging runs the notices hook', () => {
  const config = JSON.parse(readFileSync('scripts/distribution-components.json', 'utf8'))
  const reviews = JSON.parse(readFileSync('scripts/dependency-license-reviews.json', 'utf8')).reviews.map((r) => r.id)
  for (const entry of [...config.packageNotices, ...config.components]) {
    for (const notice of entry.notices) assert.ok(readFileSync(notice, 'utf8').trim(), notice)
    assert.match(entry.source, /^https:\/\//)
  }
  for (const component of config.components) {
    assert.ok(component.notices.length || component.packageLicense, component.id)
    if (component.review) assert.ok(reviews.includes(component.review), component.id)
  }
  const build = JSON.parse(readFileSync('package.json', 'utf8')).build
  assert.equal(build.afterPack, './scripts/third-party-notices.mjs')
  assert.equal(build.afterExtract, './scripts/third-party-notices.mjs')
  for (const excluded of config.excluded.flatMap((x) => x.files)) assert.ok(build.files.includes(`!**/${excluded}`), excluded)
})
