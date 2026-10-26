// Remote ("cloud") workspaces: the sandbox providers and what each can do,
// names, defaults, plan limits and the status and session-budget rules. Pure, so main, the renderer and
// tests share them. Vercel Sandbox was the first provider; Docker, E2B and Daytona follow ("Providers").
import { catalogAgent } from './agentCatalog'
import { githubSlug } from './githubLink'
import type { CloudSettings, CloudStatus, CloudUsage, RepoCloud, Settings } from './types'

/**
 * Where things live inside a sandbox. Every provider keeps this layout (Vercel's paths, kept so existing workspaces
 * and bases stay valid): a provider whose image lacks /vercel makes it at create time, writable by the user its
 * commands run as. The clone lands in /vercel/sandbox/repo.
 */
export const CLOUD_SANDBOX_ROOT = '/vercel/sandbox'
export const CLOUD_CWD = '/vercel/sandbox/repo'
// Foreman's own files in the sandbox: the agent host bundle, its package.json and node_modules.
export const CLOUD_HOST_DIR = '/vercel/foreman'
// The host's token and turn logs (no credentials: those reach an agent only as one turn's environment).
export const CLOUD_HOST_STATE_DIR = '/vercel/foreman/state'
export const CLOUD_HOST_SOCKET = '/tmp/foreman-host.sock'
export const CLOUD_IMAGE = 'vercel/sandbox/universal'
export const CLOUD_REGION = 'iad1'

// A cloud shell nobody has typed in or printed to for this long stops keeping its sandbox awake (a running
// script still does): long enough for a pause to read, short enough that a forgotten tab doesn't bill all day.
export const CLOUD_TERMINAL_IDLE_MS = 10 * 60_000
// The host in a sandbox exits after this long with no turn and no app attached: long enough to ride out an app
// restart or a dropped connection, since its turn logs live only in the sandbox.
export const CLOUD_HOST_IDLE_MS = 30 * 60_000

export const workspaceSandboxName = (workspaceId: string): string => `foreman-ws-${workspaceId}`
export const baseSandboxName = (repoId: string): string => `foreman-base-${repoId}`

/** Tags every sandbox Foreman makes carries, for listing and for stopping orphans. */
export const CLOUD_APP_TAG = { app: 'foreman' } as const

// Claude in the cloud (Settings → Cloud workspaces): the `claude setup-token` token is kept in the agent
// vault's 'claude' table under this name, beside the date it was saved. Only cloud turns read it, as
// CLAUDE_CODE_OAUTH_TOKEN; local Claude never gets it (agentEnv passes only the agent's own key variable).
export const CLAUDE_SETUP_TOKEN_KEY = 'claudeSetupToken'
export const CLAUDE_SETUP_TOKEN_SAVED_AT_KEY = 'claudeSetupTokenSavedAt'

export type VercelPlan = 'hobby' | 'pro' | 'enterprise'

