// Docker cleanup on archive (O18): the pure parts shared by main and the renderer.
// Foreman only ever touches containers labelled foreman.workspace=<workspace id>,
// which a compose file sets from FOREMAN_WORKSPACE_ID. Containers only: volumes,
// images and networks are never removed. Docker being absent or stopped is a
// state to report, never an error that stops an archive.

/** The label a compose service carries so Foreman can find it. */
export const DOCKER_LABEL = 'foreman.workspace'

/** A labelled container, as `docker ps` lists it. */
export interface DockerContainer {
  id: string
  name: string
  image: string
  // "Up 26 hours", "Exited (0) 2 minutes ago".
  status: string
  // running, exited, created, …
  state: string
}

/** What `docker ps` said: the containers, or why Docker couldn't be asked. */
export type DockerListing =
  | { status: 'ok'; containers: DockerContainer[] }
  // The docker command isn't on the PATH.
  | { status: 'missing' }
  // The command is there but the daemon (Docker Desktop, colima, …) isn't answering.
  | { status: 'not-running' }
  | { status: 'error'; detail: string }

/** The archive's Docker step: what was removed, what couldn't be, or why it was skipped. */
export interface DockerRemoval {
  status: DockerListing['status']
  removed: string[]
  failed: { name: string; detail: string }[]
  // Why listing failed, when status is 'error'.
  detail?: string
  // G3: with "also remove volumes and networks" on: anonymous volumes went with the containers (`rm -v`),
  // and these networks the containers used were removed, or kept because something else still uses them.
  volumes?: boolean
  networks?: { removed: string[]; kept: { name: string; detail: string }[] }
}

/** G3: what an archive's Docker step left behind, kept on the archived workspace for Home's line until removed or dismissed. */
export interface DockerLeft {
  at: string
  status: DockerListing['status']
  // Containers that wouldn't go (empty when Docker couldn't be asked at all).
  containers: string[]
  detail?: string
}

/** What Home says is left, or undefined when the step went through. */
export function dockerLeft(removal: DockerRemoval, at: string): DockerLeft | undefined {
  if (!removalNeedsAttention(removal)) return undefined
  return { at, status: removal.status, containers: removal.failed.map((f) => f.name), ...(removal.detail ? { detail: removal.detail } : {}) }
}

/** Networks Docker makes itself, never removed. */
const BUILT_IN_NETWORKS = new Set(['bridge', 'host', 'none'])

/** G3: `docker inspect` for the networks a container is attached to, as JSON. */
export function networksArgs(id: string): string[] {
  return ['inspect', '--format', '{{json .NetworkSettings.Networks}}', id]
}

/** The network names in that JSON, leaving out Docker's built-in ones. */
export function parseNetworks(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown
    if (!parsed || typeof parsed !== 'object') return []
    return Object.keys(parsed).filter((name) => name && !BUILT_IN_NETWORKS.has(name))
  } catch {
    return []
  }
}

/** `docker network rm` one network; Docker refuses while another container still uses it. */
export function networkRemoveArgs(name: string): string[] {
  return ['network', 'rm', name]
}

/** The archive preview's Docker line. `enabled` false means the repo setting is off. */
export type DockerPreview = { enabled: false } | ({ enabled: true } & DockerListing)

/** The filter value that matches one workspace's containers and nothing else. */
export function labelFilter(workspaceId: string): string {
  return `label=${DOCKER_LABEL}=${workspaceId}`
}

/** `docker ps` for one workspace: running and stopped containers, one JSON object per line. */
export function listArgs(workspaceId: string): string[] {
  return ['ps', '--all', '--no-trunc', '--filter', labelFilter(workspaceId), '--format', '{{json .}}']
}

/**
 * `docker rm -f` on these container ids only. Without `volumes`, never `-v`, so even anonymous volumes stay;
 * with it (G3's opt-in), the containers' anonymous volumes go too. Named volumes are never removed by `rm -v`.
 */
export function removeArgs(ids: string[], volumes = false): string[] {
  return ['rm', '--force', ...(volumes ? ['--volumes'] : []), ...ids]
}

/** "a=1,foreman.workspace=abc" → the label's value, or undefined. */
function labelValue(labels: string, key: string): string | undefined {
  for (const pair of labels.split(',')) {
    const at = pair.indexOf('=')
    if (at > 0 && pair.slice(0, at).trim() === key) return pair.slice(at + 1).trim()
  }
  return undefined
}

/**
 * `docker ps --format '{{json .}}'` output → containers. A line that carries its labels must have
 * this workspace's label too: the filter is Docker's, this is a second look before anything is removed.
 */
export function parsePs(stdout: string, workspaceId: string): DockerContainer[] {
  const out: DockerContainer[] = []
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const id = text(row.ID)
    if (!id) continue
    if (typeof row.Labels === 'string' && labelValue(row.Labels, DOCKER_LABEL) !== workspaceId) continue
    out.push({ id, name: text(row.Names).split(',')[0] || id.slice(0, 12), image: text(row.Image), status: text(row.Status), state: text(row.State) })
  }
  return out
}

const NOT_RUNNING = /cannot connect to the docker daemon|is the docker daemon running|error during connect|daemon is running|docker_engine|dockerDesktop\w*Engine|docker\.sock/i

/** Why a docker command failed, from how it failed: not installed, daemon not running, or something else. */
export function classifyFailure(failure: { spawnError?: string; stderr?: string }): 'missing' | 'not-running' | 'error' {
  if (failure.spawnError === 'ENOENT') return 'missing'
  return NOT_RUNNING.test(failure.stderr ?? '') ? 'not-running' : 'error'
}

/** The archive dialog's Docker step label: how many containers, or null when Docker couldn't say. */
export function previewCount(preview: DockerPreview | undefined): number | null {
  return preview?.enabled && preview.status === 'ok' ? preview.containers.length : null
}

/** After an archive: whether the Docker step needs the user (something left behind or not checked), so the dialog stays open. */
export function removalNeedsAttention(removal: DockerRemoval | undefined): boolean {
  return Boolean(removal && (removal.status !== 'ok' || removal.failed.length > 0))
}

/** The compose snippet the settings row offers to copy. */
export function composeSnippet(services: string[] = ['db']): string {
  return ['services:', ...services.flatMap((s) => [`  ${s}:`, '    labels:', `      ${DOCKER_LABEL}: \${FOREMAN_WORKSPACE_ID}`])].join('\n')
}
