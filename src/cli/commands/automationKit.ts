// What the loadout, template, schedule, integration and data commands share: reading words and numbers from
// what was typed, printing a result, and the ask-then-act pattern of every command that shows a preview first.
import { usageError } from '../client'
import type { Context } from '../command'
import { io, str } from './input'

export { io, str }

/** A word that names a number of the kind `loadouts set 2`: a whole number from 1. */
export function slotNumber(raw: string | undefined, name: string): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim()) || Number(raw) < 1) throw usageError(`${name} is a slot number, from 1 (\`foreman loadouts\` lists them).`)
  return Number(raw)
}

/** `--max-minutes 30`: a whole number or nothing. */
export function wholeOption(raw: unknown, flag: string, min = 1): number | undefined {
  const text = str(raw)
  if (text === undefined) return undefined
  if (!/^\d+$/.test(text.trim()) || Number(text) < min) throw usageError(`${flag} takes a whole number${min > 0 ? `, from ${min}` : ''}.`)
  return Number(text)
}

/** `a,b` or `a, b` as a list; empty items dropped. */
export function commaList(raw: unknown): string[] | undefined {
  const text = str(raw)
  if (text === undefined) return undefined
  return text.split(',').map((x) => x.trim()).filter(Boolean)
}

/** More words than the command takes. */
export function noMoreWords(ctx: Context, count: number, usage: string): void {
  if (ctx.args.length > count) throw usageError(`Too many words: ${ctx.args.slice(count).map((w) => `“${w}”`).join(' ')}.`, usage)
}

/** A command that may start with an optional word (`foreman loadouts list`): that word, when it is there, must be `word`. */
export function optionalWord(ctx: Context, word: string, usage: string): void {
  if (ctx.args.length > 1 || (ctx.args[0] !== undefined && ctx.args[0] !== word)) throw usageError(`foreman ${usage} takes no words, or just “${word}”.`)
}

/** The answer: its JSON document, or its `text`. */
export function printText(ctx: Context, result: { text: string }): void {
  ctx.print(result, () => result.text)
}

/** What a person said no to: nothing changed, and the exit code says so. */
export function declinedNote(ctx: Context, text: string): void {
  ctx.note(text)
  process.exitCode = 1
}

/**
 * Show a preview on stderr and ask. A script that can't be asked gets the preview as data under --json (the
 * thrown needs-confirmation error carries the exit code 6). Returns false when the person said no.
 */
export async function previewAndAsk(ctx: Context, previewText: string, question: string, jsonValue: unknown): Promise<boolean> {
  if (!ctx.quiet) console.error(previewText)
  try {
    return await ctx.confirm(question)
  } catch (err) {
    if (ctx.json) ctx.print(jsonValue, () => previewText)
    throw err
  }
}

/** A prompt's text for `--file` or `--stdin`: exactly one of them, or neither. */
export async function readTextSource(ctx: Context, what: string, { required }: { required: boolean }): Promise<string | undefined> {
  const file = str(ctx.opts.file)
  const stdin = Boolean(ctx.opts.stdin)
  if (file !== undefined && stdin) throw usageError(`Give the ${what} one way: --file or --stdin.`)
  if (file !== undefined) {
    try {
      return await io.readFile(file, ctx.cwd)
    } catch (err) {
      throw usageError(`Can’t read ${file}: ${(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (err as Error).message}`)
    }
  }
  if (stdin) return io.readStdin()
  if (required) throw usageError(`Give the ${what} with --file <path> or --stdin.`)
  return undefined
}
