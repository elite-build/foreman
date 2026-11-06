// A file a flow's gate shows (docs/loops-and-graphs.md, "Steps": gate): read by its path in the workspace, a glob meaning
// the newest match, cut to a size limit, never outside the workspace. And the words the terminal prints for one.
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readShownFile } from '../src/main/flowShowFiles'
import { openedPullRequest } from '../src/main/scm'
import { gateShowText } from '../src/shared/cli/flows'
import { tempDir } from './helpers'

async function put(root: string, file: string, text: string, ageMinutes = 0): Promise<void> {
  const full = path.join(root, file)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, text)
  const at = new Date(Date.now() - ageMinutes * 60_000)
  await utimes(full, at, at)
}

describe('a file a gate shows', () => {
  it('reads a path, and a glob as the newest file it matches', async () => {
    const root = await tempDir('foreman-show-')
    await put(root, 'docs/features/search/requirements.md', '# Search', 30)
    await put(root, 'docs/features/export/requirements.md', '# Export', 5)
    await put(root, 'docs/features/old/requirements.md', '# Old', 90)
    expect(await readShownFile(root, 'docs/features/search/requirements.md')).toEqual({ path: 'docs/features/search/requirements.md', text: '# Search', cut: false })
    expect(await readShownFile(root, 'docs/features/*/requirements.md')).toEqual({ path: 'docs/features/export/requirements.md', text: '# Export', cut: false })
    expect(await readShownFile(root, 'docs/features/*/design.md')).toEqual({ missing: 'No file matches docs/features/*/design.md in the workspace' })
  })

  it('cuts a long file, and refuses a path outside the workspace', async () => {
    const root = await tempDir('foreman-show-')
    await put(root, 'notes.md', 'x'.repeat(100))
    expect(await readShownFile(root, 'notes.md', 10)).toEqual({ path: 'notes.md', text: 'x'.repeat(10), cut: true })
    expect(await readShownFile(root, '../outside.md')).toEqual({ missing: '“../outside.md” isn’t a path inside the workspace' })
    expect(await readShownFile(root, '/etc/hosts')).toMatchObject({ missing: expect.stringContaining('isn’t a path inside the workspace') })
  })

  it('prints as the path with its lines beneath', () => {
    expect(gateShowText({ kind: 'file', path: 'docs/features/search/requirements.md', summary: '# Search\nFind things.' })).toBe('File docs/features/search/requirements.md:\n      # Search\n      Find things.')
  })
})

describe('the pull request gh opened', () => {
  it('is read from the address gh prints', () => {
    expect(openedPullRequest('Creating draft pull request for b into main\n\nhttps://github.com/acme/api/pull/42\n')).toEqual({ number: 42, url: 'https://github.com/acme/api/pull/42' })
    expect(() => openedPullRequest('a pull request for branch "b" into branch "main" already exists')).toThrow('gh didn’t say which pull request it opened')
  })
})
