// The words that ask a model for a chat's title, and how its answer is cleaned up. Shared so that evals/ runs the very text the
// app sends (docs/agents.md 9.6) and a change to it is a change to what the eval measures.

/** The system prompt of every one-shot label (a chat title, a repository's icon description): the model's only instruction besides the prompt. */
export const ONE_SHOT_SYSTEM_PROMPT = 'You write short labels. Reply with the label only, no quotes or punctuation.'

/** The prompt for a chat's title: its first message (cut to 2000 characters) and the repository's naming preferences, if any. */
export function titlePrompt(text: string, preferences = ''): string {
  return [
    'Write a 2-5 word title for this coding task. It is a topic label, not a progress update:',
    'start with the most distinctive noun and never with words like Fix or Investigate.',
    preferences ? `The user's naming preferences: ${preferences}` : '',
    '',
    'Task:',
    text.slice(0, 2000)
  ].join('\n')
}

/** The model's answer as a title: one line, no quotes around it or full stop after it, at most 60 characters. */
export function cleanTitle(answer: string): string {
  return answer.replace(/^["'`]+|["'`.]+$/g, '').split('\n')[0].trim().slice(0, 60)
}
