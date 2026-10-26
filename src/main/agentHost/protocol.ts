// Keep agents running (O10): what the app and the background agent host say to each other
// over a local socket (a named pipe on Windows), or for a cloud workspace over a sandbox
// command's stdio (sandboxAttach.ts), one JSON object per line, and the durable per-turn
// event log both sides read. Node only.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentKind } from '../../shared/agents'
import type { HostTurnInfo, HostWaiting } from '../../shared/agentHost'
import type { ApprovalRequest, ChatItem, ContextUsage } from '../../shared/types'
import type { TurnRequest, TurnResult } from '../agents/types'
import type { ReportKind } from '../../shared/agentReports'

/**
 * Bumped when the wire format changes; an app and a host of different versions don't talk.
 * Additions an older peer ignores (the keepalive push, ping) don't bump it.
 */
export const PROTOCOL_VERSION = 1

/** How often the host says it is alive while a turn runs (a cloud app extends the sandbox's timeout on it). */
export const KEEPALIVE_MS = 60_000

/** The argument that starts Foreman as the agent host instead of the app. */
export const HOST_FLAG = '--foreman-agent-host'
export const HOST_DIR_FLAG = '--host-dir='

/** The arguments the app passes when it starts Foreman as the host. */
export function hostArgs(dir: string): string[] {
  return [HOST_FLAG, `${HOST_DIR_FLAG}${dir}`]
}

// ---- logged events (durable, replayed in order on reconnect) ----

export type HostEventBody =
  | { type: 'item'; item: ChatItem }
  | { type: 'session-started'; agentSessionId: string }
  | { type: 'assistant-message'; uuid: string }
  | { type: 'plan-mode'; on: boolean }
  | { type: 'auto-accept-edits'; on: boolean }
  | { type: 'usage'; usage: ContextUsage }
  | { type: 'mirror-error'; agentSessionId: string; subpath?: string; error: string }
  // A transcript batch for the app's Claude mirror (SessionStore.append).
  | { type: 'mirror-append'; key: unknown; entries: unknown[] }
  | { type: 'followups'; items: string[] }
  // #2: the agent called Foreman's `report` or `request_review` tool; the app records it (with the event's time) when it sees it.
  | { type: 'report'; kind: ReportKind | 'review'; text: string; link?: string }
  | { type: 'finished'; result: TurnResult }
  // The agent process is gone. `crash` is set when run() threw.
  | { type: 'ended'; crash?: string; endCheckpointSaved?: boolean }

export type HostEvent = HostEventBody & { seq: number; turnId: string; at: string }

// An approval request before the app gives it its own id and session.
export type NewApproval = ApprovalRequest extends infer R ? (R extends ApprovalRequest ? Omit<R, 'id' | 'sessionId'> : never) : never

export interface HostApproval {
  id: string
  turnId: string
  request: NewApproval
  at: string
}

// ---- live pushes (host → app) ----

export type HostCallMethod = 'workspaceDiff' | 'diffComments' | 'addDiffComments' | 'mirrorLoad' | 'mirrorListSessions' | 'mirrorListSubkeys' | 'mirrorDelete'

export type HostPush =
  | { type: 'event'; event: HostEvent }
  // A streaming preview: shown, never logged.
  | { type: 'transient'; turnId: string; item: ChatItem }
  | { type: 'approval'; approval: HostApproval }
  | { type: 'approval-gone'; turnId: string; id: string }
  // The agent called one of Foreman's tools (or the transcript mirror); answered with callResult.
  | { type: 'call'; callId: string; turnId: string; method: HostCallMethod; args: unknown[] }
  // Every KEEPALIVE_MS while any turn runs: the host is alive even when the agent is quiet.
  | { type: 'keepalive' }

// ---- requests (app → host) ----

/** A turn request without the in-process parts; the host proxies those back to the app. */
export type WireTurnRequest = Omit<TurnRequest, 'hostTools' | 'sessionStore'>

export interface StartParams {
  sessionId: string
  agent: AgentKind
  request: WireTurnRequest
  // Foreman's diff tools are offered; `followups` adds suggest_followups (Claude), `reports` (#2) report and request_review.
  hostTools?: { followups: boolean; reports?: boolean }
  // Mirror Claude's transcript through the app (SessionStore).
  mirror?: boolean
  // Saved by the host if the turn ends while no app is attached, so the turn's changes stay exact.
  endCheckpoint?: string
  label: { workspace: string; title?: string }
}

