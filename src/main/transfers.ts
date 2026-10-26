// Hand off to another Mac (P-4): the two state machines, one on each Mac.
//
//   source                                         destination
//   1 validate ───────────────────────────────────▶ repo here? git recent enough? Claude signed in?
//   2 persist {id, frozen}, freeze the workspace
//   3 export (Backup, with the branch bundle)
//   4 send ───────────────────────────────────────▶ 5 stage it, inactive; persist {id, staged}
//   6 persist relinquished  ◀───────── acknowledge ─┘
//   7 activate ───────────────────────────────────▶ provision the worktree, restore, go
//
// Both sides persist before they act on the next step, and every step that can't be undone happens
// only after the other side said it holds the work. A definite refusal (validation, a bad file)
// unfreezes the source. If the acknowledgement is lost, nobody knows who has it: both sides stay
// locked and a person picks which Mac keeps it (reconcile). Taking it back while the other Mac may
// still hold a copy is allowed, and says so: the two have diverged.
import { createHash, randomBytes } from 'node:crypto'
import type { RepoEvidence } from '../shared/portable'
import { frozenReason, isPending, type PeerRequest, type PeerResponse, type PeerTransport, type Transfer, type TransferState, type WorkspaceTransfer } from '../shared/transfer'
import { MAX_TRANSFER_BYTES } from './deviceNet'

export interface TransferStore {
  state: { transfers?: Transfer[] }
  /** Write everything to disk now. */
  flush(): void
}

export interface TransferLocal {
  /** The workspace; throws if it isn't here. */
  workspace(id: string): { id: string; name: string; branch: string; state: string; transfer?: WorkspaceTransfer }
  setTransfer(workspaceId: string, transfer: WorkspaceTransfer | null): void
  evidence(workspaceId: string): Promise<RepoEvidence>
  hasClaude(workspaceId: string): boolean
  /** Why the workspace can't be frozen right now (a tab, a check or a script is working), or null. */
  busy(workspaceId: string): string | null
  /** Backup mode with the branch and uncommitted work (the P-2 export); writes `outPath`. */
  exportBackup(workspaceId: string, passphrase: string, outPath: string): Promise<void>
  // Destination side.
  findRepo(evidence: RepoEvidence): Promise<string | undefined>
  /** Problems with taking the work here that aren't about the repository: git too old, Claude not signed in. */
  validate(hasClaude: boolean): Promise<string[]>
  /** Stage the file and import it as an inactive workspace in the repository it matches. */
  stage(file: string, passphrase: string): Promise<{ workspaceId: string }>
  activate(workspaceId: string): Promise<void>
  discard(workspaceId: string): Promise<void>
  /** A line in each chat of the workspace. */
  notice(workspaceId: string, text: string): Promise<void>
}

export interface TransferDeps {
  store: TransferStore
  transport: PeerTransport
  local: TransferLocal
  peerName(peerId: string): string
  files: {
    temp(name: string): string
    read(path: string): Promise<Buffer>
    write(path: string, data: Buffer): Promise<void>
    remove(path: string): Promise<void>
  }
  now?: () => number
  newId?: () => string
  changed(): void
}

const KEEP_FINISHED = 30
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')

export class TransferService {
  // Hand-offs this Mac is working on right now, as opposed to ones left over from before a restart.
  private liveIds = new Set<string>()
  private runs = new Map<string, Promise<void>>()
  private cancelRequested = new Set<string>()

  constructor(private deps: TransferDeps) {}

  get transfers(): Transfer[] {
    return (this.deps.store.state.transfers ??= [])
  }

  /** The records for the app snapshot, saying which are being worked on right now. */
  view(): Transfer[] {
    return this.transfers.map((t) => ({ ...t, live: this.liveIds.has(t.id) }))
  }

  private get now(): string {
    return new Date((this.deps.now ?? Date.now)()).toISOString()
  }

  find(id: string): Transfer | undefined {
    return this.transfers.find((t) => t.id === id)
  }

  private get(id: string): Transfer {
    const t = this.find(id)
    if (!t) throw new Error('That hand-off isn’t known here.')
    return t
  }

  private persist(): void {
    this.deps.store.flush()
    this.deps.changed()
  }

  private set(t: Transfer, state: TransferState, patch: Partial<Transfer> = {}): void {
    Object.assign(t, patch, { state, updatedAt: this.now })
    this.persist()
  }

