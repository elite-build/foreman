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

// The Fetch standard's bad ports a listener on port 0 can be given: fetch refuses them ("bad port"). Windows hands them
// out when its dynamic port range is set to start at 1024 rather than the default 49152.
const FETCH_BAD_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080])

/** Start a listener on port 0 again until fetch can reach it. */
export async function startFetchable(service: { origin: string; start(): Promise<void>; close(): Promise<void> }): Promise<void> {
  await service.start()
  while (FETCH_BAD_PORTS.has(Number(new URL(service.origin).port))) {
    await service.close()
    await service.start()
  }
}

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
