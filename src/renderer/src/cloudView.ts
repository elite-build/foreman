// Remote ("cloud") workspaces in the window: which
// provider and connection a repository uses, whether it can offer Remote, how a sandbox's status reads, and
// this month's usage against the plan. Pure, so the rules are tested without a DOM; the components only render them.
import {
  cloudProvider,
  cloudSettings,
  holdsSlot,
  planAllowances,
  planLimits,
  repoCloud,
  repoProvider,
  type CloudProviderId,
  type PlanLimits,
  type ProviderCapabilities,
  type VercelPlan
} from '../../shared/cloud'
import { sandboxServiceFor, type ConnectionView } from '../../shared/integrations'
import type { CloudProviderView, CloudStatus, CloudUsage, Repo, Settings, Workspace } from '../../shared/types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Regions Vercel Sandbox runs in, as offered on a repository's Cloud tab (the city names are i18n keys). */
export const CLOUD_REGIONS = ['iad1', 'sfo1', 'cle1', 'fra1', 'hnd1'] as const
export type CloudRegion = (typeof CLOUD_REGIONS)[number]

/** Memory follows the CPU count on Vercel (2 GB per vCPU); other providers say their own. */
export const memoryGb = (vcpus: number): number => vcpus * 2

/** The defaults map main keeps, rebuilt from the views' isDefault flags. */
function defaultsOf(connections: ConnectionView[]): Partial<Record<string, string>> {
  return Object.fromEntries(connections.filter((c) => c.isDefault).map((c) => [c.service, c.id]))
}

/** The provider a repository's remote workspaces use (as main's SandboxManager.providerId). */
export function repoProviderId(repo: Pick<Repo, 'cloud'>, connections: ConnectionView[]): CloudProviderId {
  return repoProvider(repo.cloud, defaultsOf(connections))
}

/** A provider's connection: the one chosen by id, else its service's default (as main's Integrations.sandboxConnection). */
export function sandboxConnection(connections: ConnectionView[], provider: CloudProviderId, connectionId?: string): ConnectionView | undefined {
  const service = sandboxServiceFor(provider)
  return connections.find((c) => c.service === service && (connectionId ? c.id === connectionId : c.isDefault))
}

/** What a provider allows and can do: main's answer when there is one (cloudPreflight), else shared/cloud.ts's defaults. */
export function providerFacts(id: CloudProviderId, view?: CloudProviderView | null): { limits: PlanLimits; capabilities: ProviderCapabilities } {
  if (view && view.id === id) return { limits: view.limits, capabilities: view.capabilities }
  const info = cloudProvider(id)
  return { limits: info.limits, capabilities: info.capabilities }
}

/** The Vercel connection cloud workspaces use: the default one (the first one added becomes it), like main's Integrations.vercel(). */
export function vercelConnection(connections: ConnectionView[]): ConnectionView | undefined {
  return connections.find((c) => c.service === 'vercel' && c.isDefault)
}

/** The plan's limits as the connection last reported them; Hobby's when unknown. */
export function connectionLimits(c: ConnectionView | undefined): PlanLimits {
  return c?.vercel?.limits ?? planLimits(c?.vercel?.plan)
}

export function connectionPlan(c: ConnectionView | undefined): VercelPlan {
  return c?.vercel?.plan ?? 'hobby'
}

/** Remote workspaces that hold one of the plan's slots now (running, waking or being made), on one provider or all. */
export function runningCloud(workspaces: Workspace[], provider?: CloudProviderId): Workspace[] {
  return workspaces.filter((w) => w.cloud && w.state !== 'archived' && holdsSlot(w.cloud.status) && (!provider || w.cloud.provider === provider))
}

/** How many may run at once across the app: Settings' soft limit, never above the plan's concurrency. */
export function cloudCap(settings: Pick<Settings, 'claudeAuth' | 'cloud'>, limits: PlanLimits): number {
  return Math.min(cloudSettings(settings).maxRunning, limits.maxConcurrent)
}

/** The plan's concurrency is worth showing as "N of M" only when it's a real ceiling (Hobby's 10, not Pro's thousands). */
export const showsConcurrency = (limits: PlanLimits): boolean => limits.maxConcurrent <= 100

/**
 * Why a repository can't make a remote workspace now, first reason first; undefined when it can.
 * `flag`: the experimental switch is off; `repo`: the repository's Remote setting is off; `soon`: its provider isn't
 * implemented yet; `connection`: no connection for the provider; `connection-problem`: it needs attention;
 * `no-build`, `building`, `build-failed`: its base (only providers that keep one); `limit`: as many sandboxes run as
 * the soft limit allows.
 */