  /** The hand-off ends here without a winner needing to be picked: nothing moved, nothing is frozen. */
  private cancel(t: Transfer, error?: string): void {
    const failedAt = t.state
    if (t.role === 'source') this.deps.local.setTransfer(t.workspaceId, null)
    this.set(t, 'cancelled', { error, failedAt })
    this.prune()
  }

  private prune(): void {
    const done = this.transfers.filter((t) => !isPending(t) && t.state !== 'validating' && t.state !== 'relinquished')
    for (const old of done.slice(0, Math.max(0, done.length - KEEP_FINISHED))) this.transfers.splice(this.transfers.indexOf(old), 1)
  }

  // ---- after a restart ----

  /**
   * What a restart left behind. A hand-off that hadn't froze anything is dropped. One that was frozen or in flight might
   * have been delivered, so it waits for a person (it can't be assumed lost or kept).
   */
  recover(): void {
    let any = false
    for (const t of [...this.transfers]) {
      if (t.role === 'source' && t.state === 'validating') {
        this.transfers.splice(this.transfers.indexOf(t), 1)
        any = true
      } else if (t.role === 'source' && ['frozen', 'exporting', 'sending'].includes(t.state)) {
        // Not known whether the file arrived.
        t.state = 'awaiting-ack'
        t.error = 'Foreman closed during the hand-off, so it isn’t known whether the other Mac received it.'
        t.updatedAt = this.now
        any = true
      }
    }
    if (any) this.persist()
  }

  // ---- the source ----

  /** Begin a hand-off. Returns its id at once; progress is in the transfer record. */
  async start(workspaceId: string, peerId: string): Promise<string> {
    const ws = this.deps.local.workspace(workspaceId)
    if (ws.state !== 'ready') throw new Error(`${ws.name} isn’t ready, so it can’t be handed off.`)
    if (ws.transfer && ws.transfer.state !== 'diverged') throw new Error(frozenReason(ws) ?? `${ws.name} has a hand-off in progress.`)
    if (this.transfers.some((t) => t.workspaceId === workspaceId && (isPending(t) || t.state === 'validating' || t.state === 'relinquished')))
      throw new Error(`${ws.name} already has a hand-off in progress.`)
    const t: Transfer = {
      id: (this.deps.newId ?? (() => randomBytes(8).toString('hex')))(),
      role: 'source',
      workspaceId,
      workspaceName: ws.name,
      peerId,
      peerName: this.deps.peerName(peerId),
      state: 'validating',
      startedAt: this.now,
      updatedAt: this.now
    }
    this.transfers.push(t)
    this.liveIds.add(t.id)
    this.persist()
    this.runs.set(
      t.id,
      this.run(t)
        .catch((err: unknown) => this.failed(t, err))
        .finally(() => {
          this.liveIds.delete(t.id)
          this.cancelRequested.delete(t.id)
          this.deps.changed()
        })
    )
    return t.id
  }

  /** Resolves when the work this Mac is doing on a hand-off has stopped (done, failed or waiting for a person). */
  settled(id: string): Promise<void> {
    return this.runs.get(id) ?? Promise.resolve()
  }

  /** Before the file is sent, nothing is lost by stopping; afterwards it is a reconcile. */
  cancelHandOff(id: string): void {
    const t = this.get(id)
    if (t.role !== 'source' || !['validating', 'frozen', 'exporting'].includes(t.state)) throw new Error('It is too late to cancel; reconcile it instead.')
    this.cancelRequested.add(id)
  }

  private stopIfAsked(t: Transfer): boolean {
    if (!this.cancelRequested.has(t.id)) return false
    this.cancel(t, 'Cancelled.')
    return true
  }

  private failed(t: Transfer, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    if (t.role !== 'source') return
    if (t.state === 'sending' || t.state === 'awaiting-ack') this.set(t, 'awaiting-ack', { error: message })
    else if (t.state === 'relinquished' || t.state === 'completed') this.set(t, t.state, { error: message })
    else this.cancel(t, message)
  }

