// The entry `npm run evals` runs under vitest.evals.config.ts (scripts/evals.mjs starts it): Vitest resolves the source's
// extensionless imports, as it does for the tests, and nothing under tests/ or `npm test` ever includes this file.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import { EMPTY_BASELINE, parseBaseline, serializeBaseline, updateBaseline, type Baseline } from './baseline'
import { CASES, caseProblems } from './cases'
import { DEFAULT_MODEL, USAGE, failed, formatReport, parseArgs, selectCases } from './cli'
import { runModel } from './model'
import { runCases, totalCost } from './runner'

const BASELINE = fileURLToPath(new URL('./baseline.json', import.meta.url))

async function readBaseline(): Promise<Baseline> {
  try {
    return parseBaseline(await readFile(BASELINE, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_BASELINE
    throw err
  }
}

async function main(argv: string[]): Promise<{ text: string; failed: boolean }> {
  const args = parseArgs(argv)
  if (args.help) return { text: USAGE, failed: false }
  const problems = caseProblems()
  if (problems.length) return { text: `The case list is malformed:\n${problems.join('\n')}`, failed: true }
  if (args.list) return { text: CASES.map((c) => `${c.id}  ${c.title}\n    ${'none' in c.before ? `no before: ${c.before.none}` : `before: ${c.before.ref}`}`).join('\n'), failed: false }
  const cases = selectCases(CASES, args.cases)
  const baseline = await readBaseline()
  const started = Date.now()
  const results = await runCases(cases, runModel, {
    model: args.model,
    runs: args.runs,
    concurrency: 4,
    onRun: (done, total) => process.stderr.write(`\r${done}/${total} runs`)
  })
  process.stderr.write(`\r${Math.round((Date.now() - started) / 1000)}s\n`)
  let text = formatReport(results, { model: args.model, baseline, costUsd: totalCost(results) })
  if (args.updateBaseline) {
    const update = updateBaseline(baseline, results, { model: args.model, date: new Date().toISOString().slice(0, 10), allCases: cases.length === CASES.length })
    if ('refused' in update) text += `\n\nBaseline not updated: ${update.refused}`
    else {
      await writeFile(BASELINE, serializeBaseline(update.baseline), 'utf8')
      text += `\n\nBaseline updated for ${args.model} (evals/baseline.json).${args.model === DEFAULT_MODEL ? '' : ` Note: ${DEFAULT_MODEL} is the model baselines are meant for.`}`
    }
  }
  return { text, failed: failed(results, baseline, args.model) }
}

it('runs the evals', { timeout: 2 * 60 * 60 * 1000 }, async () => {
  const outFile = process.env.FOREMAN_EVALS_OUT
  let outcome: { text: string; failed: boolean }
  try {
    outcome = await main(JSON.parse(process.env.FOREMAN_EVALS_ARGS ?? '[]') as string[])
  } catch (err) {
    outcome = { text: err instanceof Error ? err.message : String(err), failed: true }
  }
  // The wrapper prints this after Vitest's own output, and exits with `failed`.
  if (outFile) await writeFile(outFile, JSON.stringify(outcome), 'utf8')
  else console.log(outcome.text)
})
