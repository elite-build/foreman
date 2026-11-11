// Who may call what. Every method sits in one tier; `tierCheck` is the one place that turns a tier and a
// request into a refusal. The policy is cooperative about agents (a turn token can be left out), and the
// launch token only keeps other users on the computer away from the admin tier.
import { timingSafeEqual } from 'node:crypto'
import type { TurnCaller } from '../../shared/agentReports'
import type { TurnCap } from '../../shared/agentAccess'
import type { Api } from '../../shared/types'
import type { CliErrorCode, CliRequest, CliRequestV2 } from '../../cli/protocol'
import { CliCodedError, type CliHost } from './host'

/**
 * read: always served. act: starts or queues a turn, or does work an agent may do, under the start policy.
 * admin: changes how Foreman is set up or moves data out of it; never from inside an agent turn.
 */
export type Tier = 'read' | 'act' | 'admin'

export interface Refusal {
  code: CliErrorCode
  error: string
  hint?: string
}

export type AnyCliRequest = CliRequest | CliRequestV2

// The admin methods in version 1's vocabulary (CliRequest), from before the launch token.
const V1_ADMIN: ReadonlySet<string> = new Set<CliRequest['method']>(['export', 'import'])

/** The parameters a request carried; the methods without any (status, repos) have none. */
export function paramsOf(request: AnyCliRequest): unknown {
  return (request as { params?: unknown }).params
}

/** A request that says `v: 2` is version 2; one with no `v` is version 1 and is answered exactly as before. */
export function isV2(request: AnyCliRequest): request is CliRequestV2 {
  return (request as { v?: unknown }).v === 2
}

/**
 * #2: `run` and `send` from inside an agent turn (a call carrying a turn token) are refused
 * unless the repository opted in. Cooperative only: an agent can leave the token out.
 */
export function startRefusal(host: CliHost, caller: TurnCaller | undefined): string | null {
  if (!caller?.token) return null
  const who = host.identifyCaller(caller)
  if (who?.kind === 'turn' && host.agentsMayStart(who.ws.repoId)) return null
  if (who?.kind !== 'turn') return 'This call carries a turn token Foreman doesn’t recognise, so it can’t start workspaces or queue messages.'
  return 'Agents in this repository can’t start workspaces or queue messages. The user can allow it in Repository settings → Actions → “Let agents start workspaces and queue messages”.'
}

/**
 * The chat and turn a call came from, when it carries a turn token that checks: who a workspace it starts was started
 * by (Workspace.startedBy), and the origin of a message it queues. Undefined for a person at a terminal.
 */
export function callerTurn(host: CliHost, caller: TurnCaller | undefined): { sessionId: string; turnId: string } | undefined {
  if (!caller?.token) return undefined
  const who = host.identifyCaller(caller)
  return who?.kind === 'turn' ? { sessionId: who.session.id, turnId: who.turnId } : undefined
}

/**
 * docs/agent-access.md §4: the cap of the turn a call came from, when its token checks: the running turn's, or, for a
 * turn that has ended (a background command it left running), the one on that turn's message. Undefined for a person
 * at a terminal and for an uncapped turn.
 */
export async function callerCap(host: CliHost, caller: TurnCaller | undefined): Promise<TurnCap | undefined> {
  if (!caller?.token) return undefined
  const who = host.identifyCaller(caller)
  if (who?.kind !== 'turn') return undefined
  if (who.live) return who.session.turnCap
  const message = (await host.api.getChat(who.session.id)).find((i) => i.kind === 'user' && i.turnId === who.turnId && !i.steered)
  return message?.kind === 'user' ? message.cap : undefined
}

/** The Api a command uses to start or queue a turn: as it is, or with the calling turn's cap on everything it starts. */
export function apiFor(host: CliHost, ctx: { cap?: TurnCap }): Api {
  if (!ctx.cap) return host.api
  if (!host.capped) throw new CliCodedError('refused', 'This turn’s access is limited, and this Foreman can’t hold what the command would start to it.')
  return host.capped(ctx.cap)
}

/** Refused from a capped turn: a flow run approves consent that is the user's, and runs its turns unattended. */
export const CAPPED_FLOW_REFUSAL = 'A flow can’t be started from this turn: it was started through an outside agent’s access, and a flow run approves its setup, checks and commands, which is the user’s to approve. Ask the user to start it.'

function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The refusal for this call, or null when it may go ahead. */
export function tierCheck(method: string, tier: Tier, request: AnyCliRequest, host: CliHost): Refusal | null {
  const params = (paramsOf(request) ?? {}) as { dryRun?: boolean; turn?: string }
  if (method === 'wait') {
    // A turn waiting for itself would never end.
    const who = host.identifyCaller(request.caller)
    if (who?.kind === 'turn' && who.live && who.turnId === params.turn) return { code: 'refused', error: 'A turn can’t wait for itself; it would never end.' }
  }
  if (tier === 'read') return null
  if (tier === 'act') {
    // G4: arming a resume starts a turn later, so an agent call needs the same opt-in as send. A flow run starts a workspace.
    if ((method === 'send' || method === 'resume-at' || method === 'flow-run' || (method === 'run' && !params.dryRun)) && request.caller?.token) {
      const refusal = startRefusal(host, request.caller)
      if (refusal) return { code: 'refused', error: refusal }
    }
    return null
  }
  if (request.caller?.token) return { code: 'refused', error: 'Settings can’t be changed from inside an agent turn.' }
  // A version 1 client has no token to give, so the admin methods it knew stay served to it; every one added since
  // wants the token, whatever version the request says. The command that ships with this app sends version 2.
  if (isV2(request) ? !sameToken(request.token, host.cliToken()) : !V1_ADMIN.has(method)) {
    return { code: 'refused', error: 'This foreman command is out of date or isn’t the one installed with this app, so Foreman won’t let it change settings or export data.', hint: 'Reinstall it from Settings → Advanced.' }
  }
  return null
}