  private async run(t: Transfer): Promise<void> {
    const { local, transport, files } = this.deps
    const peer = t.peerName
    const file = files.temp(`handoff-${t.id}.foreman`)
    try {
      // 1. The destination checks it can take it.
      const evidence = await local.evidence(t.workspaceId)
      const checked = await transport
        .send(t.peerId, { type: 'validate', transferId: t.id, workspace: { name: t.workspaceName, branch: local.workspace(t.workspaceId).branch, hasClaude: local.hasClaude(t.workspaceId) }, repo: evidence }, undefined, { timeoutMs: 20_000 })
        .catch(() => null)
      if (!checked) return this.cancel(t, `${peer} isn’t reachable. Is Foreman open there and accepting hand-offs?`)
      if (!checked.ok) return this.cancel(t, checked.problems?.length ? checked.problems.join(' ') : checked.error ?? `${peer} can’t take this.`)
      if (this.stopIfAsked(t)) return

      // 2. Freeze, persisted first.
      const why = local.busy(t.workspaceId)
      if (why) return this.cancel(t, `Can’t freeze ${t.workspaceName}: ${why}. Let it finish or stop it, then try again.`)
      local.setTransfer(t.workspaceId, { id: t.id, state: 'frozen', peerName: peer })
      this.set(t, 'frozen')
      if (this.stopIfAsked(t)) return

      // 3. Export, in Backup mode, with the branch and uncommitted work.
      this.set(t, 'exporting')
      const passphrase = randomBytes(24).toString('base64')
      await local.exportBackup(t.workspaceId, passphrase, file)
      const bytes = await files.read(file)
      if (bytes.length > MAX_TRANSFER_BYTES) throw new Error('This workspace is too big for a hand-off over the network. Export it to a file instead.')
      if (this.stopIfAsked(t)) return

      // 4. Send. From here on, a lost answer means nobody knows.
      this.set(t, 'sending', { bytes: bytes.length })
      let ack: PeerResponse
      try {
        ack = await transport.send(t.peerId, { type: 'offer', transferId: t.id, passphrase, bytes: bytes.length, sha256: sha(bytes) }, bytes, { timeoutMs: 10 * 60_000 })
      } catch (err) {
        this.set(t, 'awaiting-ack', { error: `No acknowledgement from ${peer} (${err instanceof Error ? err.message : String(err)}).` })
        return
      }
      // A definite no: nothing moved.
      if (!ack.ok) return this.cancel(t, ack.error ?? `${peer} refused it.`)

      // 6. The other Mac holds it: give it up, persisted before the next step.
      this.relinquish(t)

      // 7. Tell it to activate. If this fails the work is safely staged there; it can activate from its own Home.
      await this.tell(t, { type: 'activate', transferId: t.id }, 'completed')
    } finally {
      await files.remove(file).catch(() => undefined)
    }
  }

  private relinquish(t: Transfer): void {
    this.deps.local.setTransfer(t.workspaceId, { id: t.id, state: 'handed-off', peerName: t.peerName })
    this.set(t, 'relinquished', { error: undefined })
  }

  /** Send the activate request; on success the hand-off is complete. */
  private async tell(t: Transfer, request: PeerRequest, done: TransferState): Promise<void> {
    const res = await this.deps.transport.send(t.peerId, request, undefined, { timeoutMs: 5 * 60_000 }).catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    if (res.ok) this.set(t, done, { error: undefined })
    else this.set(t, t.state, { error: `${t.peerName} has it but hasn’t activated yet: ${res.error ?? 'no answer'}. Open Foreman there to activate it.` })
  }

  // ---- the destination ----

  /** A request from a paired Mac. `from` is the id the channel authenticated. */
  async handle(from: string, request: PeerRequest, file?: Buffer): Promise<PeerResponse> {
    switch (request.type) {
      case 'validate':
        return this.validate(request)
      case 'offer':
        return this.offer(from, request, file)
      case 'activate':
        return this.activateRequest(from, request.transferId)
      case 'cancel':
        return this.cancelRequest(from, request.transferId)
      case 'status': {
        const t = this.find(request.transferId)
        return { ok: true, state: t && t.peerId === from ? t.state : 'none' }
      }
      case 'late-ack':
        return this.lateAck(from, request.transferId)
      case 'declined':
        return this.declined(from, request.transferId)
    }
  }

  private async validate(request: Extract<PeerRequest, { type: 'validate' }>): Promise<PeerResponse> {
    const problems: string[] = []
    if (!(await this.deps.local.findRepo(request.repo))) problems.push(`The repository “${request.repo.name}” isn’t added on this Mac (no repository here has the same remote or root commit).`)
    problems.push(...(await this.deps.local.validate(request.workspace.hasClaude)))
    return problems.length ? { ok: false, problems } : { ok: true }
  }