export type CloudBlock = 'flag' | 'repo' | 'soon' | 'connection' | 'connection-problem' | 'no-build' | 'building' | 'build-failed' | 'limit'

export interface CloudReadiness {
  // The Local / Cloud choice is shown at all (the switch and the repository's setting are on).
  offer: boolean
  block?: CloudBlock
  // At the limit: the sandboxes holding the slots that count against it.
  running: Workspace[]
  cap: number
  // Which limit was reached: the app's or the repository's own.
  capScope?: 'app' | 'repo'
  // The repository's provider, and the connection it would use.
  provider: CloudProviderId
  connection?: ConnectionView
}

/**
 * `provider`: main's view of the repository's provider (Api.cloudPreflight), for its limits and capabilities; without
 * it, shared/cloud.ts's defaults stand in until it arrives.
 */
export function cloudReadiness(input: { settings: Pick<Settings, 'claudeAuth' | 'cloud'>; repo: Repo; connections: ConnectionView[]; workspaces: Workspace[]; provider?: CloudProviderView | null }): CloudReadiness {
  const { settings, repo } = input
  const ownSettings = repoCloud(repo)
  const id = repoProviderId(repo, input.connections)
  const connection = sandboxConnection(input.connections, id, ownSettings.connectionId || undefined)
  const { limits, capabilities } = providerFacts(id, input.provider)
  const all = runningCloud(input.workspaces)
  const onProvider = all.filter((w) => w.cloud!.provider === id)
  const appCap = cloudSettings(settings).maxRunning
  const cap = cloudCap(settings, limits)
  const base = { running: onProvider, cap, provider: id, ...(connection ? { connection } : {}) }
  if (!cloudSettings(settings).enabled) return { ...base, offer: false, block: 'flag' }
  if (!ownSettings.enabled) return { ...base, offer: false, block: 'repo' }
  const offer = { ...base, offer: true }
  if (!cloudProvider(id).implemented) return { ...offer, block: 'soon' }
  if (!connection) return { ...offer, block: 'connection' }
  if (connection.problem) return { ...offer, block: 'connection-problem' }
  if (capabilities.base) {
    const build = ownSettings.build
    // A base built on another provider (or connection) is no base here.
    if (!build || (build.provider ?? 'vercel') !== id || (build.connectionId ?? '') !== (ownSettings.connectionId ?? '')) return { ...offer, block: 'no-build' }
    if (build.status === 'building') return { ...offer, block: 'building' }
    if (build.status === 'failed') return { ...offer, block: 'build-failed' }
  }
  if (onProvider.length >= cap) return { ...offer, block: 'limit', capScope: 'app' }
  if (all.length >= appCap) return { ...offer, block: 'limit', running: all, cap: appCap, capScope: 'app' }
  const inRepo = all.filter((w) => w.repoId === repo.id)
  if (inRepo.length >= ownSettings.maxRunning) return { ...offer, block: 'limit', running: inRepo, cap: ownSettings.maxRunning, capScope: 'repo' }
  return offer
}

/** The caveat for short sessions (Vercel Hobby's 45 minutes, E2B Hobby's hour): only providers with a cap under 2 h. */
export const shortSessionsFor = (capabilities: Pick<ProviderCapabilities, 'sessionCap'>, limits: PlanLimits): boolean => capabilities.sessionCap && shortSessions(limits)

/** Blocks that stop the Cloud choice from being picked at all (the limit only stops the submit, with a way out). */
export const blocksChoice = (block: CloudBlock | undefined): boolean => block !== undefined && block !== 'limit'

/** How a sandbox's status reads in the sidebar and header (an i18n key suffix). */
export type CloudStatusWord = 'working' | 'awake' | 'asleep' | 'waking' | 'starting' | 'capped' | 'unresponsive' | 'failed' | 'gone' | 'archived'

export function cloudStatusWord(status: CloudStatus, turnRunning: boolean): CloudStatusWord {
  switch (status) {
    case 'running':
      return turnRunning ? 'working' : 'awake'
    case 'sleeping':
      return 'asleep'
    case 'creating':
      return 'starting'
    default:
      return status
  }
}

/** The tone of the Status beside it; '' is the plain grey one. */
export function cloudDot(status: CloudStatus): '' | 'green' | 'amber' | 'red' | 'blue' {
  switch (status) {
    case 'running':
      return 'green'
    case 'waking':
    case 'creating':
      return 'blue'
    case 'capped':
      return 'amber'
    case 'unresponsive':
    case 'failed':
    case 'gone':
      return 'red'
    default:
      return ''
  }
}