export interface DetachParams {
  locale: string
  notify: boolean
  labels: Record<string, { workspace: string; title?: string }>
}

export interface HostMethods {
  hello(p: { token: string; version: number }): { turns: HostTurnInfo[] }
  start(p: StartParams): { ok: true }
  subscribe(p: { turnId: string; afterSeq: number }): { events: HostEvent[]; approvals: HostApproval[] }
  stop(p: { turnId: string }): { ok: true }
  steer(p: { turnId: string; text: string }): boolean
  setPlanMode(p: { turnId: string; on: boolean }): { ok: true }
  setModel(p: { turnId: string; model: string }): { ok: true }
  mcpStatus(p: { turnId: string }): unknown
  reconnectMcp(p: { turnId: string; name: string }): { ok: true }
  respond(p: { id: string; response: unknown }): { ok: true }
  callResult(p: { callId: string; result?: unknown; error?: string }): { ok: true }
  // The app applied the turn's end: forget it and delete its log.
  ack(p: { turnId: string }): { ok: true }
  detach(p: DetachParams): { ok: true }
  stopAll(p: Record<string, never>): { ok: true }
  status(p: Record<string, never>): { turns: HostTurnInfo[] }
  // A cheap round trip: are the host and the transport to it still answering?
  ping(p: Record<string, never>): { ok: true }
}

export type HostMethod = keyof HostMethods

export interface WireRequest {
  id: number
  method: HostMethod
  params: unknown
}

export type WireMessage = { id: number; result?: unknown; error?: string } | { push: HostPush }

/** Splits a byte stream into JSON lines. */
export function lineReader(onMessage: (message: unknown) => void): (chunk: Buffer | string) => void {
  let buffer = ''
  return (chunk) => {
    buffer += chunk.toString()
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (!line) continue
      try {
        onMessage(JSON.parse(line))
      } catch {
        // A garbled line is dropped; the peer's next line still parses.
      }
    }
  }
}

// ---- where things live ----

/** The host's folder: its socket (on macOS), its token file and the turn logs. */
export function hostDir(userData: string): string {
  return path.join(userData, 'agent-host')
}

export function hostSocketPath(dir: string, platform: NodeJS.Platform = process.platform): string {
  const id = createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 12)
  if (platform === 'win32') return `\\\\.\\pipe\\foreman-agent-host-${id}`
  const inDir = path.join(dir, 'host.sock')
  // sun_path holds 104 bytes on macOS, 108 on Linux.
  return Buffer.byteLength(inDir) < 100 ? inDir : path.join(os.tmpdir(), `foreman-agent-host-${id}.sock`)
}

/** Written by the host when it listens: who it is and the token a client must present. */
export interface HostInfo {
  pid: number
  token: string
  version: number
  startedAt: string
}

export function hostInfoPath(dir: string): string {
  return path.join(dir, 'host.json')
}

export function readHostInfo(dir: string): HostInfo | null {
  try {
    return JSON.parse(readFileSync(hostInfoPath(dir), 'utf8')) as HostInfo
  } catch {
    return null
  }
}

// ---- the durable log: one JSON event per line, per turn ----

function logPath(dir: string, turnId: string): string {
  // Turn ids are UUIDs; anything else is made safe for a file name.
  return path.join(dir, 'turns', `${turnId.replace(/[^\w.-]/g, '_')}.jsonl`)
}

export function appendLog(dir: string, event: HostEvent): void {
  const file = logPath(dir, event.turnId)
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(event)}\n`)
}

/** Every event logged for a turn, in order; an unfinished last line (a crash mid-write) is skipped. */
export function readLog(dir: string, turnId: string): HostEvent[] {
  const file = logPath(dir, turnId)
  if (!existsSync(file)) return []
  const out: HostEvent[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as HostEvent)
    } catch {
      // Partial line.
    }
  }
  return out
}

export function removeLog(dir: string, turnId: string): void {
  rmSync(logPath(dir, turnId), { force: true })
}

/** What a waiting approval is blocked on. */
export function waitingFor(request: NewApproval): HostWaiting {
  return request.kind === 'tool' ? { kind: 'tool', tool: request.toolName } : { kind: request.kind }
}