  private async offer(from: string, request: Extract<PeerRequest, { type: 'offer' }>, file?: Buffer): Promise<PeerResponse> {
    const existing = this.find(request.transferId)
    // The same offer again (the acknowledgement was lost and the sender retried): answer as before.
    if (existing) {
      if (existing.peerId !== from || existing.role !== 'destination') return { ok: false, error: 'That hand-off belongs to another Mac.' }
      if (existing.state === 'staged' || existing.state === 'completed') return { ok: true, stagedWorkspaceId: existing.stagedWorkspaceId }
      return { ok: false, error: 'That hand-off was already cancelled here.' }
    }
    if (!file || file.length !== request.bytes || sha(file) !== request.sha256) return { ok: false, error: 'The file arrived damaged. Nothing was staged.' }
    const path = this.deps.files.temp(`incoming-${request.transferId}.foreman`)
    try {
      await this.deps.files.write(path, file)
      const staged = await this.deps.local.stage(path, request.passphrase)
      const ws = this.deps.local.workspace(staged.workspaceId)
      const t: Transfer = {
        id: request.transferId,
        role: 'destination',
        workspaceId: ws.id,
        workspaceName: ws.name,
        peerId: from,
        peerName: this.deps.peerName(from),
        state: 'staged',
        startedAt: this.now,
        updatedAt: this.now,
        bytes: file.length,
        stagedWorkspaceId: ws.id
      }
      this.deps.local.setTransfer(ws.id, { id: t.id, state: 'staged', peerName: t.peerName })
      this.transfers.push(t)
      this.persist()
      return { ok: true, stagedWorkspaceId: ws.id }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      await this.deps.files.remove(path).catch(() => undefined)
    }
  }

  private mine(from: string, id: string): Transfer | undefined {
    const t = this.find(id)
    return t && t.peerId === from ? t : undefined
  }

