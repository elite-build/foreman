// `foreman env …`, `keys …`, `github …`, `gitlab …`, `cloud token …` and `agents key`.
// Secrets: never on the command line (except `env set`, whose help warns), never printed, never logged. A value comes from
// standard input or a prompt that does not echo; a result shows names, origins and at most the last four characters.
import type {
  AgentKeySetResult,
  CloudTokenStatusResult,
  EnvFilesResult,
  EnvImportResult,
  EnvListResult,
  EnvRenameResult,
  EnvRevealResult,
  EnvSetResult,
  EnvUnsetResult,
  GithubAccountsResult,
  GithubStatusResult,
  GitlabConnectionResult,
  GitlabListResult,
  KeysAgentsResult,
  KeysListResult,
  KeysSetResult,
  TokenSavedResult
} from '../../shared/cli/env'
import type { EnvVarRow } from '../../shared/types'
import { CliError, usageError } from '../client'
import type { Context, Run } from '../command'
import { columns } from '../output'
import { ERROR_EXIT } from '../protocol'
import { declined, io, readSecret, show, str, unknownVerb } from './input'

const scope = (ctx: Context) => ({ repo: str(ctx.opts.repo), cwd: ctx.cwd })

/** `foreman env`, `foreman keys`, … take an optional `list`/`status` word; any other word is a mistake. */
function onlyVerb(ctx: Context, noun: string, verbs: readonly string[]): void {
  const [word, ...extra] = ctx.args
  if (word !== undefined && !verbs.includes(word)) throw unknownVerb(noun, word, verbs)
  if (extra.length) throw usageError(`foreman ${noun} takes no more words after “${word}”`)
}

// ---- environment variables ----

const envList: Run = async (ctx) => {
  onlyVerb(ctx, 'env', ['list'])
  show(ctx, await ctx.send<EnvListResult>('env-list', scope(ctx)))
}

const envSet: Run = async (ctx) => {
  const [key, value, ...extra] = ctx.args
  if (!key) throw usageError('Name the variable: foreman env set <KEY> [VALUE]')
  if (extra.length) throw usageError('The value is one word: quote it if it has spaces. A secret is better piped in with --stdin.')
  const stdin = ctx.opts.stdin === true
  if (value !== undefined && stdin) throw usageError('Give the value on the command line or with --stdin, not both.')
  const secret = value ?? (await readSecret(`Value for ${key} (not shown): `, { stdin }))
  show(ctx, await ctx.send<EnvSetResult>('env-set', { ...scope(ctx), key, value: secret }))
}

const envUnset: Run = async (ctx) => {
  if (!ctx.args.length) throw usageError('Name the variables to remove: foreman env unset <KEY>...')
  if (ctx.args.length > 3 && !(await ctx.confirm(`Remove ${ctx.args.length} variables?`))) throw declined()
  show(ctx, await ctx.send<EnvUnsetResult>('env-unset', { ...scope(ctx), keys: ctx.args }))
}

const envRename: Run = async (ctx) => {
  if (ctx.args.length !== 2) throw usageError('Give the old and the new name: foreman env rename <OLD> <NEW>')
  show(ctx, await ctx.send<EnvRenameResult>('env-rename', { ...scope(ctx), from: ctx.args[0], to: ctx.args[1] }))
}

/** Said when a value is about to be printed: only to a person at a terminal, or when asked with --force. */
function refuseUnlessTerminal(ctx: Context, what: string): void {
  if (io.stdoutIsTTY() || ctx.opts.force === true) return
  throw new CliError(`${what} is only printed to a terminal. Add --force to print it into a pipe or a file.`, ERROR_EXIT.refused, 'refused')
}

/** The value, to standard output; the notice that it was shown, to standard error whatever --quiet says. */
function printRevealed(ctx: Context, name: string, revealed: EnvRevealResult): void {
  console.log(ctx.json ? JSON.stringify({ key: revealed.key, value: revealed.value }, null, 2) : revealed.value)
  console.error(`revealed ${name}`)
}

const LAYER_NAMES: Record<string, string> = { shared: 'the committed settings file', inherited: 'your own variables' }

function originText(row: EnvVarRow): string {
  const where = row.origin === 'saved' ? 'saved in Foreman' : row.origin === 'file' ? `from ${row.file ?? 'an env file'}` : `from ${row.file ?? 'the committed settings file'}`
  return `${where}${row.overridden ? ' (overridden here)' : ''}`
}

