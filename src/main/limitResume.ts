// #11 Usage-limit resume. When a turn stopped at a plan limit and said when the limit resets (Claude's result error or
// rate-limit event, Codex's rate-limit windows), the recovery card offers one resume at that time, unticked; ticking it arms it
// here. With Settings → Usage → "Resume by itself" (the default, docs/agents.md 7.2) Foreman arms it with no click, for a
// reset time it knows; an unknown time is always an offer, and nothing retries blindly.
// A timer, not a daemon (like schedules.ts). The rules, in the order they matter:
//  - armed by the human, or by Foreman for a known reset time under "Resume by itself", for the tab's latest turn, at most
//    one per tab, and on disk before it can send;
//  - it carries how the stopped turn was started (a flow step's persona, write scope and read-only hold, a schedule run's
//    unattended flag), and the send path restores them, so a resume never loses what the turn was held to;
//  - it is removed (and that written to disk) before its one message goes, so a crash can never send it twice;
//  - at the reset time plus a small buffer it goes through the tab's normal send path; the tab's queue is left alone;
//  - any send, queue, steer, rewind, restore, model change, close or archive in that tab removes it first;
//  - if Foreman was closed or the computer asleep at that time, it is marked missed and asks instead of sending late.
import type { ChatItem, LimitResume, MessageOrigin, Session, UsageLimit } from '../shared/types'
import { MISSED_GRACE_MS } from '../shared/schedule'
import { readsResetTime, RESUME_BUFFER_MS, RESUME_TEXT } from '../shared/usageLimit'
import { lowerCap, type TurnCap } from '../shared/agentAccess'

export interface LimitResumeDeps {
  sessions(): Session[]
  readChat(sessionId: string): Promise<ChatItem[]>
  /**
   * The tab's normal send path, through its queue; the message carries `origin` as its receipt, and `cap` (docs/agent-access.md §4).
   * `unattended`: how the stopped turn was started, when it was a flow step or a schedule run: the send starts the turn the
   * same way (and refuses when the run it belonged to has ended).
   */
  send(sessionId: string, text: string, origin: MessageOrigin, cap?: TurnCap, unattended?: NonNullable<Session['unattended']>): Promise<unknown>
  /** Settings → Usage → "When a limit pauses a chat". */
  resumeAfterLimit?(): 'auto' | 'ask'
  /** The chat's account becomes `to` (null: the agent's default), as its agent's move rule allows; throws when it doesn't. */
  moveAccount?(sessionId: string, to: string | null): Promise<void>
  /** One notification: the resume went by the clock ("Resumed after the usage limit"). */
  resumed?(session: Session): void
  /** Write everything to disk now (not debounced). */
  flush(): void
  changed(): void
  now(): number
  /** A resume was found missed (Foreman closed, or the computer asleep, at its time): tell the human. */
  missed?(session: Session, resume: LimitResume): void
  intervalMs?: number
  graceMs?: number
}

const INTERVAL_MS = 15_000
// A tick this much later than planned means the computer slept (or the process was frozen) in between.
const SLEEP_SLACK_MS = 45_000

export class LimitResumeService {
  private timer: NodeJS.Timeout | null = null
  private lastTick: number | undefined

  constructor(private deps: LimitResumeDeps) {}

  private get interval(): number {
    return this.deps.intervalMs ?? INTERVAL_MS
  }

  private persist(): void {
    this.deps.flush()
    this.deps.changed()
  }

  private session(id: string): Session {
    const found = this.deps.sessions().find((s) => s.id === id)
    if (!found) throw new Error('Chat not found')
    return found
  }

  /** Every armed or missed resume, with its tab. */
  list(): { session: Session; resume: LimitResume }[] {
    return this.deps.sessions().flatMap((session) => (session.limitResume ? [{ session, resume: session.limitResume }] : []))
  }

  // ---- lifecycle ----

  /** At launch: a resume whose time came while Foreman was closed asks instead of sending. Then start ticking. */
  start(): void {
    this.markPastAsMissed()
    this.lastTick = this.deps.now()
    if (this.timer) return
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.interval)
    this.timer.unref?.()
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The computer woke from sleep: anything whose time came meanwhile asks instead of sending. */
  woke(): void {
    this.markPastAsMissed()
    this.lastTick = this.deps.now()
  }

  private markPastAsMissed(): void {
    const now = this.deps.now()
    let any = false
    for (const { session, resume } of this.list()) {
      if (resume.missed || Date.parse(resume.at) > now) continue
      resume.missed = true
      any = true
      this.deps.missed?.(session, resume)
    }
    if (any) this.persist()
  }