  private async activateRequest(from: string, id: string): Promise<PeerResponse> {
    const t = this.mine(from, id)
    if (!t || t.role !== 'destination') return { ok: false, error: 'Nothing is staged for that hand-off here.' }
    if (t.state === 'completed') return { ok: true }
    if (t.state !== 'staged') return { ok: false, error: `That hand-off is ${t.state} here.` }
    try {
      await this.activateLocal(t, 'completed')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Make the staged workspace live. If activating fails it stays staged. */
  private async activateLocal(t: Transfer, state: 'completed' | 'diverged'): Promise<void> {
    const { local } = this.deps
    this.liveIds.add(t.id)
    local.setTransfer(t.workspaceId, null)
    try {
      await local.activate(t.workspaceId)
    } catch (err) {
      local.setTransfer(t.workspaceId, { id: t.id, state: 'staged', peerName: t.peerName })
      this.set(t, 'staged', { error: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      this.liveIds.delete(t.id)
    }
    if (state === 'diverged') local.setTransfer(t.workspaceId, { id: t.id, state: 'diverged', peerName: t.peerName })
    this.set(t, state, { error: undefined })
    this.prune()
  }

  private async cancelRequest(from: string, id: string): Promise<PeerResponse> {
    const t = this.mine(from, id)
    if (!t || t.role !== 'destination') return { ok: true, state: 'unknown' }
    if (t.state === 'completed' || t.state === 'diverged') return { ok: true, state: 'activated' }
    if (t.state !== 'staged') return { ok: true, state: 'unknown' }
    await this.deps.local.discard(t.workspaceId).catch(() => undefined)
    this.cancel(t, `${t.peerName} took it back.`)
    return { ok: true, state: 'cleared' }
  }

  private lateAck(from: string, id: string): PeerResponse {
    const t = this.mine(from, id)
    if (!t || t.role !== 'source') return { ok: false, error: 'This Mac has no such hand-off.' }
    if (['frozen', 'exporting', 'sending', 'awaiting-ack'].includes(t.state)) {
      this.relinquish(t)
      return { ok: true, state: t.state }
    }
    if (t.state === 'relinquished' || t.state === 'completed') return { ok: true, state: t.state }
    return { ok: false, error: `This Mac already ${t.state === 'diverged' ? 'took the workspace back' : 'cancelled the hand-off'}.`, state: t.state }
  }

  private declined(from: string, id: string): PeerResponse {
    const t = this.mine(from, id)
    if (!t || t.role !== 'source') return { ok: false, error: 'This Mac has no such hand-off.' }
    if (isPending(t)) this.cancel(t, `${t.peerName} declined it.`)
    return { ok: true, state: t.state }
  }

  // ---- reconcile ----

  /**
   * The acknowledgement was lost, so both Macs are locked. Pick which one keeps the workspace.
   * "keep-here" on the source takes it back; on the destination it activates the staged copy.
   */
  async reconcile(id: string, choice: 'keep-here' | 'other-keeps'): Promise<void> {
    const t = this.get(id)
    if (this.liveIds.has(id)) throw new Error('That hand-off is still in progress.')
    if (!isPending(t)) throw new Error('That hand-off is already settled.')
    this.liveIds.add(id)
    this.deps.changed()
    try {
      if (t.role === 'source') await (choice === 'keep-here' ? this.takeBack(t) : this.letGo(t))
      else await (choice === 'keep-here' ? this.activateHere(t) : this.declineStaged(t))
    } finally {
      this.liveIds.delete(id)
      this.deps.changed()
    }
  }

  private async takeBack(t: Transfer): Promise<void> {
    const res = await this.deps.transport.send(t.peerId, { type: 'cancel', transferId: t.id }, undefined, { timeoutMs: 15_000 }).catch(() => null)
    const clean = Boolean(res?.ok && (res.state === 'cleared' || res.state === 'unknown'))
    this.deps.local.setTransfer(t.workspaceId, clean ? null : { id: t.id, state: 'diverged', peerName: t.peerName })
    const failedAt = t.state
    if (clean) {
      this.set(t, 'cancelled', { error: res?.state === 'cleared' ? `Taken back here. ${t.peerName}’s staged copy was removed.` : `Taken back here. ${t.peerName} never had it.`, failedAt })
      return
    }
    const reason = res ? `${t.peerName} had already activated it` : `${t.peerName} couldn’t be reached`
    this.set(t, 'diverged', { error: `You took it back, but ${reason}, so it may have its own copy now.`, failedAt })
    await this.deps.local.notice(t.workspaceId, `You took this workspace back from a hand-off to ${t.peerName} (${reason}). ${t.peerName} may also have a copy: the two have diverged.`).catch(() => undefined)
  }

  /** Source: the other Mac keeps it. Only when it says it has the work. */
  private async letGo(t: Transfer): Promise<void> {
    const status = await this.deps.transport.send(t.peerId, { type: 'status', transferId: t.id }, undefined, { timeoutMs: 15_000 }).catch(() => null)
    if (!status) throw new Error(`${t.peerName} isn’t reachable, so Foreman can’t check that it has the work. Try again when it is online, or take it back here.`)
    if (status.state !== 'staged' && status.state !== 'completed' && status.state !== 'diverged') {
      throw new Error(`${t.peerName} doesn’t have it (nothing arrived). Take it back here instead.`)
    }
    this.relinquish(t)
    if (status.state === 'staged') await this.tell(t, { type: 'activate', transferId: t.id }, 'completed')
    else this.set(t, 'completed', { error: undefined })
  }

  /** Destination: activate the staged copy. If the source can't confirm it gave the work up, the two have diverged. */
  private async activateHere(t: Transfer): Promise<void> {
    const res = await this.deps.transport.send(t.peerId, { type: 'late-ack', transferId: t.id }, undefined, { timeoutMs: 15_000 }).catch(() => null)
    if (res?.ok) return this.activateLocal(t, 'completed')
    const reason = res ? `${t.peerName} had already taken it back` : `${t.peerName} couldn’t be reached`
    await this.activateLocal(t, 'diverged')
    await this.deps.local.notice(t.workspaceId, `This workspace was activated here without ${t.peerName} confirming it gave it up (${reason}). ${t.peerName} may still have its own copy: the two have diverged.`).catch(() => undefined)
  }

  private async declineStaged(t: Transfer): Promise<void> {
    await this.deps.transport.send(t.peerId, { type: 'declined', transferId: t.id }, undefined, { timeoutMs: 15_000 }).catch(() => undefined)
    await this.deps.local.discard(t.workspaceId)
    this.cancel(t, 'Discarded here; the other Mac keeps it.')
  }
}
