import { z } from 'zod'
import { autoReviewPrompt, parseFindings } from '../../src/shared/autoReview'
import { parseFrontmatter, personaTurnText } from '../../src/shared/personas'
import { PERSONA_STARTERS } from '../../src/shared/personaStarters'
import type { EvalCase, FakeTool } from '../types'

function currentBody(name: string): string {
  const starter = PERSONA_STARTERS.find((s) => s.name === name)
  const parsed = starter && parseFrontmatter(starter.markdown)
  if (!parsed) throw new Error(`No starter persona called ${name}`)
  return parsed.body.trim()
}

/**
 * The qa-engineer body before #106 (commit f8436a7): it told the agent to report through `foreman review` and to say
 * `done` only when it found nothing, so a review step ended without the findings block Foreman reads a verdict from.
 */
const BEFORE = `You are the QA engineer on this change. You don't fix; you find. Read the diff and the check
results, run the tests that cover the changed files, and report what a reviewer would want to
know, with file and line, through \`foreman review\`. Say \`done\` only when you found nothing.`

/** A change with nothing wrong in it, self-contained so that no reader can reasonably ask about code outside the diff. */
const CLEAN_DIFF = `diff --git a/src/usage/clamp.ts b/src/usage/clamp.ts
new file mode 100644
--- /dev/null
+++ b/src/usage/clamp.ts
@@ -0,0 +1,3 @@
+export function clamp(value: number, min: number, max: number): number {
+  return Math.min(Math.max(value, min), max)
+}
diff --git a/tests/clamp.test.ts b/tests/clamp.test.ts
new file mode 100644
--- /dev/null
+++ b/tests/clamp.test.ts
@@ -0,0 +1,7 @@
+import { expect, it } from 'vitest'
+import { clamp } from '../src/usage/clamp'
+
+it('keeps a value inside its range', () => {
+  expect(clamp(5, 0, 10)).toBe(5)
+  expect(clamp(-1, 0, 10)).toBe(0)
+  expect(clamp(11, 0, 10)).toBe(10)
+})
`

const BUGGY_DIFF = `diff --git a/src/usage/paginate.ts b/src/usage/paginate.ts
--- a/src/usage/paginate.ts
+++ b/src/usage/paginate.ts
@@ -3,6 +3,6 @@
 export function paginate<T>(rows: T[], page: number, size: number): T[] {
-  const start = (page - 1) * size
-  return rows.slice(start, start + size)
+  const start = page * size
+  return rows.slice(start, start + size)
 }
diff --git a/tests/paginate.test.ts b/tests/paginate.test.ts
--- a/tests/paginate.test.ts
+++ b/tests/paginate.test.ts
@@ -1,4 +1,4 @@
-it('page 1 is the first rows', () => expect(paginate([1, 2, 3, 4], 1, 2)).toEqual([1, 2]))
+it('page 1 is the first rows', () => expect(paginate([1, 2, 3, 4], 1, 2)).toEqual([3, 4]))
`

/** A command that runs the tests (reading a file with a shell is not what the old body asked for). */
export const RUNS_TESTS = /\b(test|tests|vitest|jest|pytest|mocha)\b/i

/**
 * The old body also said to "run the tests that cover the changed files", in a step whose prompt says not to run shell commands
 * (a request for one stops the review). A shell the probe offers answers no, and an attempt to run the tests with it is a failure.
 */
const SHELL: FakeTool = { name: 'Bash', description: 'Run a shell command in the workspace.', schema: { command: z.string() }, reply: () => 'This step has no shell: the command was not run.' }

/** #106: the review step's ending. The prompt is the one a review step is sent; the persona body is what differs. The probe is a clean diff, where the old body said to say `done`; the control a diff with a real bug, where the block must still hold the finding. */
export const personaQaEnding: EvalCase<string> = {
  id: 'persona-qa-ending',
  title: 'The qa-engineer ends its review step with the foreman-findings block',
  source: 'PR #106 (commit f8436a7), docs/persona-template.md "Why" 1 and 2: the qa-engineer persona said to report through `foreman review` and to say `done` when clean (neither is a fact a flow can read, so a QA step ended undecided and looped the developer on findings that were not there), and to run the tests in a step that has no shell.',
  before: { value: BEFORE, ref: 'f8436a7^' },
  after: currentBody('qa-engineer'),
  build: (body, scenario) => ({
    system: personaTurnText('qa-engineer', body),
    prompt: `${autoReviewPrompt('')}\n\nThe diff Foreman captured:\n\n${scenario === 'probe' ? CLEAN_DIFF : BUGGY_DIFF}`,
    ...(scenario === 'probe' ? { tools: [SHELL], maxTurns: 6 } : {})
  }),
  check: (output, scenario) => {
    const shell = output.calls.find((c) => c.name === 'Bash' && RUNS_TESTS.test(String(c.args.command ?? '')))
    if (shell) return { pass: false, reason: `asked to run the tests in a step with no shell: ${JSON.stringify(shell.args.command).slice(0, 80)}` }
    const findings = parseFindings(output.text)
    if (!findings) return { pass: false, reason: 'no readable foreman-findings block' }
    if (!output.text.trimEnd().endsWith('```')) return { pass: false, reason: 'the block is not the end of the answer (something follows it)' }
    // The probe is about the ending, not the model's judgement: a model may nitpick a clean diff, and the step still ended the way Foreman reads.
    if (scenario === 'probe') return { pass: true, reason: `ended with the findings block (${findings.length} finding(s))` }
    return findings.length > 0 ? { pass: true, reason: `ended with ${findings.length} finding(s)` } : { pass: false, reason: 'ended with [] on a diff with a real bug' }
  }
}
