// `foreman connections …`, `slack …` and `linear issues`: Settings → Integrations. A token is read from standard input
// (--token-stdin) or a prompt that does not echo it, and is never an argument, so it can't land in a shell history, a
// process list or a log. Provider-specific fields are checked here, from the same table the Settings window uses, before
// anything is read or sent.
import { CLOUD_PROVIDERS } from '../../shared/cloud'
import type { ConnectionsCheckResult, ConnectionsRemoveResult, SlackRulesResult } from '../../shared/cli/integrations'
import { SLACK_EVENTS } from '../../shared/integrations'
import { usageError } from '../client'
import type { Context, Run } from '../command'
import { commaList, declinedNote, io, noMoreWords, optionalWord, previewAndAsk, printText, str } from './automationKit'
import { readSecret, unknownVerb } from './input'

const SERVICES = ['github', 'linear', 'slack', 'vercel', 'e2b', 'daytona', 'docker']

/** The provider fields that have an option, by the field's key. */
const FIELD_FLAGS: Record<string, string> = { teamId: 'team-id', projectId: 'project-id', domain: 'domain', apiUrl: 'api-url', target: 'target', context: 'context', host: 'host' }

const SERVICE_NAMES: Record<string, string> = { github: 'GitHub', linear: 'Linear', slack: 'Slack' }

const list: Run = async (ctx) => {
  optionalWord(ctx, 'list', 'connections')
  printText(ctx, await ctx.send<{ text: string }>('connections-list'))
}

/** What `connections add` sends besides the token, checked against what the service takes. Throws before anything is read. */
function connectionParams(ctx: Context, service: string): Record<string, unknown> {
  const { opts } = ctx
  const provider = (CLOUD_PROVIDERS as Record<string, (typeof CLOUD_PROVIDERS)[keyof typeof CLOUD_PROVIDERS] | undefined>)[service]
  const given = Object.fromEntries(Object.entries(FIELD_FLAGS).flatMap(([key, flag]) => (str(opts[flag])?.trim() ? [[key, (opts[flag] as string).trim()]] : [])))
  const takes = new Set(provider?.connection.fields.filter((f) => !f.secret).map((f) => f.key) ?? [])
  for (const key of Object.keys(given)) if (!takes.has(key)) throw usageError(`--${FIELD_FLAGS[key]} isn’t used by ${service}.`, `foreman help connections add lists what each service takes.`)
  if (service !== 'github' && (opts['gh-account'] !== undefined || opts['gh-active'])) throw usageError('--gh-account and --gh-active are for github.')
  if (service !== 'linear' && opts['agent-access'] !== undefined) throw usageError('--agent-access is for linear.')
  if (service === 'docker' && opts['token-stdin']) throw usageError('Docker has no token: it uses a context or a host (--context, --host), or the current context.')
  const missing = provider?.connection.fields.filter((f) => !f.secret && !f.optional && f.default === undefined && !given[f.key]).map((f) => `--${FIELD_FLAGS[f.key] ?? f.key}`) ?? []
  if (missing.length) throw usageError(`${provider!.label} also needs ${missing.join(' and ')}.`, `Find ${missing.length > 1 ? 'them' : 'it'} in ${provider!.label}’s dashboard (${provider!.docsUrl}).`)
  const access = str(opts['agent-access'])
  if (access !== undefined && !['off', 'read', 'write'].includes(access)) throw usageError('--agent-access is off, read or write.')
  const section = (...keys: string[]) => Object.fromEntries(keys.filter((k) => given[k]).map((k) => [k, given[k]]))
  return {
    service,
    name: str(opts.label),
    ghAccount: str(opts['gh-account']),
    ghActive: opts['gh-active'] ? true : undefined,
    ...(service === 'vercel' ? { vercel: section('teamId', 'projectId') } : {}),
    ...(service === 'docker' ? { docker: section('context', 'host') } : {}),
    ...(service === 'e2b' ? { e2b: section('domain') } : {}),
    ...(service === 'daytona' ? { daytona: section('apiUrl', 'target') } : {}),
    agentAccess: access,
    setDefault: opts.default ? true : undefined,
    allowDuplicate: opts['allow-duplicate'] ? true : undefined
  }
}

