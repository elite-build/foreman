// Instructions handed to the agent for git and review actions. The app
// attaches them as a markdown file and sends a short chat message.
import type { DiffComment } from './types'

function custom(text: string): string {
  const trimmed = text.trim()
  return trimmed ? `\n\n## The user's preferences (these take precedence)\n\n${trimmed}\n` : ''
}

export function createPrInstructions(options: { base: string; draft: boolean; customPrompt: string; hasDiffTool: boolean }): string {
  const { base, draft } = options
  return `# Create a pull request

1. If there are uncommitted changes, commit them with a clear message that follows this repository's conventions (look at \`git log\`).
2. Push the branch: \`git push -u origin HEAD\`.
3. Review everything on this branch, not just the latest change: ${
    options.hasDiffTool ? 'use the GetWorkspaceDiff tool (start with stat: true), or ' : ''
  }\`git diff origin/${base}...HEAD\`.
4. Create the pull request with the GitHub CLI:
   \`gh pr create --base ${base} --title "<title>" --body "<body>"${draft ? ' --draft' : ''}\`
   - Title: under 80 characters, describing what the change does.
   - Body: if the repository has a pull request template (\`.github/pull_request_template.md\`, \`PULL_REQUEST_TEMPLATE.md\` or \`docs/pull_request_template.md\`), fill it in. Otherwise write at most five sentences covering all the changes on the branch.
5. Reply with the pull request URL.${custom(options.customPrompt)}`
}

export function fixErrorsInstructions(customPrompt: string): string {
  return `# Fix failing CI checks

The attached logs are from the failing checks on this branch's pull request.

1. Read the logs and find the root cause of each failure. Reproduce locally when you can.
2. Fix the problem in the code (not by disabling or skipping the check).
3. Commit and push the fix: \`git push\`.
4. Summarize what failed and what you changed.${custom(customPrompt)}`
}

export function resolveConflictsMessage(base: string, customPrompt: string): string {
  return `Merge origin/${base} into this branch (\`git fetch origin && git merge origin/${base}\`), resolve the conflicts carefully keeping both sides' intent, run the relevant checks, then commit and push.${custom(customPrompt)}`
}

export function reviewInstructions(options: { base: string; customPrompt: string; hasDiffTool: boolean }): string {
  return `# Code review

Review the changes in this workspace compared with origin/${options.base}, including uncommitted work${
    options.hasDiffTool ? ' (use the GetWorkspaceDiff tool, starting with stat: true)' : ` (\`git diff origin/${options.base}\`)`
  }.

- Only flag discrete, actionable problems introduced by these changes that the author would want to fix: bugs, regressions, security issues, broken edge cases, missing error handling. Skip style preferences and nitpicks.
- Keep each comment brief and matter-of-fact, pointing at a specific line (or a range of at most a few lines).
${
  options.hasDiffTool
    ? '- Leave one DiffComment per issue (file path relative to the repository, line number in the new version, short explanation).\n'
    : ''
}- Finish with a short list of your findings and the files they're in, or say the changes look good.${custom(options.customPrompt)}`
}

/** Pending review comments from the user, appended to their next message. */
export function commentsBlock(comments: DiffComment[]): string {
  if (!comments.length) return ''
  const lines = comments.map((c) => {
    const text = c.body.replace(/\s+/g, ' ').trim()
    const sel = c.selection
    if (!sel) return `- ${c.file}:${c.line} — ${text}`
    // #15: a comment on selected lines says which side and quotes them as seen.
    const range = sel.start === sel.end ? `${sel.start}` : `${sel.start}-${sel.end}`
    return `- ${c.file}:${range} (${sel.side} side) — ${text}\n${sel.lines.map((l) => `    > ${l}`).join('\n')}`
  })
  return `\n\nThe user left ${comments.length} review comment${comments.length === 1 ? '' : 's'} on the diff. Address each one:\n${lines.join('\n')}`
}
