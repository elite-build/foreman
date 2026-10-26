// Docker cleanup on archive (O18) in the main process: list and remove the containers
// labelled with a workspace's id. The runner is injected so tests never need Docker.
import { execFile } from 'node:child_process'
import { classifyFailure, listArgs, networkRemoveArgs, networksArgs, parseNetworks, parsePs, removeArgs, type DockerListing, type DockerRemoval } from '../shared/docker'
import { agentBaseEnv } from './platform'

export interface DockerResult {
  code: number
  stdout: string
  stderr: string
  // Set when the process couldn't start at all (ENOENT: docker isn't installed).
  spawnError?: string
}

/** Runs `docker <args>`. */
export type DockerRunner = (args: string[]) => Promise<DockerResult>

const TIMEOUT_MS = 20_000

/** The real docker CLI, with the user's shell PATH; a stopped daemon fails fast, a hung one times out. */
export const dockerCli: DockerRunner = (args) =>
  new Promise((resolve) => {
    execFile('docker', args, { env: agentBaseEnv(), timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout ?? '')
      const errText = String(stderr ?? '')
      if (!err) return resolve({ code: 0, stdout: out, stderr: errText })
      const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean }
      // A string code (ENOENT, EACCES) means docker never started.
      if (typeof e.code === 'string') return resolve({ code: -1, stdout: '', stderr: errText || e.message, spawnError: e.code })
      if (e.killed) return resolve({ code: -1, stdout: out, stderr: `docker didn’t answer within ${TIMEOUT_MS / 1000} seconds` })
      resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout: out, stderr: errText })
    })
  })

const firstLine = (text: string) => text.trim().split(/\r?\n/).find(Boolean) ?? ''

const safely = (run: DockerRunner, args: string[]): Promise<DockerResult> =>
  run(args).catch((err: unknown): DockerResult => ({ code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }))

/** The workspace's labelled containers, running or stopped, or why Docker couldn't say. Never throws. */
export async function listContainers(workspaceId: string, run: DockerRunner = dockerCli): Promise<DockerListing> {
  const out = await safely(run, listArgs(workspaceId))
  if (out.code === 0 && !out.spawnError) return { status: 'ok', containers: parsePs(out.stdout, workspaceId) }
  const kind = classifyFailure(out)
  return kind === 'error' ? { status: 'error', detail: firstLine(out.stderr) || `exit code ${out.code}` } : { status: kind }
}

/**
 * The archive's Docker step: list the labelled containers again and `docker rm -f` each one by id,
 * so one that won't go doesn't hold back the others. Never throws; what failed is in the result.
 */
export async function removeContainers(workspaceId: string, run: DockerRunner = dockerCli, extras = false): Promise<DockerRemoval> {
  const listing = await listContainers(workspaceId, run)
  if (listing.status !== 'ok') return { status: listing.status, removed: [], failed: [], ...(listing.status === 'error' ? { detail: listing.detail } : {}) }
  const removal: DockerRemoval = { status: 'ok', removed: [], failed: [] }
  // G3: with extras on, note each container's networks before it goes (afterwards Docker can't say).
  const networks = new Set<string>()
  for (const c of listing.containers) {
    if (extras) {
      const inspected = await safely(run, networksArgs(c.id))
      if (inspected.code === 0) for (const name of parseNetworks(inspected.stdout)) networks.add(name)
    }
    const out = await safely(run, removeArgs([c.id], extras))
    if (out.code === 0 && !out.spawnError) removal.removed.push(c.name)
    else removal.failed.push({ name: c.name, detail: firstLine(out.stderr) || `exit code ${out.code}` })
  }
  if (extras) {
    removal.volumes = true
    removal.networks = { removed: [], kept: [] }
    // A network another container still uses is refused by Docker and stays; that's reported, not an error.
    for (const name of networks) {
      const out = await safely(run, networkRemoveArgs(name))
      if (out.code === 0 && !out.spawnError) removal.networks.removed.push(name)
      else removal.networks.kept.push({ name, detail: firstLine(out.stderr) || `exit code ${out.code}` })
    }
  }
  return removal
}
