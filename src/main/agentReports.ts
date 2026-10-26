// #2 Agent reports. Gives each agent turn its identity (session, turn and a token
// made from them), records what agents report with `foreman report` / `review` or
// Foreman's own MCP tool, and decides what "Teach agents Foreman" adds to a chat.
// Reports are kept on the workspace in foreman.db; nothing is written into the repo.
// The token is attribution, not a security boundary: an agent can leave it out, and
// a call without one simply counts for the workspace instead of a tab.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  answerReports,
  cleanLink,
  cleanReportText,
  closeReport,
  isBlocker,
  recordReport,
  reportLine,
  teachText,
  TURN_ENV,
  type AgentReport,
  type ReportKind,
  type TeachText,
  type TurnCaller
} from '../shared/agentReports'
import type { ChatItem, NotifyKind, RepoSettings, Session, Settings, Workspace } from '../shared/types'
import { mainT } from './i18n'

/** What the chat code asks of reports (see sessions.ts). */
export interface TurnReports {
  // FOREMAN_SESSION_ID, FOREMAN_TURN_ID and FOREMAN_TURN_TOKEN for one turn's environment.
  turnEnv(sessionId: string, turnId: string): Record<string, string>
  // What "Teach agents Foreman" adds to this chat's system prompt, or null. Fixes `session.foremanTaught` at the first message.
  teach(session: Session, ws: Workspace, firstMessage: boolean): TeachText | null
  // A report from Foreman's MCP tool in that turn. Returns the answer for the agent.
  fromTurn(sessionId: string, turnId: string, kind: ReportKind | 'review', text: string, link?: string, at?: string): string
  // The user sent a message in this tab: its open blockers are answered.
  replied(sessionId: string): void
}

export interface AgentReportDeps {
  state(): { workspaces: Workspace[]; sessions: Session[]; settings?: Pick<Settings, 'language'> }
  // Append an item to a chat (saved) and show it.
  emit(sessionId: string, item: ChatItem): void
  changed(): void
  settingsFor(repoId: string): Partial<Pick<RepoSettings, 'teachAgents' | 'agentsMayStart' | 'checksAfterTurn'>>
  // The key turn tokens are made with. Kept in the vault, so a kept turn's token still checks after a restart.
  key(): string
  // Whether the `foreman` command is installed (a cached answer; it's slow to ask on Windows).
  cliInstalled(): boolean
  // An OS notification for a needs-input or stuck report.
  notify?(workspaceId: string, sessionId: string, title: string, body: string, kind?: NotifyKind): void
  now?(): string
}

/** Who a call came from, once its token is checked. */
export type CallerIdentity =
  | { kind: 'turn'; session: Session; ws: Workspace; turnId: string; live: boolean }
  // A token that doesn't check: the call counts for the workspace only, and says so.
  | { kind: 'bad-token' }

export interface RecordInput {
  workspaceId: string
  sessionId?: string
  turnId?: string
  kind: ReportKind | 'review'
  text: string
  link?: string
  via: AgentReport['via']
  late?: boolean
  badToken?: boolean
  at?: string
}

/** A fresh key for turn tokens. */
export function newTurnKey(): string {
  return randomBytes(32).toString('base64url')
}

