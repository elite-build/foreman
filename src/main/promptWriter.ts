// Write a full prompt (docs/prompt-writer.md): the New workspace dialog's first message, turned into a better prompt for
// the agent the person picked by one request on the one-shot path, and a second after they answer its questions. What
// can go wrong comes back as a reason, not an error, so the dialog says it in the person's language and leaves their
// text as it was.
import { parsePromptWriterAnswer, promptWriterInputProblem, promptWriterMessage, PROMPT_WRITER_SYSTEM_PROMPT, PROMPT_WRITER_TIMEOUT_MS, type WritePromptInput, type WritePromptResult } from '../shared/promptWriter'

export interface PromptWriterHost {
  privacyMode(): boolean
  locale(): string
  // The one-shot request core makes for employee drafts too: null when no agent here can answer one, or in privacy mode.
  draft(request: { system: string; prompt: string }): Promise<{ text: string } | null>
}

export async function writePrompt(host: PromptWriterHost, input: WritePromptInput, timeoutMs = PROMPT_WRITER_TIMEOUT_MS): Promise<WritePromptResult> {
  // Checked before anything about the request is built, and again by the host's draft.
  if (host.privacyMode()) return { status: 'failed', reason: 'privacy' }
  const problem = promptWriterInputProblem(input)
  if (problem === 'too-long') return { status: 'failed', reason: 'too-long' }
  if (problem) return { status: 'failed', reason: 'invalid' }
  const clean: WritePromptInput = { request: input.request, target: input.target, ...(input.answers ? { answers: input.answers.map((a) => ({ question: a.question, answer: a.answer })) } : {}) }
  let timer: ReturnType<typeof setTimeout> | undefined
  // Promise.race doesn't cancel the request; the dialog drops an answer that comes after it stopped waiting.
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    const answer = await Promise.race([host.draft({ system: PROMPT_WRITER_SYSTEM_PROMPT, prompt: promptWriterMessage(clean, host.locale()) }), timeout])
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
