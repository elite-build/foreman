// Slack notification rules. PR observations become events
// (the first look at a PR is a baseline, never an event), events meet the user's rules for the
// repository's resolved Slack connection, and each rule makes one delivery per recipient and
// occurrence. Messages to anyone but the user wait for Send or Skip unless the rule was consented
// to as it is now. A delivery is recorded before it's sent, so it goes at most once; a timeout
// after sending is "uncertain" and never resent by itself.
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_TEMPLATES,
  occurrenceKey,
  renderTemplate,
  resolveIntegration,
  ruleAppliesTo,
  ruleFingerprint,
  sendsWithoutAsking,
  type Connection,
  type SlackDelivery,
  type SlackEvent,
  type SlackRule,
  type TemplateField
} from '../shared/integrations'
import type { PullRequestInfo, Repo, Workspace } from '../shared/types'
import type { Integrations } from './integrations'
import { isAuthError, slackPost, SlackError } from './slack'

type Fetch = typeof fetch

export interface DeliveryStore {
  addDelivery(d: SlackDelivery): boolean
  putDelivery(d: SlackDelivery): void
  readDeliveries(limit?: number): SlackDelivery[]
  openDeliveries(): SlackDelivery[]
  pruneDeliveries(keep?: number): void
  getMeta(key: string): string | undefined
  setMeta(key: string, value: string): void
}

export interface SlackRulesDeps {
  integrations: Integrations
  db: () => DeliveryStore
  repo: (id: string) => Repo | undefined
  // The login a repository's GitHub connection is, for "my PR" (undefined when unknown).
  githubLogin: (repoId: string) => Promise<string | undefined>
  // Idle for five minutes, or the screen is locked.
  away: () => boolean
  // A desktop notification for an Ask first card.
  notify: (n: { workspaceId: string; title: string; body: string }) => void
  changed: () => void
  fetch?: Fetch
  now?: () => number
  // Waits before retrying after Slack's 429 (seconds); replaceable in tests.
  sleep?: (seconds: number) => Promise<void>
  validateReviewer?: (repoId: string, pr: number, reviewer: string, url?: string) => Promise<boolean>
}

interface PrBaseline {
  state: PullRequestInfo['state']
  draft: boolean
  readyCount: number
  reviewers: Set<string>
  reviews: Set<string>
  failedSha?: string
}

interface EventContext {
  repoId: string
  workspaceId?: string
  title: string
  url?: string
  values: Partial<Record<TemplateField, string | number>>
  facts: Parameters<typeof occurrenceKey>[1]
  // review-requested: the GitHub login (or team) the event is about.
  reviewer?: { login?: string; team?: string }
}

const MAX_RETRIES = 3

export class SlackRules {
  private baselines = new Map<string, PrBaseline>()
  // Workspaces last seen without a pull request: a PR appearing there is new, not a baseline.
  private withoutPr = new Set<string>()

  constructor(private deps: SlackRulesDeps) {}

  private now(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString()
  }

  /** After a restart: deliveries that were being sent may or may not have reached Slack. */
  recover(): void {
    for (const d of this.deps.db().openDeliveries()) {
      if (d.status !== 'queued') continue
      this.deps.db().putDelivery({ ...d, status: 'uncertain', error: 'Foreman closed while sending this message.' })
    }
  }

  /** Whether any rule could fire, so callers can skip work (looking up new PRs) when none would. */
  hasRules(): boolean {
    return this.deps.integrations.state().rules.some((r) => r.enabled)
  }

  trackedPrs(repoId: string): number[] {
    return [...this.baselines.keys()].filter((key) => key.startsWith(`${repoId}:`)).map((key) => Number(key.slice(repoId.length + 1)))
  }

  // ---- events ----

