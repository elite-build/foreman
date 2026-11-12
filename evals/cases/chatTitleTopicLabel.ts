import { ONE_SHOT_SYSTEM_PROMPT, cleanTitle, titlePrompt } from '../../src/shared/chatTitle'
import type { EvalCase, Verdict } from '../types'

/** The words a title must not open with: the prompt says "never with words like Fix or Investigate". */
const PROGRESS_WORDS = ['fix', 'fixing', 'investigate', 'investigating', 'debug', 'debugging', 'update', 'updating', 'add', 'adding', 'implement', 'implementing', 'make', 'resolve']

/** The shape every title must have: what the app stores after cleaning the answer. */
export function titleShape(raw: string): Verdict {
  const title = cleanTitle(raw)
  if (!title) return { pass: false, reason: 'empty title' }
  if (raw.trim().split('\n').length > 1) return { pass: false, reason: `more than one line: ${JSON.stringify(raw.trim().slice(0, 80))}` }
  if (/["'`]/.test(raw.trim()[0] ?? '') || /["'`.!?:;,]$/.test(raw.trim())) return { pass: false, reason: `quotes or punctuation around the title: ${JSON.stringify(raw.trim())}` }
  const words = title.split(/\s+/).length
  if (words < 2 || words > 5) return { pass: false, reason: `${words} words, not 2 to 5: ${JSON.stringify(title)}` }
  return { pass: true, reason: `${JSON.stringify(title)}` }
}

/** Shape, and a topic label: not a progress update that opens with a verb. */
export function topicLabel(raw: string): Verdict {
  const shape = titleShape(raw)
  if (!shape.pass) return shape
  const first = cleanTitle(raw).split(/\s+/)[0].toLowerCase()
  return PROGRESS_WORDS.includes(first) ? { pass: false, reason: `opens with “${first}”, a progress word: ${JSON.stringify(cleanTitle(raw))}` } : shape
}

/** The title prompt (sessions.ts nameSession), asked of the one-shot model as the app asks it. */
export const chatTitleTopicLabel: EvalCase<(text: string) => string> = {
  id: 'chat-title-topic-label',
  title: 'A chat’s title is a short topic label, not a progress update',
  source: 'The title prompt’s own rule (src/shared/chatTitle.ts): titles are 2 to 5 word topic labels that never open with “Fix” or “Investigate”. A bug report is the message most likely to pull a title into “Fix …”.',
  before: { none: 'The title prompt has been this text since the initial commit (bbef7f3); no earlier text exists.' },
  after: titlePrompt,
  build: (prompt, scenario) => ({
    system: ONE_SHOT_SYSTEM_PROMPT,
    prompt: prompt(
      scenario === 'probe'
        ? 'When I click the Save button on the settings page after my session has expired, nothing happens and there is no error. It should ask me to sign in again. Please fix this.'
        : 'Add a CSV export to the usage page so people can take the numbers into a spreadsheet.'
    )
  }),
  check: (output, scenario) => (scenario === 'probe' ? topicLabel(output.text) : titleShape(output.text))
}
