// `foreman ask "<question>"`: one turn of the Foreman assistant, asked from a terminal. It goes through the same Api
// the Ask Foreman overlay uses (assistantState, assistantSend, assistantItems), so the gate, the operator's tools
// and Privacy mode are the assistant's own. The answer comes back as text; a command the assistant proposes comes
// back as a line for the person to run by hand, and is never run here (plan H3, consensus C19: tier admin, so an
// agent turn can't call it and the launch token is required).
//
// The question gets a conversation of its own, deleted when the answer is in: it neither fills the Assistant
// view's list nor leaves a proposal waiting on a Run button there.
import { foremanRunOf, type PendingRun } from '../../shared/assistant'
import type { ChatItem } from '../../shared/types'
import type { CliHost } from './host'
import { CliCodedError } from './host'
import { invalid, paramsObject, textParam, type MethodDef } from './kit'
import { findWorkspace } from './resolve'

/** How long the command waits for the assistant before it gives back what it has. */
export const ASK_TIMEOUT_SEC = 120

/** A command the assistant proposed: `command` is the whole line (`foreman settings set …`), `summary` what it does. */
export interface AskProposal {
  runId: PendingRun['runId']
  command: string
  summary?: string
}

export interface AskResult {
  // The assistant's words for this question, in the order it wrote them. Empty when it said nothing.
  answer: string
  proposals: AskProposal[]
  // The assistant was still answering when the time ran out; the answer is what it had written by then.
  timedOut?: true
  // The assistant can't run (off, Privacy mode, no signed-in agent): why, in words. Nothing was asked.
  held?: string
}

export interface AskParams {
  question: string
  // A name, id or branch; "." for the workspace `cwd` is in. Optional: no workspace means no context.
  workspace?: string
  cwd?: string
  // Seconds to wait (the command never sends it; tests do).
  timeoutSec?: number
}

/** The answer and proposals a finished (or interrupted) turn left in its thread. */
export function readTurn(items: ChatItem[]): { answer: string; proposals: AskProposal[]; end?: Extract<ChatItem, { kind: 'turn-end' }> } {
  const answer = items
    .filter((item): item is Extract<ChatItem, { kind: 'assistant' }> => item.kind === 'assistant')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n\n')
  const proposals: AskProposal[] = []
  for (const item of items) {
    const run = foremanRunOf(item)
    if (run?.state === 'pending') proposals.push({ runId: run.runId, command: run.command, ...(run.summary ? { summary: run.summary } : {}) })
  }
  return { answer, proposals, end: items.find((item): item is Extract<ChatItem, { kind: 'turn-end' }> => item.kind === 'turn-end') }
}

/** What `ask` leaves behind is nothing: proposals are cancelled (they would sit waiting for a click), then the thread goes. */
async function cleanUp(host: CliHost, threadId: string, proposals: AskProposal[]): Promise<void> {
  for (const proposal of proposals) await host.api.assistantCancelRun(threadId, proposal.runId).catch(() => undefined)
  // Deleting also stops a turn that is still going (a timeout, or the command went away).
  await host.api.assistantDeleteThread(threadId).catch(() => undefined)
}

async function ask(host: CliHost, params: unknown, signal: AbortSignal | undefined): Promise<AskResult> {
  const p = paramsObject(params)
  const question = textParam(p, 'question').trim()
  if (!question) throw invalid('Ask a question: foreman ask "what needs me?"')
  const workspace = textParam(p, 'workspace', { optional: true })?.trim()
  const cwd = textParam(p, 'cwd', { optional: true }) ?? process.cwd()
  const timeoutSec = typeof p.timeoutSec === 'number' && p.timeoutSec > 0 ? p.timeoutSec : ASK_TIMEOUT_SEC
  const context = workspace ? { workspaceId: findWorkspace(host.state(), workspace, cwd).id } : undefined

  // The same gate the overlay's composer shows; its sentence is the reason. No question is sent without it.
  const { gate } = await host.api.assistantState(false)
  if (gate.state !== 'ready') {
    // Loaded here, not at the top: assistant.ts imports the command runner, which imports this registry, so a static import would be a cycle.
    const { gateError } = await import('../assistant')
    return { answer: '', proposals: [], held: gateError(gate) }
  }

  // Listen before asking: the turn can end before assistantSend has returned.
  const ended = new Set<string>()
  let wake: (() => void) | undefined
  const off = host.onEvent((event) => {
    if (event.type !== 'assistant-item' || event.item.kind !== 'turn-end') return
    ended.add(event.threadId)
    wake?.()
  })
  let threadId: string | undefined
  try {
    threadId = (await host.api.assistantSend(null, question, false, context)).threadId
    const id = threadId
    const finished = await new Promise<boolean>((resolve) => {
      if (ended.has(id)) return resolve(true)
      const stop = (value: boolean) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        wake = undefined
        resolve(value)
      }
      const timer = setTimeout(() => stop(false), timeoutSec * 1000)
      const onAbort = () => stop(false)
      wake = () => {
        if (ended.has(id)) stop(true)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
    if (signal?.aborted) throw new CliCodedError('failed', 'Stopped waiting for the assistant.')
    const { answer, proposals, end } = readTurn(await host.api.assistantItems(id))
    if (finished && end && end.outcome !== 'completed') {
      throw new CliCodedError('failed', end.error ?? (end.outcome === 'cancelled' ? 'The assistant was stopped before it answered.' : 'The assistant ended without an answer.'))
    }
    await cleanUp(host, id, proposals)
    threadId = undefined
    return { answer, proposals, ...(finished ? {} : { timedOut: true as const }) }
  } finally {
    off()
    // A failure or a command that went away: nothing is left running or waiting.
    if (threadId) await cleanUp(host, threadId, readTurn(await host.api.assistantItems(threadId).catch(() => [])).proposals)
  }
}

export const ASK_METHODS: Record<string, MethodDef> = {
  // admin: it spends the user's agent and shows the Operator's view of their work; never from inside an agent turn.
  ask: { tier: 'admin', handle: async (host, params, ctx) => ask(host, params, ctx.signal) }
}
