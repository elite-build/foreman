// Brings latest.yml and the installer's blockmap up to date after the Windows installer has been signed (see
// CODE_SIGNING.md). electron-builder writes both from the installer it built. Signing adds an Authenticode signature to
// the file, so the size and SHA-512 that installed copies check a download against (electron-updater, through
// main/updateInstaller.ts) no longer match, and neither do the blocks a differential download compares.
//
//   node scripts/windows-update-feed.mjs <dist folder>
//
// It uses electron-builder's own block map code and YAML writer, so both files are what electron-builder would have
// written for the signed installer. Everything else in latest.yml (version, path, release date) is kept.

import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js')
const { serializeToYaml } = require('builder-util')
const { load } = require('js-yaml')

/** Recomputes the installer's size, SHA-512 and blockmap in `dir` and writes them into its latest.yml. */
export async function refreshUpdateFeed(dir) {
  const feedFile = path.join(dir, 'latest.yml')
  const feed = load(readFileSync(feedFile, 'utf8'))
  if (!feed || typeof feed.path !== 'string' || !Array.isArray(feed.files) || feed.files.length !== 1 || feed.files[0].url !== feed.path) {
    throw new Error(`${feedFile} is not the single-installer feed electron-builder writes for NSIS`)
  }
  // The feed names its installer by file name; it must be the one installer in the folder.
  const installers = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.exe'))
  if (installers.length !== 1 || installers[0] !== feed.path) {
    throw new Error(`Expected ${feed.path} as the only installer in ${dir}, found: ${installers.join(', ') || 'none'}`)
  }
  const installer = path.join(dir, feed.path)
  const { size, sha512 } = await buildBlockMap(installer, 'gzip', `${installer}.blockmap`)
  feed.files[0].sha512 = sha512
  feed.files[0].size = size
  // electron-builder repeats the first file's hash at the top level for electron-updater before 2.15.
  feed.sha512 = sha512
  writeFileSync(feedFile, serializeToYaml(feed, false, true))
  return feed
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('Usage: node scripts/windows-update-feed.mjs <dist folder>')
    process.exit(2)
  }
  try {
    const feed = await refreshUpdateFeed(dir)
    console.log(`Updated latest.yml and ${feed.path}.blockmap: ${feed.files[0].size} bytes, sha512 ${feed.sha512}`)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}
