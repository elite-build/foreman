// #11 Usage-limit resume. When a Claude turn stopped at a plan limit and its result error said when the
// limit resets, the recovery card offers one resume at that time, unticked; ticking it arms it here.
// A timer, not a daemon (like schedules.ts). The rules, in the order they matter:
//  - armed only by the human, for the tab's latest turn, at most one per tab, and on disk before it can send;
//  - it is removed (and that written to disk) before its one message goes, so a crash can never send it twice;
//  - at the reset time plus a small buffer it goes through the tab's normal send path; the tab's queue is left alone;
//  - any send, queue, steer, rewind, restore, model change, close or archive in that tab removes it first;
//  - if Foreman was closed or the computer asleep at that time, it is marked missed and asks instead of sending late.
import type { ChatItem, LimitResume, Session } from '../shared/types'
import { MISSED_GRACE_MS } from '../shared/schedule'
import { READS_RESET_TIME, RESUME_BUFFER_MS, RESUME_TEXT } from '../shared/usageLimit'

export interface LimitResumeDeps {
  sessions(): Session[]
  readChat(sessionId: string): Promise<ChatItem[]>
  /** The tab's normal send path, through its queue. */
  send(sessionId: string, text: string): Promise<unknown>
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

  /** Tick "Resume at …" on the card of the tab's latest turn. */
  async arm(sessionId: string, turnId: string): Promise<LimitResume> {
    const session = this.session(sessionId)
    if (session.closedAt) throw new Error('This chat is closed')
    if (!READS_RESET_TIME.includes(session.agent)) throw new Error('This agent doesn’t say when its limits reset')
    if (session.status === 'running' || session.turnId || session.lastTurn?.turnId !== turnId || session.lastTurn.outcome !== 'error') {
      throw new Error('Something newer happened in this chat, so there’s nothing to resume.')
    }
    const end = (await this.deps.readChat(sessionId)).find((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end' && i.turnId === turnId)
    const limit = end?.limit
    if (!limit?.resetAt || !limit.source) throw new Error('The error didn’t say when the limit resets.')
    const now = this.deps.now()
    const resetAt = Date.parse(limit.resetAt)
    if (resetAt <= now) throw new Error('The reset time has passed. Use Retry instead.')
    const resume: LimitResume = {
      turnId,
      resetAt: limit.resetAt,
      at: new Date(resetAt + RESUME_BUFFER_MS).toISOString(),
      source: limit.source,
      ...(limit.from ? { from: limit.from } : {}),
      text: RESUME_TEXT,
      armedAt: new Date(now).toISOString()
    }
    session.limitResume = resume
    this.persist()
    return resume
  }

  /** Untick, Cancel on Home, or Dismiss a missed one. */
  cancel(sessionId: string): void {
    const session = this.deps.sessions().find((s) => s.id === sessionId)
    if (!session?.limitResume) return
    delete session.limitResume
    this.persist()
  }

  /** Something happened in the tab first: the resume would land on top of something newer. */
  activity(sessionId: string): void {
    this.cancel(sessionId)
  }

  /** "Resume now" on a missed one: the same single send, now. */
  async resumeNow(sessionId: string): Promise<void> {
    const session = this.session(sessionId)
    if (!session.limitResume) throw new Error('There’s no resume waiting in this chat.')
    await this.fire(session)
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
      await this.fire(session)
    }
  }

  /** Remove it, on disk, then send its one message. A send that fails comes back as missed, saying why. */
  private async fire(session: Session): Promise<void> {
    const resume = session.limitResume
    if (!resume) return
    delete session.limitResume
    this.persist()
    try {
      await this.deps.send(session.id, resume.text)
    } catch (err) {
      // Something else may have happened in the tab meanwhile; only an empty slot takes it back.
      if (session.limitResume || session.closedAt) return
      session.limitResume = { ...resume, missed: true, failed: err instanceof Error ? err.message : String(err) }
      this.persist()
    }
  }
}
