// Hand off to another Mac (P-4): the persisted transfer record, the messages the two Macs
// exchange, and the pure rules the dialog and Home read.
import { createT, type PlainKey, type TFunction } from './i18n'
import type { RepoEvidence } from './portable'
import type { Workspace } from './types'

const enT = createT('en')

/**
 * Where one side of a hand-off is. The source goes validating, frozen, exporting, sending, awaiting-ack, relinquished,
 * completed. The destination goes staged, then completed. cancelled is a clean abort; diverged is a forced take
 * (the other side may still hold its own copy).
 */
export type TransferState = 'validating' | 'frozen' | 'exporting' | 'sending' | 'awaiting-ack' | 'relinquished' | 'staged' | 'completed' | 'cancelled' | 'diverged'

export type TransferRole = 'source' | 'destination'

export interface Transfer {
  id: string
  role: TransferRole
  workspaceId: string
  workspaceName: string
  peerId: string
  peerName: string
  state: TransferState
  startedAt: string
  updatedAt: string
  // Size of the file that was sent, once known.
  bytes?: number
  // Destination: the inactive workspace the file was staged as.
  stagedWorkspaceId?: string
  // Why it stopped, or what the last attempt said.
  error?: string
  // The state it was in when it was cancelled or taken back, for the progress list.
  failedAt?: TransferState
  // Set in snapshots: this Mac is working on it right now (not left over from before a restart).
  live?: boolean
}

/** What the workspace itself carries, so the chat and the composer can say why they are locked. */
export interface WorkspaceTransfer {
  id: string
  // frozen: this Mac gave the work up or is about to. handed-off: it is on the other Mac now. staged: arrived here, not active yet. diverged: a forced take; both Macs may have a copy.
  state: 'frozen' | 'handed-off' | 'staged' | 'diverged'
  peerName: string
}

/** Why Foreman won't send, run checks or start scripts in this workspace, or null. */
export function frozenReason(ws: Pick<Workspace, 'transfer'>, tr: TFunction = enT): string | null {
  const t = ws.transfer
  if (!t) return null
  if (t.state === 'frozen') return tr('transfer.frozen.frozen', { peer: t.peerName })
  if (t.state === 'handed-off') return tr('transfer.frozen.handedOff', { peer: t.peerName })
  if (t.state === 'staged') return tr('transfer.frozen.staged', { peer: t.peerName })
  return null
}

/** States in which the outcome is not known and a person has to say which Mac keeps the workspace. */
export const PENDING_STATES: TransferState[] = ['frozen', 'exporting', 'sending', 'awaiting-ack', 'staged']

export function isPending(t: Pick<Transfer, 'state'>): boolean {
  return PENDING_STATES.includes(t.state)
}

/** Home's "Hand-off pending · Reconcile…" rows: unresolved and not being worked on right now. */
export function pendingTransfers(transfers: Transfer[]): Transfer[] {
  return transfers.filter((t) => isPending(t) && !t.live && (t.role === 'destination' ? t.state === 'staged' : t.state !== 'validating'))
}

export function pendingText(t: Transfer, tr: TFunction = enT): string {
  return t.role === 'source'
    ? tr('transfer.pending.source', { peer: t.peerName })
    : tr('transfer.pending.destination', { peer: t.peerName })
}

// ---- what the two Macs say to each other ----

export type PeerRequest =
  // Step 1: can the destination take it?
  | { type: 'validate'; transferId: string; workspace: { name: string; branch: string; hasClaude: boolean }; repo: RepoEvidence }
  // Step 4: the file travels with this request; the answer is the acknowledgement.
  | { type: 'offer'; transferId: string; passphrase: string; bytes: number; sha256: string }
  // Step 7: the source has given it up.
  | { type: 'activate'; transferId: string }
  // Reconcile: the source asks whether the destination can drop its staged copy.
  | { type: 'cancel'; transferId: string }
  | { type: 'status'; transferId: string }
  // Reconcile from the destination: "I have it, you can let go", or "I don't want it".
  | { type: 'late-ack'; transferId: string }
  | { type: 'declined'; transferId: string }