const envGet: Run = async (ctx) => {
  const [key, ...extra] = ctx.args
  if (!key || extra.length) throw usageError('Name one variable: foreman env get <KEY> [--reveal]')
  if (ctx.opts.reveal === true) {
    refuseUnlessTerminal(ctx, `A variable's value`)
    printRevealed(ctx, key, await ctx.send<EnvRevealResult>('env-reveal', { ...scope(ctx), key }))
    return
  }
  const listing = await ctx.send<EnvListResult>('env-list', scope(ctx))
  const rows = [
    ...listing.vars.map((row) => ({ layer: 'own', row })),
    ...(listing.shared ?? []).map((row) => ({ layer: 'shared', row })),
    ...(listing.inherited ?? []).map((row) => ({ layer: 'inherited', row }))
  ].filter((r) => r.row.key === key)
  if (!rows.length) throw new CliError(`No variable called '${key}' ${listing.scope.kind === 'repo' ? `for ${listing.scope.repo?.name ?? 'that repository'}` : 'of yours'}. \`foreman env\` lists them.`, ERROR_EXIT['not-found'], 'not-found')
  ctx.print({ scope: listing.scope, key, origins: rows.map((r) => ({ layer: r.layer, ...r.row })) }, () =>
    rows.map((r) => `${key}  ${originText(r.row)}${r.layer === 'own' ? '' : ` (${LAYER_NAMES[r.layer]})`}`).join('\n')
  )
}

const envFiles: Run = async (ctx) => {
  const [verb = 'list', path, ...extra] = ctx.args
  if (verb !== 'list' && verb !== 'add' && verb !== 'remove') throw unknownVerb('env files', verb, ['list', 'add', 'remove'])
  if (extra.length || (verb === 'list' && path !== undefined)) throw usageError(`foreman env files ${verb}${verb === 'list' ? '' : ' <path>'} takes no more words`)
  if (verb !== 'list') {
    if (!path) throw usageError(`Give the env file: foreman env files ${verb} <path>`)
    return show(ctx, await ctx.send<EnvFilesResult>('env-files', { ...scope(ctx), verb, path }))
  }
  // Listing is what `env` already shows, so it uses the read method.
  const listing = await ctx.send<EnvListResult>('env-list', scope(ctx))
  const who = listing.scope.kind === 'repo' ? (listing.scope.repo?.name ?? 'the repository') : 'you'
  const files = listing.files.map((f) => ({ path: f.path, resolved: f.resolved, count: f.count, ...(f.error ? { error: f.error } : {}) }))
  ctx.print({ scope: listing.scope, files }, () => [`Env files for ${who}:`, ...(files.length ? columns(files.map((f) => [`  ${f.path}`, f.error ?? `${f.count} variable${f.count === 1 ? '' : 's'}`])).split('\n') : ['  none'])].join('\n'))
}

/**
 * A .env file as [name, value] pairs: KEY=VALUE lines (an `export ` prefix is fine), # comments and blank lines skipped,
 * quotes stripped. Double quotes understand \n \r \t \" \\ and may span lines; single quotes are literal; an unquoted value
 * ends at a ` #` comment. `skipped` counts the lines that were not KEY=VALUE (never their text: it could be a secret).
 */
