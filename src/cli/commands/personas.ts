// `foreman persona …`: who a flow's step is (docs/loops-and-graphs.md, "Personas: who a step is"). list and show read
// every source; add saves a personal persona from a markdown file and remove deletes one, as the persona editor does.
import type { PersonaAddResult } from '../../shared/cli/personas'
import { usageError } from '../client'
import type { Run } from '../command'
import { declinedNote, io, noMoreWords, printText, str } from './automationKit'

const list: Run = async (ctx) => {
  noMoreWords(ctx, 0, 'foreman persona list [--repo <name|path>]')
  printText(ctx, await ctx.send<{ text: string }>('persona-list', { repo: str(ctx.opts.repo), cwd: ctx.cwd }))
}

const show: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman persona show <persona>')
  if (!ctx.args[0]) throw usageError('Name a persona. `foreman persona list` lists them.')
  printText(ctx, await ctx.send<{ text: string }>('persona-show', { persona: ctx.args[0], repo: str(ctx.opts.repo), cwd: ctx.cwd }))
}

const add: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman persona add <file.md>')
  const [file] = ctx.args
  if (!file) throw usageError('Give the persona’s markdown file: foreman persona add <file.md>')
  let markdown: string
  try {
    markdown = await io.readFile(file, ctx.cwd)
  } catch (err) {
    throw usageError(`Can’t read ${file}: ${(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (err as Error).message}`)
  }
  const result = await ctx.send<PersonaAddResult>('persona-add', { markdown })
  printText(ctx, result)
  if (!result.saved) process.exitCode = 1
}

const remove: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman persona remove <persona>')
  const [persona] = ctx.args
  if (!persona) throw usageError('Name a personal persona. `foreman persona list` lists them.')
  if (!(await ctx.confirm(`Remove the personal persona “${persona}”?`))) return declinedNote(ctx, 'Nothing removed.')
  printText(ctx, await ctx.send<{ text: string }>('persona-remove', { persona }))
}

export const personaRunners: Record<string, Run> = {
  'persona list': list,
  'persona show': show,
  'persona add': add,
  'persona remove': remove
}