  /** A pull request lookup for a workspace answered. */
  /**
   * `firstForWorkspace`: Foreman knew no PR for this workspace before (and it didn't start from one).
   * A PR seen that way counts as just opened only if GitHub says it was made in the last half hour,
   * so the first look after an upgrade or a restart never messages anyone about an old PR.
   */
  async prObserved(ws: Workspace, pr: PullRequestInfo | null, headSha?: string, firstForWorkspace = false): Promise<void> {
    if (!pr) {
      this.withoutPr.add(ws.id)
      return
    }
    if (pr.provider === 'gitlab') return
    const key = `${ws.repoId}:${pr.number}`
    const before = this.baselines.get(key)
    const recent = pr.createdAt ? (this.deps.now?.() ?? Date.now()) - Date.parse(pr.createdAt) < 30 * 60_000 : false
    const appeared = this.withoutPr.delete(ws.id) || (firstForWorkspace && !before && recent)
    const reviewers = new Set((pr.reviewRequests ?? []).map((r) => (r.login ? r.login.toLowerCase() : `team:${r.team}`)))
    const failing = pr.checks.some((c) => c.state === 'failure')
    const counterKey = `slack-ready:${key}`
    const storedCount = Number(this.deps.db().getMeta(counterKey)) || 0
    const next: PrBaseline = {
      state: pr.state,
      draft: pr.isDraft,
      readyCount: before?.readyCount ?? Math.max(storedCount, pr.isDraft ? 0 : 1),
      reviewers,
      reviews: new Set((pr.reviews ?? []).map((r) => r.id)),
      failedSha: failing ? headSha || before?.failedSha || 'unknown' : undefined
    }
    if (before && before.draft && !pr.isDraft) next.readyCount = before.readyCount + 1
    if (next.readyCount !== storedCount) this.deps.db().setMeta(counterKey, String(next.readyCount))
    this.baselines.set(key, next)
    // The first look is a baseline, unless the PR appeared in a workspace that had none.
    if (!before && !appeared) return
    const mine = await this.isMine(ws.repoId, pr)
    if (!mine) return
    const repo = this.deps.repo(ws.repoId)
    const base = (extra: Partial<Record<TemplateField, string | number>> = {}): EventContext['values'] => ({ 'pr.title': pr.title, 'pr.number': pr.number, 'pr.url': pr.url, repo: repo?.name ?? '', author: pr.author ?? '', workspace: ws.name, ...extra })
    const ctx = (facts: EventContext['facts'], values: EventContext['values'], reviewer?: EventContext['reviewer']): EventContext => ({ repoId: ws.repoId, workspaceId: ws.id, title: `#${pr.number} ${pr.title}`, url: pr.url, values, facts, ...(reviewer ? { reviewer } : {}) })
    const events: [SlackEvent, EventContext][] = []
    const readyNow = !pr.isDraft && pr.state === 'OPEN'
    if (readyNow && (appeared || (before && before.draft))) events.push(['pr-ready', ctx({ repoId: ws.repoId, pr: pr.number, readyCount: next.readyCount }, base())])
    if (pr.state === 'OPEN' && !pr.isDraft) {
      for (const r of pr.reviewRequests ?? []) {
        const id = r.login ? r.login.toLowerCase() : `team:${r.team}`
        if (before?.reviewers.has(id)) continue
        events.push(['review-requested', ctx({ repoId: ws.repoId, pr: pr.number, reviewer: id }, base({ reviewer: r.login ?? r.team ?? '' }), r)])
      }
    }
    if (failing && next.failedSha && next.failedSha !== before?.failedSha) events.push(['ci-failed', ctx({ repoId: ws.repoId, pr: pr.number, sha: next.failedSha }, base())])
    for (const review of pr.reviews ?? []) {
      if (before?.reviews.has(review.id)) continue
      const event: SlackEvent = review.state === 'APPROVED' ? 'pr-approved' : 'changes-requested'
      events.push([event, ctx({ repoId: ws.repoId, pr: pr.number, reviewId: review.id }, base({ reviewer: review.author }))])
    }
    if (pr.state === 'MERGED' && before && before.state !== 'MERGED') events.push(['pr-merged', ctx({ repoId: ws.repoId, pr: pr.number }, base())])
    for (const [event, c] of events) await this.emit(event, c)
  }

  private async isMine(repoId: string, pr: PullRequestInfo): Promise<boolean> {
    if (!pr.author) return false
    const me = await this.deps.githubLogin(repoId).catch(() => undefined)
    return Boolean(me && me.toLowerCase() === pr.author.toLowerCase())
  }

  /** An agent needs the user (approval, question, plan) or finished a turn. */
  async agentEvent(event: 'agent-needs-me' | 'agent-finished', ws: Workspace, input: { turnId: string; agent: string; reason?: string; requestId?: string }): Promise<void> {
    await this.emit(event, {
      repoId: ws.repoId,
      workspaceId: ws.id,
      title: ws.name,
      values: { workspace: ws.name, agent: input.agent, reason: input.reason ?? '' },
      facts: { turnId: input.turnId, requestId: input.requestId }
    })
  }

  // ---- rules → deliveries ----