/** What the plan allows: one session's length, a sandbox's size, and sandboxes running at once. */
export interface PlanLimits {
  maxSessionMs: number
  maxVcpus: number
  maxConcurrent: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

// ---- providers ----

/** The sandbox services a remote workspace can run on. Code identifiers keep "cloud"; the UI says "Remote". */
export type CloudProviderId = 'vercel' | 'docker' | 'e2b' | 'daytona'
export const CLOUD_PROVIDER_IDS: CloudProviderId[] = ['vercel', 'docker', 'e2b', 'daytona']

export function isCloudProviderId(value: unknown): value is CloudProviderId {
  return typeof value === 'string' && (CLOUD_PROVIDER_IDS as string[]).includes(value)
}

/**
 * What a provider can do. SandboxManager branches on these, never on the provider's id.
 * `base`: it keeps a per-repository base (a snapshot, an image, a template) that workspaces start from through
 * `createFromBase`; without it every workspace is cloned and set up from scratch.
 * `fork`: it can copy a sandbox as it is (Vercel's createFromBase is a fork).
 * `snapshotOnStop`: a stopped sandbox keeps its files until it is deleted.
 * `sessionCap`: sessions end by themselves at a time limit, so extendTimeout and the cap's rollover apply.
 * `pty`: openPty works (remote terminals). `billed`: use costs money, so the usage section shows it.
 */
export interface ProviderCapabilities {
  fork: boolean
  base: boolean
  snapshotOnStop: boolean
  sessionCap: boolean
  pty: boolean
  // Empty: there are no regions to choose (Docker), and the Remote tab hides the control.
  regions: string[]
  vcpuOptions: number[]
  billed: boolean
}

/** One field a provider's connection asks for (the Integrations dialog). Secret fields go to the vault. */
export interface ProviderConnectionField {
  key: string
  secret?: boolean
  optional?: boolean
  placeholder?: string
  default?: string
}

/** How a provider signs in: a token (API key) with its other fields, or a Docker context or host. */
export interface ProviderConnectionSpec {
  kind: 'token' | 'docker-context'
  fields: ProviderConnectionField[]
}

export interface CloudProviderInfo {
  id: CloudProviderId
  label: string
  // hosted: someone else's machines; local: Docker on this computer or on one on the LAN.
  kind: 'hosted' | 'local'
  // The provider module is implemented (src/main/cloud/providers.ts). Until then the UI says "coming soon".
  implemented: boolean
  connection: ProviderConnectionSpec
  // What the provider can do before a connection is made (the provider's own capabilities() wins).
  capabilities: ProviderCapabilities
  // The limits before a connection reports its plan (the provider's limits() wins).
  limits: PlanLimits
  defaultRegion: string
  defaultVcpus: number
  docsUrl: string
}

/**
 * Every provider Foreman knows. Docker, E2B and Daytona are stubs until their provider modules land: each provider
 * agent sets `implemented` and corrects these defaults from the provider's current docs.
 */
export const CLOUD_PROVIDERS: Record<CloudProviderId, CloudProviderInfo> = {
  vercel: {
    id: 'vercel',
    label: 'Vercel',
    kind: 'hosted',
    implemented: true,
    connection: { kind: 'token', fields: [{ key: 'token', secret: true }, { key: 'teamId', placeholder: 'team_…' }, { key: 'projectId', placeholder: 'prj_…' }] },
    capabilities: { fork: true, base: true, snapshotOnStop: true, sessionCap: true, pty: true, regions: ['iad1', 'sfo1', 'cle1', 'fra1', 'hnd1'], vcpuOptions: [2, 4, 8], billed: true },
    limits: { maxSessionMs: 45 * MINUTE, maxVcpus: 4, maxConcurrent: 10 },
    defaultRegion: 'iad1',
    defaultVcpus: 2,
    docsUrl: 'https://vercel.com/docs/vercel-sandbox'
  },
  docker: {
    id: 'docker',
    label: 'Docker',
    kind: 'local',
    implemented: true,
    connection: { kind: 'docker-context', fields: [{ key: 'context', optional: true, placeholder: 'default' }, { key: 'host', optional: true, placeholder: 'ssh://user@host' }] },
    capabilities: { fork: false, base: true, snapshotOnStop: true, sessionCap: false, pty: true, regions: [], vcpuOptions: [1, 2, 4, 8], billed: false },
    limits: { maxSessionMs: 24 * HOUR, maxVcpus: 8, maxConcurrent: 10_000 },
    defaultRegion: '',
    defaultVcpus: 2,
    docsUrl: 'https://docs.docker.com/engine/manage-resources/contexts/'
  },
  e2b: {
    id: 'e2b',
    label: 'E2B',
    kind: 'hosted',
    implemented: true,
    connection: { kind: 'token', fields: [{ key: 'token', secret: true, placeholder: 'e2b_…' }, { key: 'domain', optional: true, placeholder: 'e2b.app' }] },
    // Pause keeps a sandbox's files and memory on every plan; a size is a template (e2bTemplate.ts), one per option.
    capabilities: { fork: false, base: false, snapshotOnStop: true, sessionCap: true, pty: true, regions: [], vcpuOptions: [2, 4, 8], billed: true },
    // Hobby's (docs.e2b.dev/billing): an API key can't read the team's plan, so verify records these.
    limits: { maxSessionMs: HOUR, maxVcpus: 8, maxConcurrent: 20 },
    defaultRegion: '',
    defaultVcpus: 2,
    docsUrl: 'https://docs.e2b.dev'
  },
  daytona: {
    id: 'daytona',
    label: 'Daytona',
    kind: 'hosted',
    implemented: true,
    connection: { kind: 'token', fields: [{ key: 'token', secret: true, placeholder: 'dtn_…' }, { key: 'apiUrl', default: 'https://app.daytona.io/api' }, { key: 'target', optional: true, placeholder: 'us' }] },
    // Containers: no fork, but a stopped base's cold snapshot (base); files kept on stop and archive; no session
    // cap (auto-stop is off). Sizes up to Daytona's default per-sandbox maximum of 4 vCPUs.
    capabilities: { fork: false, base: true, snapshotOnStop: true, sessionCap: false, pty: true, regions: ['us', 'eu'], vcpuOptions: [1, 2, 4], billed: true },
    limits: { maxSessionMs: 24 * HOUR, maxVcpus: 4, maxConcurrent: 10 },
    defaultRegion: 'us',
    defaultVcpus: 2,
    docsUrl: 'https://www.daytona.io/docs'
  }
}

export function cloudProvider(id: CloudProviderId | undefined): CloudProviderInfo {
  return (id && CLOUD_PROVIDERS[id]) || CLOUD_PROVIDERS.vercel
}

/** The provider's name in the UI ("Vercel", "Docker"). */
export const providerLabel = (id: CloudProviderId | undefined): string => cloudProvider(id).label

/** A session cap worth warning about (Vercel Hobby's 45 minutes, E2B Hobby's hour): only providers with one, under 2 h. */
export function shortSessionCap(capabilities: Pick<ProviderCapabilities, 'sessionCap'>, limits: PlanLimits): boolean {
  return capabilities.sessionCap && limits.maxSessionMs < 2 * HOUR
}

/**
 * The provider a repository's remote workspaces use: its own choice, else the first sandbox service with a default
 * connection (Vercel, Docker, E2B, Daytona), else Vercel. `defaults` is IntegrationsState.defaults.
 */
export function repoProvider(cloud: Pick<RepoCloud, 'provider'> | undefined, defaults: Partial<Record<string, string>> | undefined): CloudProviderId {
  if (cloud?.provider && isCloudProviderId(cloud.provider)) return cloud.provider
  return CLOUD_PROVIDER_IDS.find((id) => defaults?.[id]) ?? 'vercel'
}

/** The region to ask a provider for: the repository's when the provider has it, else its default; '' without regions. */
export function providerRegion(region: string, capabilities: Pick<ProviderCapabilities, 'regions'>, id: CloudProviderId): string {
  if (!capabilities.regions.length) return ''
  return capabilities.regions.includes(region) ? region : cloudProvider(id).defaultRegion || capabilities.regions[0]
}

export function planLimits(plan: VercelPlan | undefined): PlanLimits {
  if (plan === 'pro' || plan === 'enterprise') return { maxSessionMs: 24 * HOUR, maxVcpus: 8, maxConcurrent: 10_000 }
  return { maxSessionMs: 45 * MINUTE, maxVcpus: 4, maxConcurrent: 10 }
}

/**
 * What the plan includes each month for sandboxes (Vercel's pricing, research.md): Hobby's free Active CPU,
 * provisioned memory and snapshot storage. Pro and Enterprise bill usage past their credit, so there is no
 * ceiling to draw a bar against: undefined.
 */
export interface PlanAllowances {
  activeCpuMs?: number
  memoryGbHours?: number
  snapshotGb?: number
}

export function planAllowances(plan: VercelPlan | undefined): PlanAllowances {
  if (plan === 'pro' || plan === 'enterprise') return {}
  return { activeCpuMs: 5 * HOUR, memoryGbHours: 420, snapshotGb: 15 }
}

// Memory follows the CPU count on Vercel Sandbox.
export const GB_PER_VCPU = 2

/** A plan name as Vercel's team billing reports it; anything else (or nothing) is Hobby. */
export function parsePlan(raw: unknown): VercelPlan {
  return raw === 'pro' || raw === 'enterprise' ? raw : 'hobby'
}

/** A repository's cloud settings before any are changed. Hobby-safe: 2 vCPUs fit every plan. */
export function cloudDefaults(): Omit<RepoCloud, 'build'> & { maxRunning: number } {
  return { enabled: false, vcpus: 2, region: CLOUD_REGION, idleMinutes: 20, autoContinue: true, installScript: '', maxRunning: 8 }
}

/** A repository's cloud settings with the defaults filled in. */
export function repoCloud(repo: { cloud?: RepoCloud }): RepoCloud & { maxRunning: number } {
  return { ...cloudDefaults(), ...repo.cloud }
}

/** The personal cloud settings with defaults; Claude follows the local sign-in until chosen. */
export function cloudSettings(settings: Pick<Settings, 'claudeAuth' | 'cloud'>): CloudSettings {
  return {
    enabled: false,
    claudeAuth: settings.claudeAuth === 'apiKey' ? 'api-key' : 'setup-token',
    stopOrphansOnLaunch: false,
    deleteSnapshotsOnForget: true,
    maxRunning: 8,
    wakeOnOpen: true,
    ...settings.cloud
  }
}

/** The vCPUs to ask for: the repository's choice, never above what the plan allows. */
export function sandboxVcpus(wanted: number, limits: PlanLimits): number {
  return Math.max(1, Math.min(wanted, limits.maxVcpus))
}

/**
 * The vCPUs to ask a provider for: one of its sizes, the repository's choice when it offers it, else the largest
 * below it (else its smallest), never above the plan. Vercel on Hobby: 8 → 4, as sandboxVcpus.
 */
export function providerVcpus(wanted: number, capabilities: Pick<ProviderCapabilities, 'vcpuOptions'>, limits: PlanLimits): number {
  const sizes = capabilities.vcpuOptions.filter((v) => v <= limits.maxVcpus).sort((a, b) => a - b)
  if (!sizes.length) return sandboxVcpus(wanted, limits)
  if (sizes.includes(wanted)) return wanted
  return [...sizes].reverse().find((v) => v <= wanted) ?? sizes[0]
}

// Sessions start with at most 2 hours (45 minutes on Hobby) and are extended while something is active.
const SESSION_START_MAX = 2 * HOUR
// While active, keep at least this much time left, topping up to `HEADROOM_TARGET`.
export const HEADROOM_MIN_MS = 15 * MINUTE
const HEADROOM_TARGET_MS = 30 * MINUTE

export function sessionBudgetMs(limits: PlanLimits): number {
  return Math.min(limits.maxSessionMs, SESSION_START_MAX)
}

/**
 * How much to extend a running session by so it keeps at least 15 minutes of headroom, never past
 * the plan's cap on a session's length. 0 when there is enough left, or the cap is reached.
 */
export function extensionMs(input: { now: number; expiresAt: number; startedAt?: number; maxSessionMs: number }): number {
  const left = input.expiresAt - input.now
  if (left >= HEADROOM_MIN_MS) return 0
  const cap = (input.startedAt ?? input.expiresAt - input.maxSessionMs) + input.maxSessionMs
  const want = input.now + HEADROOM_TARGET_MS - input.expiresAt
  return Math.max(0, Math.min(want, cap - input.expiresAt))
}

/** A sandbox's state as the provider reports it. */
export type ProviderStatus = 'pending' | 'running' | 'stopping' | 'stopped' | 'failed' | 'aborted' | 'snapshotting'

/**
 * Foreman's status for a workspace's sandbox. A session that stopped by itself at its time limit while
 * a turn was marked running is `capped` (the turn was cut off), not just asleep.
 */
export function cloudStatusFrom(provider: ProviderStatus | null, facts: { now: number; expiresAt?: number; turnRunning: boolean; sleptByUs?: boolean }): CloudStatus {
  if (provider === null) return 'gone'
  if (provider === 'running') return 'running'
  if (provider === 'pending') return 'waking'
  if (provider === 'failed' || provider === 'aborted') return 'failed'
  if (provider === 'stopped' && facts.turnRunning && !facts.sleptByUs && facts.expiresAt !== undefined && facts.expiresAt <= facts.now) return 'capped'
  return 'sleeping'
}

/** Why a read that may not wake the sandbox (the Git panel, a diff) can't run now, in the status's own words. */
export function sandboxNotRunningReason(name: string, status: CloudStatus): string {
  switch (status) {
    case 'creating':
      return `${name}’s sandbox is still being created.`
    case 'waking':
      return `${name}’s sandbox is waking.`
    case 'unresponsive':
      return `${name}’s sandbox is unresponsive; Restart it.`
    case 'capped':
      return `${name}’s sandbox stopped at the session limit; Continue or Wake it.`
    case 'failed':
      return `${name}’s sandbox failed; Restart it.`
    case 'gone':
      return `${name}’s sandbox no longer exists`
    case 'archived':
      return `${name} is archived. Restore it first.`
    default:
      return `${name}’s sandbox is asleep. Wake it to see this.`
  }
}

/** Statuses that hold one of the plan's concurrent slots. */
export function holdsSlot(status: CloudStatus): boolean {
  return status === 'running' || status === 'waking' || status === 'creating'
}

export function usageMonth(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** What one stop receipt says about the session: Active CPU, and its length and size when the provider reports them. */
export interface UsageReceipt {
  activeCpuMs?: number
  durationMs?: number
  vcpus?: number
}

/** Provisioned memory for one session in GB-hours (vCPUs × 2 GB × hours); undefined without its length and size. */
export function receiptGbHours(receipt: UsageReceipt): number | undefined {
  if (receipt.durationMs === undefined || !receipt.vcpus) return undefined
  return (receipt.vcpus * GB_PER_VCPU * receipt.durationMs) / HOUR
}

/** Add one stop receipt to the month's usage, starting over in a new month. Memory is counted only from receipts that carry it. */
export function addUsage(usage: CloudUsage | undefined, receipt: UsageReceipt, at: number): CloudUsage {
  const month = usageMonth(at)
  const base: CloudUsage = usage && usage.month === month ? usage : { month, activeCpuMs: 0, stops: 0 }
  const gbHours = receiptGbHours(receipt)
  const memory = gbHours === undefined ? base.memoryGbHours : (base.memoryGbHours ?? 0) + gbHours
  return { month, activeCpuMs: base.activeCpuMs + (receipt.activeCpuMs ?? 0), stops: base.stops + 1, ...(memory !== undefined ? { memoryGbHours: memory } : {}) }
}

/** An https clone URL for a GitHub remote (ssh or https), without credentials; null for anything else. */
export function githubHttpsUrl(remote: string): string | null {
  const slug = githubSlug(remote)
  return slug ? `https://github.com/${slug}.git` : null
}

/**
 * Text that may carry a secret (a build log, an error from a clone) with the given secrets and any URL's
 * user:password part replaced by ***. Short values are left alone: they would match ordinary text.
 */
export function redactSecrets(text: string, secrets: (string | undefined)[]): string {
  let out = text.replace(/(\w+:\/\/)[^\s/@]+@/g, '$1***@')
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join('***')
  return out
}

/** The last `max` characters of a log, cut at a line start. Kept small: repositories go to the window with every state change. */
export function logTail(log: string, max = 32 * 1024): string {
  if (log.length <= max) return log
  const cut = log.slice(-max)
  const nl = cut.indexOf('\n')
  return nl >= 0 ? cut.slice(nl + 1) : cut
}

// ---- patches from the renderer, checked before they are saved ----

/** The repository cloud fields a patch may set, each checked; anything malformed is refused. */
export function cleanRepoCloudPatch(patch: Partial<Omit<RepoCloud, 'build'>>): Partial<Omit<RepoCloud, 'build'>> {
  const out: Partial<Omit<RepoCloud, 'build'>> = {}
  if (patch.enabled !== undefined) out.enabled = Boolean(patch.enabled)
  if (patch.provider !== undefined) {
    if (!isCloudProviderId(patch.provider)) throw new Error('Unknown sandbox provider')
    out.provider = patch.provider
  }
  if (patch.connectionId !== undefined) {
    // '' goes back to the provider's default connection.
    if (typeof patch.connectionId !== 'string' || patch.connectionId.length > 200) throw new Error('Unknown connection')
    out.connectionId = patch.connectionId
  }
  if (patch.vcpus !== undefined) {
    // Each provider offers its own sizes (capabilities().vcpuOptions); the manager clamps to the plan when it creates.
    if (!Number.isInteger(patch.vcpus) || patch.vcpus < 1 || patch.vcpus > 64) throw new Error('Choose between 1 and 64 vCPUs')
    out.vcpus = patch.vcpus
  }
  if (patch.region !== undefined) {
    // '' for providers without regions (Docker); otherwise the provider's own id (iad1, us, eu).
    if (typeof patch.region !== 'string' || !/^[a-z0-9-]{0,32}$/.test(patch.region)) throw new Error('Unknown region')
    out.region = patch.region
  }
  if (patch.idleMinutes !== undefined) {
    if (!Number.isInteger(patch.idleMinutes) || patch.idleMinutes < 1 || patch.idleMinutes > 24 * 60) throw new Error('Idle minutes must be between 1 and 1440')
    out.idleMinutes = patch.idleMinutes
  }
  if (patch.autoContinue !== undefined) out.autoContinue = Boolean(patch.autoContinue)
  if (patch.installScript !== undefined) {
    if (typeof patch.installScript !== 'string' || patch.installScript.length > 100_000) throw new Error('The install script is too long')
    out.installScript = patch.installScript
  }
  if (patch.maxRunning !== undefined) {
    if (!Number.isInteger(patch.maxRunning) || patch.maxRunning < 1 || patch.maxRunning > 10_000) throw new Error('The running limit must be at least 1')
    out.maxRunning = patch.maxRunning
  }
  return out
}

/** Personal cloud settings after a patch, each field checked. */
export function patchCloudSettings(current: Pick<Settings, 'claudeAuth' | 'cloud'>, patch: Partial<CloudSettings> | undefined): CloudSettings {
  const next = { ...cloudSettings(current), ...patch }
  if (next.claudeAuth !== 'setup-token' && next.claudeAuth !== 'api-key') throw new Error('Unknown Claude sign-in for the cloud')
  if (!Number.isInteger(next.maxRunning) || next.maxRunning < 1 || next.maxRunning > 10_000) throw new Error('The running limit must be at least 1')
  return {
    enabled: Boolean(next.enabled),
    claudeAuth: next.claudeAuth,
    stopOrphansOnLaunch: Boolean(next.stopOrphansOnLaunch),
    deleteSnapshotsOnForget: Boolean(next.deleteSnapshotsOnForget),
    maxRunning: next.maxRunning,
    wakeOnOpen: next.wakeOnOpen !== false
  }
}

// ---- agents in the sandbox (phase 2) ----

/** Agents that can run inside a sandbox: Claude Code, Codex, OpenCode and the ACP (Chat) catalog agents. Not Cursor. */
export function cloudAgentSupported(agent: string): boolean {
  if (agent === 'claude' || agent === 'codex' || agent === 'opencode') return true
  return catalogAgent(agent)?.level === 'chat'
}

/** Why an agent can't take a turn in a cloud workspace. */
export function cloudAgentRefusal(agent: string): string {
  if (agent === 'cursor') return 'Cursor can’t run in a cloud workspace yet: its SDK runs the agent on this computer. Switch this chat to Claude Code, Codex or OpenCode.'
  return `${catalogAgent(agent)?.name ?? agent} can’t run in a cloud workspace. Switch this chat to Claude Code, Codex or OpenCode.`
}

/** What Foreman sends to pick a turn up again after the sandbox's session hit the plan's limit. */
export const CLOUD_CONTINUE_PROMPT = 'Continue where you left off; the sandbox restarted at the plan’s session limit.'

/** "45-minute", "24-hour": a session cap as the chat says it. */
export function sessionCapLabel(maxSessionMs: number): string {
  const minutes = Math.round(maxSessionMs / MINUTE)
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`
}

/** The turn's end when the session ran out mid-turn. */
export function sessionCapReason(maxSessionMs: number): string {
  return `The sandbox reached the plan’s ${sessionCapLabel(maxSessionMs)} session limit and stopped, so this turn was cut off. Its files are kept; Continue picks the conversation up in a new session.`
}