  // ---- what the human does ----

  /** The resume for a stopped turn: when it sends, what it sends and how the turn was started. */
  private build(session: Session, turnId: string, limit: UsageLimit, cap: TurnCap | undefined, auto: boolean): LimitResume {
    const now = this.deps.now()
    const resetAt = Date.parse(limit.resetAt!)
    const held = session.limitHeld?.turnId === turnId ? session.limitHeld.unattended : undefined
    return {
      turnId,
      resetAt: limit.resetAt!,
      at: new Date(resetAt + RESUME_BUFFER_MS).toISOString(),
      source: limit.source!,
      ...(limit.from ? { from: limit.from } : {}),
      text: RESUME_TEXT,
      armedAt: new Date(now).toISOString(),
      ...(cap ? { cap } : {}),
      ...(auto ? { auto: true as const } : {}),
      ...(held ? { unattended: held } : {})
    }
  }

  /**
   * Tick "Resume at …" on the card of the tab's latest turn. The resume carries the stopped turn's cap, lowered by `cap`
   * when a capped turn armed it (`foreman resume-at`; docs/agent-access.md §4).
   */
  async arm(sessionId: string, turnId: string, cap?: TurnCap): Promise<LimitResume> {
    const session = this.session(sessionId)
    if (session.closedAt) throw new Error('This chat is closed')
    if (!readsResetTime(session.agent)) throw new Error('This agent doesn’t say when its limits reset')
    // A turn that stopped at a limit is `limit`; chats saved before that word was kept have `error` with the limit on the turn's end.
    const paused = session.lastTurn?.outcome === 'limit' || session.lastTurn?.outcome === 'error'
    if (session.status === 'running' || session.turnId || session.lastTurn?.turnId !== turnId || !paused) {
      throw new Error('Something newer happened in this chat, so there’s nothing to resume.')
    }
    const chat = await this.deps.readChat(sessionId)
    const end = chat.find((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end' && i.turnId === turnId)
    const stopped = chat.find((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user' && i.turnId === turnId && !i.steered)
    const carried = lowerCap(stopped?.cap, cap)
    const limit = end?.limit
    if (!limit?.resetAt || !limit.source) throw new Error('The error didn’t say when the limit resets.')
    const resetAt = Date.parse(limit.resetAt)
    if (resetAt <= this.deps.now()) throw new Error('The reset time has passed. Use Retry instead.')
    const resume = this.build(session, turnId, limit, carried, false)
    session.limitResume = resume
    this.persist()
    return resume
  }

  /**
   * A turn just stopped at a usage limit (docs/agents.md 7.2): with "Resume by itself" and a reset time Foreman knows, the
   * resume is armed now, with no click, carrying the stopped turn's cap and how it was started. Nothing is armed for an
   * unknown or past time, or under "Ask me first": the card offers it, as it always has. Returns the resume, when one was armed.
   */
  autoArm(sessionId: string, turnId: string, limit: UsageLimit, cap?: TurnCap): LimitResume | undefined {
    if ((this.deps.resumeAfterLimit?.() ?? 'auto') !== 'auto') return undefined
    const session = this.deps.sessions().find((s) => s.id === sessionId)
    if (!session || session.closedAt || !readsResetTime(session.agent)) return undefined
    // An auto review's reviewer isn't resumed: its review has failed, as any review of an errored turn does.
    if (session.autoReview) return undefined
    if (!limit.resetAt || !limit.source || Date.parse(limit.resetAt) <= this.deps.now()) return undefined
    const resume = this.build(session, turnId, limit, cap, true)
    session.limitResume = resume
    this.persist()
    return resume
  }

  /**
   * Untick, Cancel on Home, or Dismiss. A paused tab whose resume is dismissed is a failed turn with the card's offer, as it was
   * before there was a pause: it asks for the person's attention again (any other activity starts a turn that replaces that).
   */
  cancel(sessionId: string): void {
    const session = this.deps.sessions().find((s) => s.id === sessionId)
    if (!session?.limitResume) return
    delete session.limitResume
    if (session.lastTurn?.outcome === 'limit') session.lastTurn = { ...session.lastTurn, outcome: 'error' }
    this.persist()
  }

  /**
   * docs/agent-access.md §4, "Revoking": an armed or missed resume whose cap names a revoked sign-in is cleared, so
   * nothing that sign-in's tree asked for starts later. Returns how many were.
   */
  dropFromGrant(grantId: string): number {
    let dropped = 0
    for (const { session, resume } of this.list()) {
      if (resume.cap?.grantId !== grantId) continue
      delete session.limitResume
      dropped++
    }
    if (dropped) this.persist()
    return dropped
  }

  /** Something happened in the tab first: the resume would land on top of something newer. */
  activity(sessionId: string): void {
    this.cancel(sessionId)
  }

  /** "Resume now" on a missed one: the same single send, now. `cap`: asked for from a capped turn (`foreman resume-now`), which lowers the resume's own. */
  async resumeNow(sessionId: string, cap?: TurnCap): Promise<void> {
    const session = this.session(sessionId)
    if (!session.limitResume) {
      // A paused chat whose reset time isn't known (nothing was armed) is resumed by the person's word alone.
      const turnId = session.lastTurn?.turnId
      if (session.lastTurn?.outcome !== 'limit' || !turnId || session.limitHeld || session.status === 'running' || session.turnId) throw new Error('There’s no resume waiting in this chat.')
      const stopped = (await this.deps.readChat(sessionId)).find((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user' && i.turnId === turnId && !i.steered)
      const carried = lowerCap(stopped?.cap, cap)
      await this.deps.send(session.id, RESUME_TEXT, { kind: 'limit-resume' }, carried)
      return
    }
    await this.fire(session, cap)
  }

  /**
   * "Continue on account Y" on a paused chat: the chat moves to that account of its agent (its move rule decides how, and
   * refuses when it can't), then goes on there at once with the same message a resume sends. Never automatic. Not for a flow
   * step or a schedule run, which stay on the account their run chose.
   */
  async continueOnAccount(sessionId: string, to: string | null, cap?: TurnCap): Promise<void> {
    const session = this.session(sessionId)
    const turnId = session.lastTurn?.turnId
    if (session.lastTurn?.outcome !== 'limit' || !turnId || session.status === 'running' || session.turnId) throw new Error('This chat isn’t paused at a usage limit.')
    if (session.limitHeld || session.limitResume?.unattended) throw new Error('This turn belongs to a run, which stays on its own account.')
    if (!this.deps.moveAccount) throw new Error('This version of Foreman can’t move a chat to another account.')
    const stopped = (await this.deps.readChat(sessionId)).find((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user' && i.turnId === turnId && !i.steered)
    const carried = lowerCap(lowerCap(stopped?.cap, session.limitResume?.cap), cap)
    // The move first: it refuses (running, the rule says never, the account is gone) before anything is sent, and it cancels the armed resume.
    await this.deps.moveAccount(sessionId, to)
    await this.deps.send(sessionId, RESUME_TEXT, { kind: 'limit-resume' }, carried)
  }

  // ---- the clock ----

  /** Look at every armed resume against the clock. Safe to call as often as you like. */
  async tick(): Promise<void> {
    const now = this.deps.now()
    const slept = this.lastTick !== undefined && now - this.lastTick > this.interval + SLEEP_SLACK_MS
    this.lastTick = now
    if (slept) return this.markPastAsMissed()
    for (const { session, resume } of this.list()) {
      if (resume.missed) continue
      const at = Date.parse(resume.at)
      if (now < at) continue
      if (now - at > (this.deps.graceMs ?? MISSED_GRACE_MS)) {
        resume.missed = true
        this.persist()
        this.deps.missed?.(session, resume)
        continue
      }
      await this.fire(session, undefined, true)
    }
  }

  /** Remove it, on disk, then send its one message. A send that fails comes back as missed, saying why. `byClock`: its time came (not a click). */
  private async fire(session: Session, cap?: TurnCap, byClock = false): Promise<void> {
    const resume = session.limitResume
    if (!resume) return
    delete session.limitResume
    this.persist()
    try {
      const carried = lowerCap(resume.cap, cap)
      await this.deps.send(session.id, resume.text, { kind: 'limit-resume' }, carried, resume.unattended)
      // The turn is on its way: the tab is no longer paused, and the person hears of it once.
      if (byClock) this.deps.resumed?.(session)
    } catch (err) {
      // Something else may have happened in the tab meanwhile; only an empty slot takes it back.
      if (session.limitResume || session.closedAt) return
      session.limitResume = { ...resume, missed: true, failed: err instanceof Error ? err.message : String(err) }
      this.persist()
    }
  }
}
