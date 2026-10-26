import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import { git } from '../src/main/git'
import { shellQuote } from '../src/main/platform'

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false']

/** Run a fixture through the actual script shell on every supported OS. */
export function nodeCommand(source: string): string {
  const encoded = Buffer.from(source).toString('base64')
  return `${shellQuote(process.execPath)} -e "eval(Buffer.from('${encoded}','base64').toString())"`
}

/** Real Git checkpoints can take more than Vitest's default one second on Windows. */
export const waitFor: typeof vi.waitFor = (callback, options) =>
  vi.waitFor(callback, typeof options === 'number' ? options : { timeout: 10_000, ...options })

export async function tempDir(prefix = 'switchyard-test-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

/** A repo on `main` with one commit containing the given files. */
export async function makeRepo(files: Record<string, string> = { 'README.md': 'hello\n' }): Promise<string> {
  const dir = await tempDir()
  await git(dir, ['init', '-q', '-b', 'main'])
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content)
  }
  await git(dir, ['add', '-A'])
  await commit(dir, 'initial')
  return dir
}

export async function commit(dir: string, message: string): Promise<void> {
  await git(dir, [...IDENTITY, 'commit', '-q', '--allow-empty', '-m', message])
}
