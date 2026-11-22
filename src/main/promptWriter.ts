// Write a full prompt (docs/prompt-writer.md): the New workspace dialog's first message, turned into a better prompt by
// the model the workspace will start on, for that model, in one request, and a second after the person answers its
// questions. What can go wrong comes back as a reason, not an error, so the dialog says it in the person's language and
// leaves their text as it was.
import { parsePromptWriterAnswer, promptTargetFor, promptWriterInputProblem, promptWriterMessage, promptWriterSystemPrompt, PROMPT_WRITER_ANSWER_SCHEMA, PROMPT_WRITER_TIMEOUT_MS, type WritePromptInput, type WritePromptResult } from '../shared/promptWriter'

export interface PromptWriterRequest {
  system: string
  prompt: string
  schema: Record<string, unknown>
  agent: string
  model: string
  instance?: string
}

export interface PromptWriterHost {
  privacyMode(): boolean
  locale(): string
  // One answer from that agent, model and account with no tools: null when it can't answer one here, or in privacy mode.
  draft(request: PromptWriterRequest): Promise<{ text: string } | null>
}

export async function writePrompt(host: PromptWriterHost, input: WritePromptInput, timeoutMs = PROMPT_WRITER_TIMEOUT_MS): Promise<WritePromptResult> {
  // Checked before anything about the request is built, and again by the host's draft.
  if (host.privacyMode()) return { status: 'failed', reason: 'privacy' }
  const problem = promptWriterInputProblem(input)
  if (problem === 'too-long') return { status: 'failed', reason: 'too-long' }
  if (problem === 'no-agent') return { status: 'failed', reason: 'no-agent' }
  const target = promptTargetFor(input.agent, input.model)
  if (problem || !target) return { status: 'failed', reason: 'invalid' }
  const clean: WritePromptInput = { request: input.request, agent: input.agent, model: input.model, ...(input.instance ? { instance: input.instance } : {}), ...(input.answers ? { answers: input.answers.map((a) => ({ question: a.question, answer: a.answer })) } : {}) }
  let timer: ReturnType<typeof setTimeout> | undefined
  // Promise.race doesn't cancel the request; the dialog drops an answer that comes after it stopped waiting.
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    const request: PromptWriterRequest = {
      system: promptWriterSystemPrompt(target),
      prompt: promptWriterMessage(clean, target, host.locale()),
      schema: PROMPT_WRITER_ANSWER_SCHEMA,
      agent: clean.agent,
      model: clean.model,
      ...(clean.instance ? { instance: clean.instance } : {})
    }
    const answer = await Promise.race([host.draft(request), timeout])
    if (answer === 'timeout') return { status: 'failed', reason: 'timeout' }
    if (!answer) return { status: 'failed', reason: host.privacyMode() ? 'privacy' : 'no-agent' }
    const parsed = parsePromptWriterAnswer(answer.text, clean)
    if (!parsed.ok) {
      console.warn(`Write prompt: the answer didn’t pass the check (${parsed.problem}).`)
      return { status: 'failed', reason: 'invalid' }
    }
    return parsed.result
  } catch (err) {
    console.warn('Write prompt:', err instanceof Error ? err.message : err)
    return { status: 'failed', reason: 'error' }
  } finally {
    clearTimeout(timer)
  }
}
