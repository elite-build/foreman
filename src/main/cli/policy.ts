// Who may call what. Every method sits in one tier; `tierCheck` is the one place that turns a tier and a
// request into a refusal. The policy is cooperative about agents (a turn token can be left out), and the
// launch token only keeps other users on the computer away from the admin tier.
import { timingSafeEqual } from 'node:crypto'
import type { TurnCaller } from '../../shared/agentReports'
import type { CliErrorCode, CliRequest, CliRequestV2 } from '../../cli/protocol'
import type { CliHost } from './host'

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
    // G4: arming a resume starts a turn later, so an agent call needs the same opt-in as send.
    if ((method === 'send' || method === 'resume-at' || (method === 'run' && !params.dryRun)) && request.caller?.token) {
      const refusal = startRefusal(host, request.caller)
      if (refusal) return { code: 'refused', error: refusal }
    }
    return null
  }
  if (request.caller?.token) return { code: 'refused', error: 'Settings can’t be changed from inside an agent turn.' }
  // A version 1 client has no token to give; the command that ships with this app sends version 2.
  if (isV2(request) && !sameToken(request.token, host.cliToken())) {
    return { code: 'refused', error: 'This foreman command is out of date or isn’t the one installed with this app, so Foreman won’t let it change settings or export data.', hint: 'Reinstall it from Settings → Advanced.' }
  }
  return null
}