  private connectionFor(repoId: string): Connection | undefined {
    const repo = this.deps.repo(repoId)
    if (!repo || repo.integrations?.rules === 'off') return undefined
    const r = resolveIntegration(this.deps.integrations.state(), repo, 'slack')
    return r.state === 'ready' ? r.connection : undefined
  }

  async emit(event: SlackEvent, c: EventContext): Promise<void> {
    const connection = this.connectionFor(c.repoId)
    if (!connection) return
    const rules = this.deps.integrations.state().rules.filter((r) => r.enabled && r.event === event && r.connectionId === connection.id && ruleAppliesTo(r, c.repoId))
    for (const rule of rules) {
      if (rule.awayOnly && !this.deps.away()) continue
      await this.deliverRule(rule, connection, event, c)
    }
  }

  private async deliverRule(rule: SlackRule, connection: Connection, event: SlackEvent, c: EventContext): Promise<void> {
    const occurrence = occurrenceKey(event, c.facts)
    const template = rule.template || DEFAULT_TEMPLATES[event]
    const make = (recipientId: string, recipientName: string, values: EventContext['values'], extra: Partial<SlackDelivery> = {}): SlackDelivery => ({
      id: randomUUID(),
      ruleId: rule.id,
      ruleFingerprint: ruleFingerprint(rule),
      occurrence,
      connectionId: connection.id,
      event,
      repoId: c.repoId,
      ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}),
      recipientId,
      recipientName,
      text: renderTemplate(template, values),
      status: sendsWithoutAsking(rule) ? 'queued' : 'asking',
      title: c.title,
      ...(c.url ? { url: c.url } : {}),
      at: this.now(),
      ...extra
    })
    let delivery: SlackDelivery
    if (rule.recipient === 'me') {
      const me = connection.slack?.me
      delivery = me ? make(me.id, me.name, c.values, { status: 'queued' }) : make('', 'you', c.values, { status: 'failed', error: 'Pick who you are in this Slack workspace (Settings → Integrations).' })
    } else if (rule.recipient === 'channel') {
      if (!rule.channel) return
      delivery = make(rule.channel.id, `#${rule.channel.name}`, c.values)
    } else {
      const reviewer = c.reviewer
      if (!reviewer) return
      if (reviewer.team) {
        // Teams are never expanded into everyone in them.
        delivery = make(`team:${reviewer.team}`, `@${reviewer.team}`, c.values, { status: 'skipped', team: true, error: 'Teams aren’t messaged.' })
      } else {
        const login = reviewer.login!
        const link = this.deps.integrations.state().people.find((p) => p.slackTeamId === connection.identity?.orgId && p.githubLogin.toLowerCase() === login.toLowerCase())
        const values = { ...c.values, reviewer: link ? link.slackName.split(' ')[0] : login }
        delivery = link ? make(link.slackUserId, link.slackName, values) : make(`github:${login.toLowerCase()}`, login, values, { status: 'asking', unmatched: login })
      }
    }
    if (!this.deps.db().addDelivery(delivery)) return
    this.deps.changed()
    if (delivery.status === 'queued') await this.send(delivery)
    else if (delivery.status === 'asking') {
      this.deps.notify({
        workspaceId: delivery.workspaceId ?? '',
        title: delivery.unmatched ? `No Slack match for ${delivery.unmatched}` : `Message ${delivery.recipientName} on Slack?`,
        body: delivery.title
      })
    }
  }

  // ---- sending ----

  private update(d: SlackDelivery, patch: Partial<SlackDelivery>): SlackDelivery {
    const next = { ...d, ...patch }
    this.deps.db().putDelivery(next)
    this.deps.changed()
    return next
  }

  private async send(d: SlackDelivery, attempt = 0): Promise<SlackDelivery> {
    const token = this.deps.integrations.secret(d.connectionId)
    const connection = this.deps.integrations.connection(d.connectionId)
    // The connection it was made for, or nothing: never re-resolved to another workspace.
    if (!token || !connection) return this.update(d, { status: 'failed', error: 'The Slack connection this message was for was removed.' })
    if (connection.problem) return this.update(d, { status: 'failed', error: connection.problem })
    if (d.repoId && this.connectionFor(d.repoId)?.id !== d.connectionId) return this.update(d, { status: 'skipped', error: 'Slack changed or rules were turned off for this repository.' })
    const rule = this.deps.integrations.state().rules.find((r) => r.id === d.ruleId)
    if (!rule?.enabled) return this.update(d, { status: 'skipped', error: 'This rule is no longer enabled.' })
    if (d.repoId && !ruleAppliesTo(rule, d.repoId)) return this.update(d, { status: 'skipped', error: 'This rule no longer applies to this repository.' })
    if (!d.approved && (d.ruleFingerprint !== ruleFingerprint(rule) || !sendsWithoutAsking(rule))) {
      return this.update(d, { status: 'asking', error: 'This rule changed while the message was waiting. Review it before sending.' })
    }
    if (rule.recipient === 'channel' && !connection.slack?.destinations.some((dest) => dest.id === d.recipientId)) return this.update(d, { status: 'failed', error: 'This channel is no longer allowed by the Slack connection.' })
    try {
      const posted = await slackPost(token, d.recipientId, d.text, this.deps.fetch)
      return this.update(d, { status: 'sent', sentAt: this.now(), ts: posted.ts, error: undefined })
    } catch (err) {
      if (err instanceof SlackError && err.code === 'ratelimited' && attempt < MAX_RETRIES) {
        await (this.deps.sleep ?? ((s) => new Promise((r) => setTimeout(r, s * 1000))))(err.retryAfter ?? 30)
        return this.send(d, attempt + 1)
      }
      if (isAuthError(err)) this.deps.integrations.markProblem(d.connectionId, (err as Error).message)
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof SlackError && err.uncertain) return this.update(d, { status: 'uncertain', error: 'Slack didn’t answer after the message was sent; it may have arrived.' })
      return this.update(d, { status: 'failed', error: message })
    }
  }

  // ---- the user's answers ----

  /** Ask first cards, for Home: waiting for Send or Skip. */
  asks(): SlackDelivery[] {
    try {
      return this.deps.db().openDeliveries().filter((d) => d.status === 'asking')
    } catch {
      return []
    }
  }

  list(connectionId?: string): SlackDelivery[] {
    const all = this.deps.db().readDeliveries(200)
    return connectionId ? all.filter((d) => d.connectionId === connectionId) : all
  }

  private find(id: string): SlackDelivery {
    const d = this.deps.db().readDeliveries(1000).find((x) => x.id === id)
    if (!d) throw new Error('That message is no longer here')
    return d
  }

  /**
   * Send or Skip on an Ask first card. Before sending, a reviewer request is checked again: the PR
   * must still be open and the person still asked to review. `text` is the user's own edit.
   */
  async answer(id: string, action: 'send' | 'skip', text?: string): Promise<void> {
    let d = this.find(id)
    if (d.status !== 'asking') return
    if (action === 'skip') {
      this.update(d, { status: 'skipped' })
      return
    }
    if (d.unmatched) {
      // Matched since the card was made (People): send to them now.
      const connection = this.deps.integrations.connection(d.connectionId)
      const link = this.deps.integrations.state().people.find((p) => p.slackTeamId === connection?.identity?.orgId && p.githubLogin.toLowerCase() === d.unmatched!.toLowerCase())
      if (!link) throw new Error(`Match ${d.unmatched} to a Slack person first.`)
      d = { ...d, recipientId: link.slackUserId, recipientName: link.slackName, unmatched: undefined }
    }
    if (d.event === 'review-requested') {
      const [, repoId, pr, reviewer] = d.occurrence.split(':')
      const b = this.baselines.get(`${repoId}:${pr}`)
      const current = this.deps.validateReviewer ? await this.deps.validateReviewer(repoId, Number(pr), reviewer, d.url) : Boolean(b && b.state === 'OPEN' && b.reviewers.has(reviewer))
      if (!current) {
        this.update(d, { status: 'skipped', error: 'No longer asked to review, or the PR closed.' })
        throw new Error('They’re no longer asked to review this PR, so nothing was sent.')
      }
    }
    // Another Send click may have won while the fresh PR lookup was in flight.
    if (this.find(id).status !== 'asking') return
    const queued = this.update(d, { status: 'queued', approved: true, ...(text?.trim() ? { text: text.trim() } : {}) })
    const sent = await this.send(queued)
    if (sent.status !== 'sent') throw new Error(sent.error ?? 'Slack did not confirm delivery. Check the delivery log before sending again.')
  }

  /** Send again: a failed message, or an uncertain one the user checked didn't arrive. */
  async resend(id: string): Promise<void> {
    const d = this.find(id)
    if (d.status !== 'failed' && d.status !== 'uncertain') return
    const sent = await this.send(this.update(d, { status: 'queued', approved: true, error: undefined }))
    if (sent.status !== 'sent') throw new Error(sent.error ?? 'Slack did not confirm delivery. Check the delivery log before sending again.')
  }
}
