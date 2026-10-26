// What the commands print, and the one question they may ask. Output is plain text (no color, so
// NO_COLOR needs nothing from us) or, for scripts, JSON; progress and notes go to stderr so stdout
// stays the answer.
import readline from 'node:readline'
import { CliError } from './client'
import { ERROR_EXIT } from './protocol'

/** `--json` or FOREMAN_JSON=1. */
export function wantsJson(flag: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(flag) || env.FOREMAN_JSON === '1'
}

/** The answer to a command: its JSON document, or the text a person reads. */
export function print(value: unknown, text: string | (() => string), json: boolean): void {
  console.log(json ? JSON.stringify(value, null, 2) : typeof text === 'function' ? text() : text)
}

/** Rows as aligned columns: every column but the last is padded to its widest cell, and trailing space is trimmed. */
export function columns(rows: string[][], gap = 2): string {
  const widths: number[] = []
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)))
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] + gap)))
        .join('')
        .trimEnd()
    )
    .join('\n')
}

export interface ConfirmOptions {
  yes?: boolean
  // Whether a person can answer; default: stdin is a terminal.
  interactive?: boolean
  // Ask on stderr and read one line; replaceable so a test needn't own a terminal.
  ask?: (question: string) => Promise<string>
}

function askOnTerminal(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

/**
 * Ask before something that can't be undone. `--yes` answers for the person. Without it a terminal gets a
 * y/N question on stderr; a script (no terminal) gets an error, so nothing is ever approved silently.
 */
export async function confirm(question: string, options: ConfirmOptions = {}): Promise<boolean> {
  if (options.yes) return true
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY)
  if (!interactive) throw new CliError('this needs confirmation; run it in a terminal or add --yes', ERROR_EXIT['needs-confirmation'], 'needs-confirmation')
  const answer = await (options.ask ?? askOnTerminal)(`${question} [y/N] `)
  return /^y(es)?$/i.test(answer.trim())
}

/** Progress and notes: stderr, and nothing with --quiet. */
export function note(text: string, quiet: boolean): void {
  if (!quiet) console.error(text)
}