export interface PeerResponse {
  ok: boolean
  error?: string
  problems?: string[]
  stagedWorkspaceId?: string
  // status: the responder's own record (or 'none'); cancel: cleared | activated | unknown.
  state?: string
}

/** Moves one request to a paired Mac and brings its answer back. Rejects when the Mac can't be reached or the answer is lost. */
export interface PeerTransport {
  send(peerId: string, request: PeerRequest, file?: Buffer, options?: { timeoutMs?: number }): Promise<PeerResponse>
}

// ---- the dialog's progress list ----

export interface TransferStep {
  label: string
  status: 'done' | 'current' | 'todo' | 'failed'
  detail?: string
}

const mb = (bytes: number, tr: TFunction) => (bytes >= 1024 * 1024 ? tr('transfer.size.mb', { size: (bytes / 1024 / 1024).toFixed(1) }) : tr('transfer.size.kb', { size: Math.max(1, Math.round(bytes / 1024)) }))

/** Which of the six steps a state is in (6 means all done). */
function stepOf(state: TransferState): number {
  switch (state) {
    case 'validating':
      return 0
    case 'frozen':
      return 1
    case 'exporting':
    case 'sending':
      return 2
    case 'awaiting-ack':
      return 3
    case 'relinquished':
      return 5
    default:
      return 6
  }
}

/** The steps of a hand-off as the source sees them. A cancelled one marks the step it stopped at. */
export function sourceSteps(t: Transfer, tr: TFunction = enT): TransferStep[] {
  const peer = t.peerName
  const labels = [
    tr('transfer.step.check', { peer }),
    tr('transfer.step.freeze', { workspace: t.workspaceName }),
    t.bytes !== undefined ? tr('transfer.step.sendSize', { size: mb(t.bytes, tr) }) : tr('transfer.step.send'),
    tr('transfer.step.stage', { peer }),
    tr('transfer.step.giveUp'),
    tr('transfer.step.activate', { peer })
  ]
  const stopped = t.state === 'cancelled' || t.state === 'diverged'
  const at = stepOf(stopped ? (t.failedAt ?? 'validating') : t.state)
  return labels.map((label, i): TransferStep => {
    if (i < at) return { label, status: 'done' }
    if (i === at) return stopped ? { label, status: 'failed', detail: t.error } : { label, status: 'current', detail: t.state === 'awaiting-ack' ? tr('transfer.step.waiting') : undefined }
    return { label, status: 'todo' }
  })
}

/** One line for the dialog's footer. */
export function transferHeadline(t: Transfer, tr: TFunction = enT): string {
  switch (t.state) {
    case 'completed':
      return tr('transfer.headline.completed', { peer: t.peerName })
    case 'relinquished':
      return tr('transfer.headline.relinquished', { peer: t.peerName })
    case 'awaiting-ack':
      return tr('transfer.headline.awaitingAck', { peer: t.peerName })
    case 'cancelled':
      return t.error ? tr('transfer.headline.notHandedOff', { error: t.error }) : tr('transfer.headline.cancelled')
    case 'diverged':
      return tr('transfer.headline.diverged', { peer: t.peerName })
    default:
      return tr('transfer.headline.working')
  }
}

/** A key: show it with t(HAND_OFF_WARNING). */
export const HAND_OFF_WARNING: PlainKey = 'transfer.warning'

// ---- paired Macs ----

export interface PairedDevice {
  id: string
  name: string
  // Where to dial it (the address it showed, or the one it connected from).
  host?: string
  port?: number
  pairedAt: string
  lastSeen?: string
}

export interface DevicesInfo {
  self: { id: string; name: string }
  accepting: boolean
  port: number
  // Addresses other Macs can try, most likely first.
  addresses: string[]
  paired: PairedDevice[]
  // A code is being shown.
  pairing?: { code: string; expiresAt: string }
}