const add: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman connections add <service> [options]')
  const [service] = ctx.args
  if (!service) throw usageError(`Say which service: foreman connections add ${SERVICES.join('|')}`)
  if (!SERVICES.includes(service)) throw usageError(`“${service}” isn’t a service Foreman connects to. Choose ${SERVICES.join(', ')}.`)
  const params = connectionParams(ctx, service)
  const viaGh = params.ghAccount !== undefined || params.ghActive !== undefined
  if (service === 'github' && params.ghAccount !== undefined && params.ghActive !== undefined) throw usageError('Choose one: --gh-account <login> or --gh-active.')
  if (viaGh && ctx.opts['token-stdin']) throw usageError('A GitHub connection signs in as a `gh` account or with a token, not both.')
  const needsToken = service !== 'docker' && !viaGh
  let token: string | undefined
  if (needsToken) {
    const label = SERVICE_NAMES[service] ?? CLOUD_PROVIDERS[service as keyof typeof CLOUD_PROVIDERS]?.label ?? service
    if (!ctx.opts['token-stdin'] && !io.stdinIsTTY()) throw usageError(`${label} needs a token and there is no terminal to ask on: pipe it in with --token-stdin. It is never an argument.`)
    token = await readSecret(`${label} token (not shown): `, { stdin: Boolean(ctx.opts['token-stdin']) })
  }
  printText(ctx, await ctx.send<{ text: string }>('connections-add', { ...params, ...(token !== undefined ? { token } : {}) }))
}

const check: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman connections check <id>')
  if (!ctx.args[0]) throw usageError('Name a connection. `foreman connections` lists them.')
  const result = await ctx.send<ConnectionsCheckResult>('connections-check', { id: ctx.args[0] })
  printText(ctx, result)
  if (!result.ok) process.exitCode = 1
}

const remove: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman connections remove <id>')
  const [id] = ctx.args
  if (!id) throw usageError('Name a connection. `foreman connections` lists them.')
  // What it affects first, from the app; nothing is removed until it has been shown and agreed to.
  const first = await ctx.send<ConnectionsRemoveResult>('connections-remove', { id })
  if (first.removed || !first.needsConfirmation) return printText(ctx, first)
  if (!(await previewAndAsk(ctx, first.text, `Remove the connection “${id}”?`, first))) return declinedNote(ctx, 'Nothing removed.')
  printText(ctx, await ctx.send<ConnectionsRemoveResult>('connections-remove', { id, confirmed: true }))
}

const setDefault: Run = async (ctx) => {
  const [service, id, ...extra] = ctx.args
  if (!service || !id || extra.length) throw usageError('Say the service and the connection: foreman connections default <service> <id|none>')
  if (!SERVICES.includes(service)) throw usageError(`“${service}” isn’t a service. Choose ${SERVICES.join(', ')}.`)
  printText(ctx, await ctx.send<{ text: string }>('connections-default', { service, id }))
}

const editConnection: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman connections edit <id> [--agent-access level] [--new-workspaces on|off]')
  const [id] = ctx.args
  if (!id) throw usageError('Name a connection. `foreman connections` lists them.')
  const agentAccess = choice(ctx.opts['agent-access'], 'agent-access', ['off', 'read', 'write'])
  const newWorkspaces = choice(ctx.opts['new-workspaces'], 'new-workspaces', ['on', 'off'])
  if (agentAccess === undefined && newWorkspaces === undefined) throw usageError('Say what to change: --agent-access off|read|write or --new-workspaces on|off.')
  printText(ctx, await ctx.send<{ text: string }>('connections-edit', { id, agentAccess, newWorkspaces }))
}

const apply: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman connections apply <id> --repos a,b')
  const [id] = ctx.args
  if (!id) throw usageError('Name a connection. `foreman connections` lists them.')
  const repos = commaList(ctx.opts.repos)
  if (!repos?.length) throw usageError('Name the repositories: --repos a,b (`foreman repos` lists them).')
  printText(ctx, await ctx.send<{ text: string }>('connections-apply', { id, repos, replace: ctx.opts.replace ? true : undefined, cwd: ctx.cwd }))
}

// ---- Slack and Linear ----

const RULE_ONLY = ['connection', 'event', 'recipient', 'channel', 'repos', 'template', 'mode', 'away-only', 'disabled']

function choice(value: unknown, flag: string, choices: readonly string[]): string | undefined {
  const text = str(value)
  if (text !== undefined && !choices.includes(text)) throw usageError(`--${flag} is one of ${choices.join(', ')}.`)
  return text
}