/** The token for one turn: an HMAC of its session and turn ids, so it can be checked without storing anything. */
export function turnToken(key: string, sessionId: string, turnId: string): string {
  return createHmac('sha256', key).update(`${sessionId}\n${turnId}`).digest('base64url')
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export class AgentReportService implements TurnReports {
  constructor(private deps: AgentReportDeps) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString()
  }

  turnEnv(sessionId: string, turnId: string): Record<string, string> {
    return { [TURN_ENV.session]: sessionId, [TURN_ENV.turn]: turnId, [TURN_ENV.token]: turnToken(this.deps.key(), sessionId, turnId) }
  }

  /** Check a caller's token. Null: the call carried none. */
  identify(caller: TurnCaller | undefined): CallerIdentity | null {
    if (!caller?.token) return null
    const { sessionId, turnId, token } = caller
    if (!sessionId || !turnId || !sameToken(token, turnToken(this.deps.key(), sessionId, turnId))) return { kind: 'bad-token' }
    const { sessions, workspaces } = this.deps.state()
    const session = sessions.find((s) => s.id === sessionId)
    const ws = session && workspaces.find((w) => w.id === session.workspaceId)
    if (!session || !ws) return { kind: 'bad-token' }
    return { kind: 'turn', session, ws, turnId, live: session.turnId === turnId }
  }

  /** Whether this repo lets agents use `foreman run` and `foreman send`. */
  mayStart(repoId: string): boolean {
    return this.deps.settingsFor(repoId).agentsMayStart === true
  }

  record(input: RecordInput): { report: AgentReport; added: boolean } {
    const ws = this.deps.state().workspaces.find((w) => w.id === input.workspaceId)
    if (!ws) throw new Error('That workspace is gone')
    const report: AgentReport = {
      id: randomUUID(),
      kind: input.kind,
      text: cleanReportText(input.text),
      at: input.at ?? this.now(),
      workspaceId: ws.id,
      via: input.via,
      ...(cleanLink(input.link) ? { link: cleanLink(input.link) } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.late ? { late: true } : {}),
      ...(input.badToken ? { badToken: true } : {})
    }
    if (!report.text && input.kind !== 'done' && input.kind !== 'checkpoint') throw new Error('Say what you need in a few words.')
    const { list, added } = recordReport(ws.agentReports, report)
    if (!added) return { report, added }
    ws.agentReports = list
    // The quiet marker (or needs-input card) goes in the tab's chat; a report without a tab has no chat to go to.
    if (report.sessionId) {
      this.deps.emit(report.sessionId, {
        kind: 'notice',
        id: `report:${report.id}`,
        turnId: report.turnId,
        level: 'info',
        text: reportLine(report),
        report: { id: report.id, kind: report.kind, text: report.text, link: report.link, at: report.at, via: report.via, late: report.late }
      })
    }
    this.deps.changed()
    if (isBlocker(report.kind) && !report.late) {
      const session = report.sessionId ? this.deps.state().sessions.find((s) => s.id === report.sessionId) : undefined
      const t = mainT(this.deps.state().settings)
      const stuck = report.kind === 'stuck'
      const body = report.text ? t(stuck ? 'notify.report.stuckText' : 'notify.report.needsInputText', { text: report.text }) : t(stuck ? 'notify.report.stuck' : 'notify.report.needsInput')
      this.deps.notify?.(ws.id, report.sessionId ?? '', session?.title ? `${ws.name} · ${session.title}` : ws.name, body, 'attention')
    }
    return { report, added }
  }

  fromTurn(sessionId: string, turnId: string, kind: ReportKind | 'review', text: string, link?: string, at?: string): string {
    const session = this.deps.state().sessions.find((s) => s.id === sessionId)
    if (!session) return 'Foreman couldn’t find this chat any more; nothing was recorded.'
    try {
      const { added } = this.record({ workspaceId: session.workspaceId, sessionId, turnId, kind, text, link, via: 'mcp', late: session.turnId !== turnId, at })
      if (!added) return 'Already reported; nothing changed.'
      if (kind === 'review') return 'Noted. Foreman added "asks for a review" to the user\'s Home; nothing starts until they open it.'
      return isBlocker(kind) ? 'Noted. The user sees this on Home as "agent says" until they reply in this tab.' : 'Noted.'
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  replied(sessionId: string): void {
    const session = this.deps.state().sessions.find((s) => s.id === sessionId)
    const ws = session && this.deps.state().workspaces.find((w) => w.id === session.workspaceId)
    if (!ws?.agentReports?.length) return
    const { list, changed } = answerReports(ws.agentReports, sessionId, this.now())
    if (!changed) return
    ws.agentReports = list
    this.deps.changed()
  }

  close(workspaceId: string, reportId: string, how: 'dismissed' | 'opened'): void {
    const ws = this.deps.state().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return
    const { list, changed } = closeReport(ws.agentReports, reportId, how, this.now())
    if (!changed) return
    ws.agentReports = list
    this.deps.changed()
  }

  teach(session: Session, ws: Workspace, firstMessage: boolean): TeachText | null {
    const settings = this.deps.settingsFor(ws.repoId)
    // Fixed when the chat starts: turning the setting on or off later only changes new chats. Older chats count as started without it.
    if (session.foremanTaught === undefined) session.foremanTaught = firstMessage ? settings.teachAgents === true : false
    if (!session.foremanTaught) return null
    const taught = teachText({ agent: session.agent, cli: this.deps.cliInstalled(), mayStart: settings.agentsMayStart === true, checksAfterTurn: settings.checksAfterTurn === true })
    return taught.text ? taught : null
  }
}
