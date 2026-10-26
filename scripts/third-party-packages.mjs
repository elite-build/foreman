// Records the npm packages a Vite/Rolldown build inlined. Bundled code leaves node_modules behind, so the
// installer notices (scripts/third-party-notices.mjs) read this list from the packaged app instead.
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const BUNDLED_PACKAGES_FILE = 'third-party-packages.json'

/** 'C:\\repo\\node_modules\\a\\node_modules\\@s\\b\\lib\\x.js?query' → 'node_modules/a/node_modules/@s/b', relative to root. */
export function packagePathOf(id, root) {
  const file = id.replace(/^\0/, '').replace(/[?#].*$/, '').replaceAll('\\', '/')
  const at = file.lastIndexOf('/node_modules/')
  if (at < 0) return null
  const parts = file.slice(at + '/node_modules/'.length).split('/')
  const name = parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  if (!name || name.startsWith('.')) return null
  return path.relative(root, `${file.slice(0, at)}/node_modules/${name}`).replaceAll('\\', '/')
}

export function thirdPartyPackages(root = process.cwd()) {
  let viteRoot = root
  return {
    name: 'foreman-third-party-packages',
    configResolved(config) {
      viteRoot = config.root
    },
    generateBundle(_options, bundle) {
      const paths = new Set()
      for (const output of Object.values(bundle)) {
        // Chunks list the modules they inlined (absolute ids); assets such as fonts list the files they were
        // copied from, relative to the Vite root.
        const ids = output.type === 'chunk' ? output.moduleIds : (output.originalFileNames ?? []).map((f) => path.resolve(viteRoot, f))
        for (const id of ids) {
          const p = packagePathOf(id, root)
          if (p) paths.add(p)
        }
      }
      const packages = [...paths].sort().map((p) => {
        const { name, version } = JSON.parse(readFileSync(path.join(root, p, 'package.json'), 'utf8'))
        return { path: p, name, version }
      })
      this.emitFile({ type: 'asset', fileName: BUNDLED_PACKAGES_FILE, source: `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n` })
    }
  }
}