const slackRules: Run = async (ctx) => {
  const [verb = 'list', id, ...extra] = ctx.args
  if (!['list', 'add', 'remove', 'consent'].includes(verb)) throw unknownVerb('slack rules', verb, ['list', 'add', 'remove <id>', 'consent <id>'])
  if (extra.length || (id !== undefined && verb !== 'remove' && verb !== 'consent')) throw usageError(`foreman slack rules ${verb} takes ${verb === 'remove' || verb === 'consent' ? 'one rule id' : 'no words'}.`)
  if (verb !== 'add') {
    const stray = RULE_ONLY.find((o) => ctx.opts[o] !== undefined)
    if (stray) throw usageError(`--${stray} goes with \`slack rules add\`.`)
  }
  if (verb === 'list') return printText(ctx, await ctx.send<{ text: string }>('slack-rules', { verb }))
  if (verb === 'add') {
    const event = choice(ctx.opts.event, 'event', SLACK_EVENTS)
    if (!event) throw usageError(`Say which event: --event ${SLACK_EVENTS.join('|')}`)
    const params = {
      verb,
      connection: str(ctx.opts.connection),
      event,
      recipient: choice(ctx.opts.recipient, 'recipient', ['me', 'reviewer', 'channel']),
      channel: str(ctx.opts.channel),
      repos: commaList(ctx.opts.repos),
      template: str(ctx.opts.template),
      mode: choice(ctx.opts.mode, 'mode', ['ask', 'auto']),
      awayOnly: ctx.opts['away-only'] ? true : undefined,
      disabled: ctx.opts.disabled ? true : undefined,
      cwd: ctx.cwd
    }
    return printText(ctx, await ctx.send<SlackRulesResult>('slack-rules', params))
  }
  if (!id) throw usageError(`Name the rule: foreman slack rules ${verb} <id> (\`foreman slack rules\` lists them).`)
  if (verb === 'remove') return printText(ctx, await ctx.send<SlackRulesResult>('slack-rules', { verb, id }))
  // consent: what would go out, to whom, and then the answer.
  const first = await ctx.send<SlackRulesResult>('slack-rules', { verb, id })
  if (!first.needsConfirmation) return printText(ctx, first)
  if (!(await previewAndAsk(ctx, first.text, 'Let this rule send without asking?', first))) return declinedNote(ctx, 'Nothing changed.')
  printText(ctx, await ctx.send<SlackRulesResult>('slack-rules', { verb, id, confirmed: true }))
}

const slackPeople: Run = async (ctx) => {
  const [verb = 'list', github, slackId, ...extra] = ctx.args
  if (!['list', 'link', 'unlink'].includes(verb)) throw unknownVerb('slack people', verb, ['list', 'link <gh> <slack-id>', 'unlink <gh>'])
  if (extra.length) throw usageError(`Too many words for foreman slack people ${verb}.`)
  if (verb === 'list' && github !== undefined) throw usageError('foreman slack people list takes no words.')
  if (verb !== 'list' && !github) throw usageError(`Name the GitHub login: foreman slack people ${verb} <gh>${verb === 'link' ? ' <slack-id>' : ''}`)
  if (verb === 'link' && !slackId) throw usageError('Give the Slack user’s id too: foreman slack people link <gh> <slack-id> (it starts with U).')
  if (verb === 'unlink' && slackId !== undefined) throw usageError('foreman slack people unlink takes only the GitHub login.')
  printText(ctx, await ctx.send<{ text: string }>('slack-people', { verb, githubLogin: github, slackId, teamId: str(ctx.opts.team), name: str(ctx.opts.name) }))
}

const slackDeliveries: Run = async (ctx) => {
  noMoreWords(ctx, 0, 'foreman slack deliveries [--connection c]')
  printText(ctx, await ctx.send<{ text: string }>('slack-deliveries', { connection: str(ctx.opts.connection) }))
}

const slackAnswer: Run = async (ctx) => {
  const [id, action, ...extra] = ctx.args
  if (!id || !action || extra.length) throw usageError('Say which message and what to do: foreman slack answer <id> send|skip')
  if (action !== 'send' && action !== 'skip') throw usageError(`“${action}” isn’t an answer. Use send or skip.`)
  if (action === 'skip' && ctx.opts.text !== undefined) throw usageError('--text goes with send.')
  printText(ctx, await ctx.send<{ text: string }>('slack-answer', { id, action, text: str(ctx.opts.text) }))
}

const slackResend: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman slack resend <id>')
  if (!ctx.args[0]) throw usageError('Name a message. `foreman slack deliveries` lists their ids.')
  printText(ctx, await ctx.send<{ text: string }>('slack-resend', { id: ctx.args[0] }))
}

const linearIssues: Run = async (ctx) => {
  noMoreWords(ctx, 0, 'foreman linear issues [--repo r]')
  printText(ctx, await ctx.send<{ text: string }>('linear-issues', { repo: str(ctx.opts.repo), cwd: ctx.cwd }))
}

export const integrationRunners: Record<string, Run> = {
  connections: list,
  'connections add': add,
  'connections check': check,
  'connections remove': remove,
  'connections default': setDefault,
  'connections edit': editConnection,
  'connections apply': apply,
  'slack rules': slackRules,
  'slack people': slackPeople,
  'slack deliveries': slackDeliveries,
  'slack answer': slackAnswer,
  'slack resend': slackResend,
  'linear issues': linearIssues
}

/** Hands each command's function to the registry (`register('connections add', run)`). */
export function registerIntegrationCommands(register: (name: string, run: Run) => void): void {
  for (const [name, run] of Object.entries(integrationRunners)) register(name, run)
}
