import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { refreshUpdateFeed } from '../scripts/windows-update-feed.mjs'
import { tempDir } from './helpers'

// After the Windows installer is signed (CODE_SIGNING.md), latest.yml and the blockmap must describe the signed file:
// installed copies reject a download whose SHA-512 or size differs from the feed's.

const INSTALLER = 'Foreman-Setup-1.2.3.exe'
const sha512 = (file: string) => createHash('sha512').update(readFileSync(file)).digest('base64')

async function release(feed?: string) {
  const dir = await tempDir('windows-feed-')
  const installer = path.join(dir, INSTALLER)
  writeFileSync(installer, randomBytes(300_000))
  writeFileSync(path.join(dir, 'latest.yml'), feed ?? [
    'version: 1.2.3',
    'files:',
    `  - url: ${INSTALLER}`,
    `    sha512: ${sha512(installer)}`,
    '    size: 300000',
    `path: ${INSTALLER}`,
    `sha512: ${sha512(installer)}`,
    "releaseDate: '2026-11-12T10:00:00.000Z'",
    '',
  ].join('\n'))
  return { dir, installer }
}

describe('windows update feed', () => {
  it('describes the installer as it is after signing, keeping everything else', async () => {
    const { dir, installer } = await release()
    // Stands in for the Authenticode signature, which is appended to the file.
    appendFileSync(installer, randomBytes(9_000))

    const feed = await refreshUpdateFeed(dir)

    expect(feed.files).toEqual([{ url: INSTALLER, sha512: sha512(installer), size: 309_000 }])
    expect(feed.sha512).toBe(sha512(installer))
    const written = readFileSync(path.join(dir, 'latest.yml'), 'utf8')
    expect(written).toContain(`sha512: ${sha512(installer)}`)
    expect(written).toContain('size: 309000')
    expect(written).toContain('version: 1.2.3')
    expect(written).toContain(`path: ${INSTALLER}`)
    expect(written).toContain("releaseDate: '2026-11-12T10:00:00.000Z'")
    // A gzip-compressed block map, the form electron-updater's differential download reads.
    expect([...readFileSync(`${installer}.blockmap`).subarray(0, 2)]).toEqual([0x1f, 0x8b])
  })

  it('refuses a folder whose installer is not the one the feed names', async () => {
    const { dir } = await release()
    writeFileSync(path.join(dir, 'Foreman.exe'), 'unpacked app')
    await expect(refreshUpdateFeed(dir)).rejects.toThrow(/only installer/)
  })

  it('refuses a feed that is not a single-installer NSIS feed', async () => {
    const { dir } = await release(`version: 1.2.3\npath: ${INSTALLER}\nsha512: x\n`)
    await expect(refreshUpdateFeed(dir)).rejects.toThrow(/single-installer feed/)
  })
})
