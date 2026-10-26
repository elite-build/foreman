// What the settings, repository and environment commands read from outside the request: a file, standard
// input, a no-echo prompt. Everything goes through `io` so a test can stand in for a terminal. Nothing here
// prints a value, and a secret is never read from the command line.
import fs from 'node:fs/promises'
import path from 'node:path'
import { commandName, type CommandSpec } from '../../shared/cliCommands'
import { CliError, usageError } from '../client'
import type { Context } from '../command'
import { columns } from '../output'
import { ERROR_EXIT } from '../protocol'

/** The terminal and the disk, replaceable by a test. */
export const io = {
  stdinIsTTY: (): boolean => Boolean(process.stdin.isTTY),
  stdoutIsTTY: (): boolean => Boolean(process.stdout.isTTY),
  async readStdin(): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
    return Buffer.concat(chunks).toString('utf8')
  },
  readFile: (file: string, cwd: string): Promise<string> => fs.readFile(path.resolve(cwd, file), 'utf8'),
  readBytes: (file: string, cwd: string): Promise<Buffer> => fs.readFile(path.resolve(cwd, file)),
  writeFile: (file: string, cwd: string, text: string): Promise<void> => fs.writeFile(path.resolve(cwd, file), text, 'utf8'),
  // The question goes to stderr; what is typed is not shown. (prompt.ts's readPassphrase would answer from
  // FOREMAN_PASSPHRASE, which is not a secret's value, so this does not reuse it.)
  promptSecret(question: string): Promise<string> {
    return new Promise((resolve) => {
      const input = process.stdin
      process.stderr.write(question)
      let value = ''
      input.setRawMode(true)
      input.resume()
      input.setEncoding('utf8')
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === '\u0003') {
            input.setRawMode(false)
            process.stderr.write('\n')
            process.exit(130)
          }
          if (ch === '\r' || ch === '\n') {
            input.setRawMode(false)
            input.pause()
            input.off('data', onData)
            process.stderr.write('\n')
            return resolve(value)
          }
          if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
          else value += ch
        }
      }
      input.on('data', onData)
    })
  }
}

export const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
export const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

/** One trailing line break, as `echo` and most pipelines add; nothing else. */
export function dropFinalNewline(text: string): string {
  return text.replace(/\r?\n$/, '')
}

/**
 * A secret's value: from standard input with --stdin, otherwise typed at a prompt that does not echo.
 * With --stdin on a terminal it is typed at the prompt too (a terminal would echo it). Without a terminal and
 * without --stdin there is nothing to read from: exit 2 says to use --stdin.
 */
export async function readSecret(question: string, { stdin }: { stdin: boolean }): Promise<string> {
  let value: string
  if (io.stdinIsTTY()) value = await io.promptSecret(question)
  else if (stdin) value = dropFinalNewline(await io.readStdin())
  else throw usageError('This needs a value and there is no terminal to ask on. Pipe it in with --stdin.')
  if (!value) throw usageError('The value is empty.')
  return value
}

/** The person answered no: exit 6, nothing was changed. */
export function declined(what = 'Cancelled.'): CliError {
  return new CliError(what, ERROR_EXIT['needs-confirmation'], 'needs-confirmation')
}

/** Print a result: JSON without its `text`, or the text. */
export function show<T extends { text: string }>(ctx: Context, result: T): void {
  const { text, ...rest } = result
  ctx.print(rest, text)
}

/** Words the person typed that name something the command does not know. */
export function unknownVerb(noun: string, word: string, verbs: readonly string[]): CliError {
  return usageError(`foreman ${noun} doesn’t have “${word}”`, `Try: ${verbs.map((v) => `foreman ${noun} ${v}`).join(', ')}`)
}

/** A whole number from an option, from 1 (or from `min`). */
export function wholeNumber(raw: string | undefined, name: string, min = 1): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(n) || n < min) throw usageError(`${name} takes a whole number${min > 0 ? `, from ${min}` : ''}`)
  return n
}

/** `foreman settings` or `foreman repo settings` alone: the verbs under it, one line each. */
export function verbHelp(prefix: string[], specs: CommandSpec[]): string {
  const rows = specs.filter((c) => c.path.length === prefix.length + 1 && prefix.every((p, i) => c.path[i] === p)).map((c) => [`  ${commandName(c)}`, c.summary])
  const noun = prefix.join(' ')
  return [`foreman ${noun}`, '', 'Commands:', columns(rows), '', `foreman help ${noun} <command> shows one in full.`].join('\n')
}