export function parseEnvFile(text: string): { entries: [string, string][]; skipped: number } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const entries: [string, string][] = []
  let skipped = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const body = line.replace(/^export\s+/, '')
    const eq = body.indexOf('=')
    const key = eq < 1 ? '' : body.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      skipped++
      continue
    }
    const rest = body.slice(eq + 1).trim()
    const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : ''
    if (!quote) {
      entries.push([key, rest.replace(/\s+#.*$/, '').trim()])
      continue
    }
    // Find the closing quote, on this line or a later one (a double-quoted value may hold line breaks).
    let value = ''
    let body2 = rest.slice(1)
    let closed = false
    for (;;) {
      let j = 0
      while (j < body2.length) {
        const ch = body2[j]
        if (quote === '"' && ch === '\\' && j + 1 < body2.length) {
          const next = body2[j + 1]
          value += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next
          j += 2
          continue
        }
        if (ch === quote) {
          closed = true
          break
        }
        value += ch
        j++
      }
      if (closed || quote === "'" || i + 1 >= lines.length) break
      value += '\n'
      body2 = lines[++i]
    }
    if (!closed) {
      skipped++
      continue
    }
    entries.push([key, value])
  }
  return { entries, skipped }
}

const envImport: Run = async (ctx) => {
  const [file, ...extra] = ctx.args
  if (!file || extra.length) throw usageError('Name one .env file: foreman env import <file>')
  let text: string
  try {
    text = await io.readFile(file, ctx.cwd)
  } catch {
    throw new CliError(`Can’t read ${file}.`, ERROR_EXIT['not-found'], 'not-found')
  }
  const { entries, skipped } = parseEnvFile(text)
  if (skipped) ctx.note(`Skipped ${skipped} line${skipped === 1 ? '' : 's'} that ${skipped === 1 ? 'isn’t' : 'aren’t'} KEY=VALUE.`)
  if (!entries.length) throw usageError(`${file} has no KEY=VALUE lines.`)
  const preview = await ctx.send<EnvImportResult>('env-import', { ...scope(ctx), entries, dryRun: true })
  if (!ctx.json) console.log(preview.text)
  if (!(await ctx.confirm(`Save ${preview.names.length} variable${preview.names.length === 1 ? '' : 's'}?`))) throw declined()
  show(ctx, await ctx.send<EnvImportResult>('env-import', { ...scope(ctx), entries }))
}

// ---- provider keys ----

const keysList: Run = async (ctx) => {
  onlyVerb(ctx, 'keys', ['list'])
  show(ctx, await ctx.send<KeysListResult>('keys-list'))
}

const keysSet: Run = async (ctx) => {
  const [envVar, ...extra] = ctx.args
  if (!envVar) throw usageError('Name the variable: foreman keys set <ENV_VAR>')
  if (extra.length) throw usageError('A key is never taken from the command line (it would stay in your shell history). Type it at the prompt or pipe it in with --stdin.')
  const fromShell = ctx.opts['from-shell'] === true
  const stdin = ctx.opts.stdin === true
  if (fromShell && stdin) throw usageError('Use --stdin or --from-shell, not both.')
  if (fromShell) return show(ctx, await ctx.send<KeysSetResult>('keys-set', { envVar, fromShell: true }))
  const value = await readSecret(`Value for ${envVar} (not shown): `, { stdin })
  show(ctx, await ctx.send<KeysSetResult>('keys-set', { envVar, value }))
}

const keysRemove: Run = async (ctx) => {
  if (ctx.args.length !== 1) throw usageError('Name one key: foreman keys remove <ENV_VAR>')
  if (!(await ctx.confirm(`Delete the saved key ${ctx.args[0]}?`))) throw declined()
  show(ctx, await ctx.send<KeysSetResult>('keys-remove', { envVar: ctx.args[0] }))
}

function keysAgents(method: 'keys-allow' | 'keys-deny'): Run {
  const verb = method === 'keys-allow' ? 'allow' : 'deny'
  return async (ctx) => {
    const [envVar, ...agents] = ctx.args
    if (!envVar || !agents.length) throw usageError(`Name the key and the agents: foreman keys ${verb} <ENV_VAR> <agent>...`)
    show(ctx, await ctx.send<KeysAgentsResult>(method, { envVar, agents }))
  }
}

const keysReveal: Run = async (ctx) => {
  if (ctx.args.length !== 1) throw usageError('Name one key: foreman keys reveal <ENV_VAR>')
  refuseUnlessTerminal(ctx, 'A key')
  printRevealed(ctx, ctx.args[0], await ctx.send<EnvRevealResult>('keys-reveal', { envVar: ctx.args[0] }))
}

// ---- GitHub, GitLab, the cloud setup token, an agent's own key ----

const github: Run = async (ctx) => {
  const [word] = ctx.args
  if (word === 'token') throw usageError('Say what to do with the token: foreman github token set | clear')
  onlyVerb(ctx, 'github', ['status'])
  show(ctx, await ctx.send<GithubStatusResult>('github-status'))
}

const githubAccounts: Run = async (ctx) => {
  show(ctx, await ctx.send<GithubAccountsResult>('github-accounts'))
}

const githubTokenSet: Run = async (ctx) => {
  const token = await readSecret('GitHub token (not shown): ', { stdin: ctx.opts.stdin === true })
  show(ctx, await ctx.send<TokenSavedResult>('github-token-set', { token }))
}

const githubTokenClear: Run = async (ctx) => {
  show(ctx, await ctx.send<TokenSavedResult>('github-token-clear'))
}

const gitlab: Run = async (ctx) => {
  onlyVerb(ctx, 'gitlab', ['list'])
  show(ctx, await ctx.send<GitlabListResult>('gitlab-list'))
}

const gitlabAdd: Run = async (ctx) => {
  if (ctx.args.length !== 1) throw usageError('Give the GitLab address: foreman gitlab add <url>')
  const [url] = ctx.args
  const fromGlab = ctx.opts['from-glab'] === true
  const stdin = ctx.opts['token-stdin'] === true
  if (fromGlab && stdin) throw usageError('Use --token-stdin or --from-glab, not both.')
  if (fromGlab) return show(ctx, await ctx.send<GitlabConnectionResult>('gitlab-add', { url, fromGlab: true }))
  const token = await readSecret(`Token for ${url} (not shown): `, { stdin })
  show(ctx, await ctx.send<GitlabConnectionResult>('gitlab-add', { url, token }))
}

const gitlabRemove: Run = async (ctx) => {
  if (ctx.args.length !== 1) throw usageError('Name the host: foreman gitlab remove <host>')
  if (!(await ctx.confirm(`Forget ${ctx.args[0]} and its token?`))) throw declined()
  show(ctx, await ctx.send<GitlabListResult>('gitlab-remove', { host: ctx.args[0] }))
}

const gitlabTest: Run = async (ctx) => {
  if (ctx.args.length !== 1) throw usageError('Give the GitLab address: foreman gitlab test <url>')
  const result = await ctx.send<GitlabConnectionResult>('gitlab-test', { url: ctx.args[0] })
  show(ctx, result)
  if (!result.ok) process.exitCode = 1
}

const cloudToken: Run = async (ctx) => {
  onlyVerb(ctx, 'cloud token', ['status'])
  show(ctx, await ctx.send<CloudTokenStatusResult>('cloud-token-status'))
}

const cloudTokenSet: Run = async (ctx) => {
  const token = await readSecret('Claude setup token (not shown): ', { stdin: ctx.opts.stdin === true })
  show(ctx, await ctx.send<TokenSavedResult>('cloud-token-set', { token }))
}

const cloudTokenClear: Run = async (ctx) => {
  show(ctx, await ctx.send<TokenSavedResult>('cloud-token-clear'))
}

const agentsKey: Run = async (ctx) => {
  if (ctx.args.length !== 1) throw usageError('Name the agent: foreman agents key <agent>')
  const [agent] = ctx.args
  const remove = ctx.opts.remove === true
  const fromShell = ctx.opts['from-shell'] === true
  const stdin = ctx.opts.stdin === true
  if ([remove, fromShell, stdin].filter(Boolean).length > 1) throw usageError('Use one of --stdin, --from-shell or --remove.')
  if (remove || fromShell) return show(ctx, await ctx.send<AgentKeySetResult>('agents-key-set', { agent, ...(remove ? { remove: true } : { fromShell: true }) }))
  const value = await readSecret(`API key for ${agent} (not shown): `, { stdin })
  show(ctx, await ctx.send<AgentKeySetResult>('agents-key-set', { agent, value }))
}

export const envRunners: Record<string, Run> = {
  env: envList,
  'env set': envSet,
  'env unset': envUnset,
  'env rename': envRename,
  'env get': envGet,
  'env files': envFiles,
  'env import': envImport,
  keys: keysList,
  'keys set': keysSet,
  'keys remove': keysRemove,
  'keys allow': keysAgents('keys-allow'),
  'keys deny': keysAgents('keys-deny'),
  'keys reveal': keysReveal,
  github,
  'github accounts': githubAccounts,
  'github token set': githubTokenSet,
  'github token clear': githubTokenClear,
  gitlab,
  'gitlab add': gitlabAdd,
  'gitlab remove': gitlabRemove,
  'gitlab test': gitlabTest,
  'cloud token': cloudToken,
  'cloud token set': cloudTokenSet,
  'cloud token clear': cloudTokenClear,
  'agents key': agentsKey
}
