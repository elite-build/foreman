// Why an agent couldn't start or carry on, as one sentence (docs/agents.md, 4.1). Every adapter reports a failed start through
// this instead of building its own text; the first case that matches wins:
//   not installed, a version Foreman knows is broken (or older than its minimum), a model that needs a newer CLI, a protocol
//   mismatch (ACP v2 only; Codex not knowing a method), not signed in, else the agent's own error.
// The sentence is a message key (launchProblem.*), in English by default like shared/usage.ts, so a caller that knows the
// language passes its `t`. Pure: main, the renderer and the CLI share it.
import { catalogAgent } from './agentCatalog'
import { brokenReason, olderThan } from './agentVersions'
import { createT, type TFunction } from './i18n'

const enT = createT('en')

/** What the person can do about it, as the chat's notice shows it: a button to sign in, to open the agent's settings, or to update it. */
export type LaunchAction = 'sign-in' | 'open-settings' | 'update'

export type LaunchProblemKind = 'not-installed' | 'broken' | 'model-needs-newer' | 'protocol' | 'signed-out' | 'other'

/** What the adapter knows when a start fails. Everything is optional: a case is only matched on what is stated. */
export interface LaunchFacts {
  // How the agent is named in the sentence, when its adapter has a better name than the catalog's.
  name?: string
  // The program wasn't found (ENOENT, or nothing was found to launch).
  notInstalled?: boolean
  // Where it was looked for, and how to get it, for the "not installed" sentence.
  path?: string
  installHint?: string
  // The version the program reports, when the adapter got that far.
  version?: string
  // The model the turn asked for, by id and as the person reads it.
  model?: { id: string; label: string }
  // ACP: the protocolVersion the agent answered `initialize` with.
  acpProtocol?: number
  // Codex: a request the pinned protocol has that this program doesn't know (JSON-RPC "method not found").
  unknownMethod?: string
  // The agent says it isn't signed in (its own words matched), or has no key; the action its own adapter offers for that.
  signedOut?: boolean
  keyMissing?: boolean
  signIn?: 'sign-in' | 'open-settings'
  // The agent's own error text, for when nothing above matches.
  error?: string
}

export interface LaunchProblem {
  kind: LaunchProblemKind
  text: string
  action?: LaunchAction
}

/**
 * The method a JSON-RPC server says it doesn't have. Codex 0.163.0 answers an unknown request with code -32600 and
 * "Invalid request: unknown variant `thread/nope`, expected one of …" (checked against the real app-server); a server that
 * follows the spec says "Method not found: thread/nope" (-32601). Either names the method.
 */
export function unknownMethodOf(message: string | undefined): string | undefined {
  const text = message ?? ''
  return /Invalid request: unknown variant `([^`]+)`/.exec(text)?.[1] ?? /method not found:?\s*([\w/.-]+)/i.exec(text)?.[1]
}

/** A launch problem thrown, so the adapter's one catch reports it as it is (its text and its action) instead of as an error's message. */
export class LaunchProblemError extends Error {
  constructor(readonly problem: LaunchProblem) {
    super(problem.text)
  }
}

export function launchProblem(agent: string, facts: LaunchFacts, t: TFunction = enT): LaunchProblem {
  const entry = catalogAgent(agent)
  const name = facts.name ?? entry?.name ?? agent
  const table = entry?.versions
  // Update is only offered where the agent has an update command of its own to run.
  const update: LaunchAction = table?.update ? 'update' : 'open-settings'
  const version = facts.version?.trim() || undefined

  if (facts.notInstalled) {
    const where = facts.path ? t('launchProblem.notInstalledAt', { agent: name, path: facts.path }) : t('launchProblem.notInstalled', { agent: name })
    return { kind: 'not-installed', text: `${where} ${facts.installHint ?? t('launchProblem.setPath', { agent: name })}`, action: 'open-settings' }
  }

  const broken = brokenReason(table, version)
  if (broken && version) {
    const text = broken.why
      ? t('launchProblem.broken', { agent: name, version, why: t(broken.why) })
      : t('launchProblem.tooOld', { agent: name, version, minimum: broken.below ?? '' })
    return { kind: 'broken', text, action: update }
  }

  const needs = facts.model ? table?.models?.[facts.model.id] : undefined
  if (facts.model && needs && version && olderThan(version, needs)) {
    return { kind: 'model-needs-newer', text: t('launchProblem.modelNeedsNewer', { model: facts.model.label, agent: name, version }), action: update }
  }

  if (facts.acpProtocol !== undefined && facts.acpProtocol !== 1) {
    return { kind: 'protocol', text: t('launchProblem.acpProtocol', { agent: name, version: String(facts.acpProtocol) }) }
  }
  if (facts.unknownMethod) {
    return {
      kind: 'protocol',
      text: version ? t('launchProblem.unknownMethodVersion', { agent: name, version, method: facts.unknownMethod }) : t('launchProblem.unknownMethod', { agent: name, method: facts.unknownMethod }),
      action: update
    }
  }

  if (facts.keyMissing) return { kind: 'signed-out', text: t('launchProblem.noKey', { agent: name }), action: facts.signIn ?? 'open-settings' }
  if (facts.signedOut) return { kind: 'signed-out', text: t('launchProblem.signedOut', { agent: name }), action: facts.signIn ?? 'open-settings' }

  return { kind: 'other', text: facts.error?.trim() || t('launchProblem.failed', { agent: name }) }
}