/** Whole minutes left in the sandbox's session, or undefined when unknown or over. */
export function minutesLeft(expiresAt: string | undefined, now: number): number | undefined {
  if (!expiresAt) return undefined
  const left = Date.parse(expiresAt) - now
  return Number.isFinite(left) && left > 0 ? Math.ceil(left / MINUTE) : undefined
}

/** A session cap as minutes (Hobby's 45) or whole hours (Pro's 24), for "Sessions up to …" and the caveats. */
export function sessionCap(limits: PlanLimits): { minutes: number; hours?: undefined } | { hours: number; minutes?: undefined } {
  const minutes = Math.round(limits.maxSessionMs / MINUTE)
  return minutes >= 60 && minutes % 60 === 0 ? { hours: minutes / 60 } : { minutes }
}

/** Hobby's honest caveat: an unattended run can't outlast one short session. */
export const shortSessions = (limits: PlanLimits): boolean => limits.maxSessionMs < 2 * HOUR

// ---- Claude's setup token ----

// `claude setup-token` tokens last about a year; Foreman only knows when one was saved here.
export const SETUP_TOKEN_LIFETIME_MS = 365 * DAY
const EXPIRING_MS = 14 * DAY

export type SetupTokenState = 'missing' | 'ok' | 'expiring' | 'expired'

export function setupTokenState(token: { savedAt?: string } | null | undefined, now: number): SetupTokenState {
  if (!token) return 'missing'
  const expires = setupTokenExpiry(token.savedAt)
  if (expires === undefined) return 'ok'
  const left = expires - now
  return left <= 0 ? 'expired' : left <= EXPIRING_MS ? 'expiring' : 'ok'
}

export function setupTokenExpiry(savedAt: string | undefined): number | undefined {
  const saved = savedAt ? Date.parse(savedAt) : NaN
  return Number.isFinite(saved) ? saved + SETUP_TOKEN_LIFETIME_MS : undefined
}

// ---- this month's usage ----

// The plan's monthly allowances come from shared/cloud.ts planAllowances (Hobby's 5 CPU-hours and 420 GB-hours;
// Pro bills past its credit, so there's no ceiling to draw a bar against).

export interface UsageBar {
  // Hours of active CPU or GB-hours rounded to one decimal, or a count; `of` is the allowance when there is one.
  used: number
  of?: number
  // 0–1, for the bar's width; undefined without an allowance.
  fraction?: number
}

const hours = (ms: number): number => Math.round((ms / HOUR) * 10) / 10

/** `plan`: Vercel's, for its allowances; null for a provider without monthly allowances. */
export function cpuUsageBar(usage: CloudUsage | null | undefined, plan: VercelPlan | null): UsageBar {
  const ms = usage?.activeCpuMs ?? 0
  const allowance = plan ? planAllowances(plan).activeCpuMs : undefined
  if (allowance === undefined) return { used: hours(ms) }
  return { used: hours(ms), of: hours(allowance), fraction: Math.min(1, ms / allowance) }
}

/**
 * Provisioned memory (GB-hours) from the stop receipts that carried a session's length and size; null when stops were
 * recorded but none of them did, so the page says it can't count it rather than showing 0.
 */
export function memoryUsageBar(usage: CloudUsage | null | undefined, plan: VercelPlan | null): UsageBar | null {
  if (usage?.memoryGbHours === undefined && (usage?.stops ?? 0) > 0) return null
  const used = Math.round((usage?.memoryGbHours ?? 0) * 10) / 10
  const allowance = plan ? planAllowances(plan).memoryGbHours : undefined
  if (allowance === undefined) return { used }
  return { used, of: allowance, fraction: Math.min(1, (usage?.memoryGbHours ?? 0) / allowance) }
}

export function countBar(count: number, of: number): UsageBar {
  return { used: count, of, fraction: of > 0 ? Math.min(1, count / of) : undefined }
}

/** The tone a bar takes: amber from 80%, red when full. */
export function barTone(fraction: number | undefined): 'green' | 'amber' | 'red' {
  if (fraction === undefined || fraction < 0.8) return 'green'
  return fraction >= 1 ? 'red' : 'amber'
}

/** When this month's figures start over: the first of next month, local time. */
export function usageResetsAt(now: number): Date {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth() + 1, 1)
}
