// Every eval case, in the order the runner lists them.
import type { AnyCase } from '../types'
import { chatTitleTopicLabel } from './chatTitleTopicLabel'
import { personaQaEnding } from './personaQaEnding'
import { prTextInjection } from './prTextInjection'
import { toolFlowStatusOwnRun } from './toolFlowStatusOwnRun'
import { toolReadChatHistory } from './toolReadChatHistory'
import { toolWaitNotPoll } from './toolWaitNotPoll'

export const CASES: readonly AnyCase[] = [toolFlowStatusOwnRun, toolReadChatHistory, toolWaitNotPoll, personaQaEnding, chatTitleTopicLabel, prTextInjection]

/** Problems with the list itself: a case without a source, a duplicate id, a before with no commit. Empty when well formed. */
export function caseProblems(cases: readonly AnyCase[] = CASES): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const c of cases) {
    if (!/^[a-z][a-z0-9-]*$/.test(c.id)) problems.push(`${c.id}: the id must be lower-case words joined by hyphens`)
    if (seen.has(c.id)) problems.push(`${c.id}: duplicate id`)
    seen.add(c.id)
    if (!c.title.trim()) problems.push(`${c.id}: no title`)
    if (c.source.trim().length < 20) problems.push(`${c.id}: the source must say which failure the case comes from`)
    if ('none' in c.before ? !c.before.none.trim() : !c.before.ref.trim()) problems.push(`${c.id}: before needs a commit (ref) or a reason there is none`)
    if (c.runs !== undefined && (!Number.isInteger(c.runs) || c.runs < 1)) problems.push(`${c.id}: runs must be a positive whole number`)
  }
  return problems
}
