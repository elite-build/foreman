// `foreman connections | slack | linear`: Settings → Integrations from the command line. Every handler calls the service
// method the window calls, so a token is checked against its service before anything is saved, a removal says what it
// affects first, and a Slack rule only sends to other people without asking after the user's consent. A token arrives in the
// request's parameters (the command reads it from stdin) and is never written to a result, a message or a log: at most its last
// four characters, which the window shows too.
import { CLOUD_PROVIDERS } from '../../shared/cloud'
import { DEFAULT_TEMPLATES, INTEGRATION_SERVICES, recipientsFor, SANDBOX_SERVICES, SLACK_EVENTS, sendsWithoutAsking, type AgentAccess, type ConnectionView, type IntegrationService, type NewConnection, type PersonLink, type SlackDelivery, type SlackRule } from '../../shared/integrations'
import type { ConnectionRow, ConnectionsAddResult, ConnectionsApplyResult, ConnectionsCheckResult, ConnectionsDefaultResult, ConnectionsListResult, ConnectionsRemoveResult, DeliveryRow, LinearIssueRow, LinearIssuesResult, PersonRow, SlackActionResult, SlackDeliveriesResult, SlackPeopleResult, SlackRuleRow, SlackRulesResult } from '../../shared/cli/integrations'
import type { AppSnapshot, Repo } from '../../shared/types'
import type { CliHost } from './host'
import { columns, flagParam, invalid, paramsObject, textList, textParam, type MethodDef } from './kit'
import { findByRef, firstLine, plural, scrubSecret, type RefSpec } from './refs'
import { resolveRepo } from './resolve'

const ALL_SERVICES: IntegrationService[] = [...INTEGRATION_SERVICES, ...SANDBOX_SERVICES]
const AGENT_ACCESS: AgentAccess[] = ['off', 'read', 'write']

const connectionSpec: RefSpec<ConnectionView> = {
  id: (c) => c.id,
  names: (c) => [c.name],
  describe: (c) => `${c.name} (${c.service}, id ${c.id})`
}

function serviceOf(value: string): IntegrationService {
  if (!(ALL_SERVICES as string[]).includes(value)) throw invalid(`Unknown service “${value}”. Services: ${ALL_SERVICES.join(', ')}.`)
  return value as IntegrationService
}

const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

// ---- connections ----

function identityText(c: ConnectionView): string {
  if (c.identity) return `${c.identity.user}${c.identity.org ? ` @ ${c.identity.org}` : ''}`
  if (c.service === 'docker') return c.docker?.host ?? c.docker?.context ?? 'the current context'
  if (c.auth.kind === 'gh-account') return c.auth.login
  return ''
}

function detailsOf(c: ConnectionView): Record<string, string> | undefined {
  const entries: [string, string | undefined][] = [
    ['teamId', c.vercel?.teamId],
    ['projectId', c.vercel?.projectId],
    ['plan', c.vercel?.plan],
    ['context', c.docker?.context],
    ['host', c.docker?.host],
    ['domain', c.e2b?.domain],
    ['apiUrl', c.daytona?.apiUrl],
    ['target', c.daytona?.target]
  ]
  const present = entries.filter((e): e is [string, string] => Boolean(e[1]))
  return present.length ? Object.fromEntries(present) : undefined
}

function connectionRow(c: ConnectionView): ConnectionRow {
  const details = detailsOf(c)
  return {
    id: c.id,
    service: c.service,
    name: c.name,
    identity: identityText(c),
    default: c.isDefault,
    ...(c.problem ? { problem: c.problem } : {}),
    usedBy: c.usedBy,
    agentAccess: c.agentAccess,
    ...(c.hint ? { hint: c.hint } : {}),
    ...(details ? { details } : {})
  }
}

const connectionsOf = (snapshot: AppSnapshot): ConnectionView[] => snapshot.integrations.connections

function pickConnection(snapshot: AppSnapshot, query: string, service?: IntegrationService): ConnectionView {
  return findByRef(connectionsOf(snapshot).filter((c) => !service || c.service === service), query, 'connection', connectionSpec)
}

const connectionsList: MethodDef = {
  tier: 'read',
  async handle(host): Promise<ConnectionsListResult> {
    const rows = connectionsOf(host.snapshot()).map(connectionRow)
    if (!rows.length) return { connections: rows, text: 'No connections. `foreman connections add <service> …` adds one.' }
    const lines = columns([['ID', 'SERVICE', 'NAME', 'SIGNED IN AS', 'DEFAULT', 'PROBLEM'], ...rows.map((r) => [r.id.slice(0, 8), r.service, r.name, r.identity, r.default ? 'default' : '', r.problem ? firstLine(r.problem, 80) : ''])])
    return { connections: rows, text: lines.join('\n') }
  }
}

/** What adding a connection takes, from what the command line gave; the missing field is named the way its flag is. */
function newConnection(p: Record<string, unknown>): { input: NewConnection; token?: string } {
  const service = serviceOf(textParam(p, 'service'))
  const name = textParam(p, 'name', { optional: true })?.trim() || undefined
  const token = textParam(p, 'token', { optional: true })?.trim() || undefined
  const allowDuplicate = flagParam(p, 'allowDuplicate') || undefined
  const section = (key: string): Record<string, unknown> => {
    const v = p[key]
    if (v === undefined || v === null) return {}
    if (typeof v !== 'object' || Array.isArray(v)) throw invalid(`${key} must be an object.`)
    return v as Record<string, unknown>
  }
  const text = (o: Record<string, unknown>, key: string): string | undefined => {
    const v = o[key]
    if (v === undefined || v === null || v === '') return undefined
    if (typeof v !== 'string') throw invalid(`${key} must be text.`)
    return v.trim() || undefined
  }
  const base = { ...(name ? { name } : {}), ...(allowDuplicate ? { allowDuplicate } : {}) }

  if (service === 'github') {
    const account = textParam(p, 'ghAccount', { optional: true })?.trim()
    const active = flagParam(p, 'ghActive')
    if ([Boolean(account), active, Boolean(token)].filter(Boolean).length !== 1) throw invalid('Choose how GitHub signs in, one way: a `gh` account (--gh-account <login>), whichever is active (--gh-active), or a token on stdin.')
    if (account) return { input: { service, ...(name ? { name } : {}), auth: { kind: 'gh-account', login: account } } }
    if (active) return { input: { service, ...(name ? { name } : {}), auth: { kind: 'gh-active' } } }
    return { input: { service, auth: { kind: 'token' }, token: token!, ...base }, token }
  }
  if (service === 'docker') {
    if (token) throw invalid('Docker has no token: it uses a context or a host (--context, --host), or the current context.')
    const d = section('docker')
    const context = text(d, 'context')
    const host = text(d, 'host')
    return { input: { service, auth: { kind: 'docker-context' }, docker: { ...(context ? { context } : {}), ...(host ? { host } : {}) }, ...(allowDuplicate ? { allowDuplicate } : {}), ...(name ? { name } : {}) } }
  }
  if (!token) throw invalid(`${service === 'slack' ? 'A Slack bot token' : service === 'linear' ? 'A Linear API key' : `${CLOUD_PROVIDERS[service as keyof typeof CLOUD_PROVIDERS]?.label ?? service} needs an API key`} is needed: pass it on stdin (--token-stdin), never as an argument.`)
  const extra: Record<string, unknown> = {}
  const provider = (CLOUD_PROVIDERS as Record<string, (typeof CLOUD_PROVIDERS)[keyof typeof CLOUD_PROVIDERS] | undefined>)[service]
  if (provider) {
    const given = section(service)
    const missing = provider.connection.fields.filter((f) => !f.secret && !f.optional && f.default === undefined && !text(given, f.key)).map((f) => `--${kebab(f.key)}`)
    if (missing.length) throw invalid(`${provider.label} also needs ${missing.join(' and ')}.`, `Find ${missing.length > 1 ? 'them' : 'it'} in ${provider.label}'s dashboard (${provider.docsUrl}).`)
    const picked = Object.fromEntries(provider.connection.fields.filter((f) => !f.secret).flatMap((f) => (text(given, f.key) ? [[f.key, text(given, f.key)]] : [])))
    extra[service] = picked
  }
  const access = textParam(p, 'agentAccess', { optional: true })
  if (access !== undefined && !(AGENT_ACCESS as string[]).includes(access)) throw invalid(`Agent access is ${AGENT_ACCESS.join(', ')}.`)
  if (access !== undefined && service !== 'linear') throw invalid('Only Linear connections have an agent-access setting (GitHub reaches agents as GH_TOKEN; Slack and the sandbox services not at all).')
  return { input: { service, auth: { kind: 'token' }, token, ...base, ...(access ? { agentAccess: access as AgentAccess } : {}), ...extra } as NewConnection, token }
}

const connectionsAdd: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<ConnectionsAddResult> {
    const p = paramsObject(params)
    const { input, token } = newConnection(p)
    const result = await host.api.addConnection(input)
    if (!result.ok) {
      if (result.error === 'duplicate') throw invalid(`You already have a ${input.service} connection to this account: “${result.duplicateOf ?? 'another'}”${result.identity ? ` (${result.identity.user}${result.identity.org ? ` @ ${result.identity.org}` : ''})` : ''}.`, 'Pass --allow-duplicate to add it anyway.')
      throw new Error(scrubSecret(result.error, token))
    }
    let connection = result.connection
    if (flagParam(p, 'setDefault') && !connection.isDefault) {
      await host.api.setIntegrationDefault(input.service, connection.id)
      connection = { ...connection, isDefault: true }
    }
    const row = connectionRow(connection)
    return { connection: row, text: `Added the ${row.service} connection “${row.name}”${row.identity ? `, signed in as ${row.identity}` : ''}${row.default ? '; it is the default' : ''}.` }
  }
}

const connectionsCheck: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<ConnectionsCheckResult> {
    const p = paramsObject(params)
    const c = pickConnection(host.snapshot(), textParam(p, 'id'))
    const checked = await host.api.checkConnection(c.id)
    const row = connectionRow(checked)
    return { connection: row, ok: !checked.problem, text: checked.problem ? `“${row.name}” has a problem: ${checked.problem}` : `“${row.name}” works${row.identity ? `: signed in as ${row.identity}` : ''}.` }
  }
}

const connectionsRemove: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<ConnectionsRemoveResult> {
    const p = paramsObject(params)
    const c = pickConnection(host.snapshot(), textParam(p, 'id'))
    const impact = await host.api.connectionRemovalImpact(c.id)
    const effects = [
      impact.repos.length ? `${plural(impact.repos.length, 'repository', 'repositories')} use it now (${impact.repos.join(', ')}) and will show it as removed until you pick another` : '',
      impact.isDefault ? `it is the default ${c.service} connection, so there will be none` : '',
      impact.rules ? `${plural(impact.rules, 'Slack rule')} that send through it will be deleted` : ''
    ].filter(Boolean)
    const consequence = effects.length ? `Removing “${c.name}” (${c.service}): ${effects.join('; ')}.` : `Removing “${c.name}” (${c.service}) affects nothing else.`
    if (!flagParam(p, 'confirmed')) return { removed: false, needsConfirmation: true, impact, text: `${consequence}\nIts saved token is deleted from this computer.` }
    await host.api.removeConnection(c.id)
    return { removed: true, impact, text: `Removed the ${c.service} connection “${c.name}” and deleted its saved token from this computer.${effects.length ? ` Effects: ${effects.join('; ')}.` : ''}` }
  }
}

const connectionsDefault: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<ConnectionsDefaultResult> {
    const p = paramsObject(params)
    const service = serviceOf(textParam(p, 'service'))
    const id = textParam(p, 'id')
    if (id.trim().toLowerCase() === 'none') {
      await host.api.setIntegrationDefault(service, null)
      return { service, text: `There is no default ${service} connection now.` }
    }
    const c = pickConnection(host.snapshot(), id, service)
    await host.api.setIntegrationDefault(service, c.id)
    return { service, connection: connectionRow({ ...c, isDefault: true }), text: `“${c.name}” is the default ${service} connection.` }
  }
}

const connectionsApply: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<ConnectionsApplyResult> {
    const p = paramsObject(params)
    const snapshot = host.snapshot()
    const c = pickConnection(snapshot, textParam(p, 'id'))
    if (!(INTEGRATION_SERVICES as string[]).includes(c.service)) throw invalid(`${c.service} isn’t chosen per repository here: a repository picks its sandbox service on its Remote tab (\`foreman repo settings set cloud.…\`).`)
    const names = textList(p, 'repos')
    if (!names.length) throw invalid('Name at least one repository.')
    const cwd = textParam(p, 'cwd', { optional: true }) ?? process.cwd()
    const chosen: Repo[] = []
    for (const name of names) {
      const repo = await resolveRepo(snapshot, cwd, name)
      if (!chosen.some((r) => r.id === repo.id)) chosen.push(repo)
    }
    // The service replaces the whole set; by default the repositories that already chose it stay.
    const already = flagParam(p, 'replace') ? [] : host.state().repos.filter((r) => r.integrations?.services?.[c.service as 'github'] === c.id)
    const repos = [...new Map([...already, ...chosen].map((r) => [r.id, r])).values()]
    await host.api.applyConnectionToRepos(c.id, repos.map((r) => r.id))
    return { repos: repos.map((r) => r.name), text: `${plural(repos.length, 'repository', 'repositories')} now use${repos.length === 1 ? 's' : ''} “${c.name}” for ${c.service}: ${repos.map((r) => r.name).join(', ')}.` }
  }
}

// ---- Slack ----

function slackConnection(snapshot: AppSnapshot, query: string | undefined): ConnectionView {
  const slack = connectionsOf(snapshot).filter((c) => c.service === 'slack')
  if (query?.trim()) return pickConnection(snapshot, query, 'slack')
  if (slack.length === 1) return slack[0]
  const preferred = slack.find((c) => c.isDefault)
  if (preferred) return preferred
  throw invalid(slack.length ? `Several Slack connections: ${slack.map((c) => c.name).join(', ')}. Pick one with --connection.` : 'No Slack connection. Add one with `foreman connections add slack`.')
}

function ruleRow(snapshot: AppSnapshot, r: SlackRule): SlackRuleRow {
  const connection = connectionsOf(snapshot).find((c) => c.id === r.connectionId)
  return {
    id: r.id,
    connection: connection?.name ?? r.connectionId,
    event: r.event,
    recipient: r.recipient,
    ...(r.channel ? { channel: r.channel.name } : {}),
    repos: r.repos === 'all' ? 'all' : r.repos.map((id) => snapshot.repos.find((x) => x.id === id)?.name ?? id),
    template: r.template,
    sendsWithoutAsking: sendsWithoutAsking(r),
    awayOnly: Boolean(r.awayOnly),
    enabled: r.enabled
  }
}

const recipientText = (r: SlackRuleRow): string => (r.recipient === 'me' ? 'you' : r.recipient === 'reviewer' ? 'the requested reviewer' : `channel ${r.channel ?? '?'}`)

function rulesText(rows: SlackRuleRow[]): string {
  if (!rows.length) return 'No Slack rules. `foreman slack rules add --event … --recipient …` adds one.'
  return columns([['ID', 'EVENT', 'TO', 'REPOS', 'SENDS', 'ON'], ...rows.map((r) => [r.id.slice(0, 8), r.event, recipientText(r), r.repos === 'all' ? 'all' : r.repos.join(', '), r.sendsWithoutAsking ? 'without asking' : 'asks first', r.enabled ? 'yes' : 'no'])]).join('\n')
}

function pickRule(snapshot: AppSnapshot, query: string): SlackRule {
  return findByRef(snapshot.integrations.rules, query, 'Slack rule', { id: (r) => r.id, names: (r) => [r.id], describe: (r) => `${r.event} to ${r.recipient}, id ${r.id}` })
}

const slackRules: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<SlackRulesResult> {
    const p = paramsObject(params)
    const verb = textParam(p, 'verb')
    const snapshot = host.snapshot()
    const rows = snapshot.integrations.rules.map((r) => ruleRow(snapshot, r))
    if (verb === 'list') return { rules: rows, text: rulesText(rows) }

    if (verb === 'add') {
      const c = slackConnection(snapshot, textParam(p, 'connection', { optional: true }))
      const eventText = textParam(p, 'event')
      if (!(SLACK_EVENTS as string[]).includes(eventText)) throw invalid(`Unknown event “${eventText}”. Events: ${SLACK_EVENTS.join(', ')}.`)
      const event = eventText as SlackRule['event']
      const allowed = recipientsFor(event)
      const recipientWanted = textParam(p, 'recipient', { optional: true }) ?? allowed[0]
      if (!(allowed as string[]).includes(recipientWanted)) throw invalid(`${event} can go to: ${allowed.join(', ')}.`)
      const recipient = recipientWanted as SlackRule['recipient']
      let channel: SlackRule['channel']
      if (recipient === 'channel') {
        const wanted = textParam(p, 'channel', { optional: true })?.replace(/^#/, '').trim()
        const options = c.slack?.destinations ?? []
        channel = options.find((d) => d.id === wanted || d.name.toLowerCase() === wanted?.toLowerCase())
        if (!channel) throw invalid(wanted ? `“${wanted}” isn’t a channel this connection may post to.` : 'Name the channel to post to (--channel).', options.length ? `Allowed: ${options.map((d) => d.name).join(', ')}.` : 'Choose its channels in Settings → Integrations first.')
      } else if (textParam(p, 'channel', { optional: true })) throw invalid('A channel is only for a rule that posts to a channel.')
      const awayOnly = flagParam(p, 'awayOnly')
      if (awayOnly && !event.startsWith('agent-')) throw invalid('Only agent events (agent-needs-me, agent-finished) can wait until you are away.')
      const names = textList(p, 'repos', { optional: true }) ?? []
      let repos: SlackRule['repos'] = 'all'
      if (names.length && !names.some((n) => n.toLowerCase() === 'all')) {
        const cwd = textParam(p, 'cwd', { optional: true }) ?? process.cwd()
        const picked: string[] = []
        for (const name of names) {
          const repo = await resolveRepo(snapshot, cwd, name)
          if (!picked.includes(repo.id)) picked.push(repo.id)
        }
        repos = picked
      }
      const mode = textParam(p, 'mode', { optional: true }) ?? 'ask'
      if (mode !== 'ask' && mode !== 'auto') throw invalid('Mode is `ask` or `auto`.')
      const rule: SlackRule = {
        id: '',
        connectionId: c.id,
        event,
        repos,
        recipient,
        ...(channel ? { channel } : {}),
        template: textParam(p, 'template', { optional: true })?.trim() || DEFAULT_TEMPLATES[event],
        mode,
        ...(awayOnly ? { awayOnly } : {}),
        enabled: !flagParam(p, 'disabled')
      }
      const saved = await host.api.saveSlackRule(rule)
      const row = ruleRow(host.snapshot(), saved)
      const asks = recipient !== 'me' && !row.sendsWithoutAsking
      return { rules: [row], rule: row, text: `Added a rule: ${event} → ${recipientText(row)} (${row.repos === 'all' ? 'all repositories' : row.repos.join(', ')}), id ${saved.id.slice(0, 8)}.${asks ? ` Messages to others ask first; \`foreman slack rules consent ${saved.id.slice(0, 8)}\` lets this rule send without asking.` : ''}` }
    }

    if (verb === 'remove') {
      const rule = pickRule(snapshot, textParam(p, 'id'))
      await host.api.deleteSlackRule(rule.id)
      return { rules: rows.filter((r) => r.id !== rule.id), text: `Removed the ${rule.event} rule.` }
    }

    if (verb === 'consent') {
      const rule = pickRule(snapshot, textParam(p, 'id'))
      const row = ruleRow(snapshot, rule)
      if (rule.recipient === 'me') return { rules: rows, rule: row, changed: false, text: 'Messages to you never ask, so there is nothing to consent to.' }
      if (!flagParam(p, 'confirmed')) {
        return {
          rules: rows,
          rule: row,
          needsConfirmation: true,
          text: `Consenting lets Foreman send this to ${recipientText(row)} without asking, whenever ${rule.event} happens in ${row.repos === 'all' ? 'any repository using this connection' : row.repos.join(', ')}:\n\n  ${rule.template}\n\nThe consent covers the rule exactly as it is; changing any part of it asks again.`
        }
      }
      const saved = await host.api.consentSlackRule(rule.id)
      return { rules: rows, rule: ruleRow(host.snapshot(), saved), changed: true, text: `The ${rule.event} rule now sends without asking.` }
    }
    throw invalid(`Unknown verb “${verb}”. Use list, add, remove or consent.`)
  }
}

function personRow(p: PersonLink): PersonRow {
  return { githubLogin: p.githubLogin, slackUserId: p.slackUserId, slackName: p.slackName, slackTeamId: p.slackTeamId }
}

const slackPeople: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<SlackPeopleResult> {
    const p = paramsObject(params)
    const verb = textParam(p, 'verb')
    const snapshot = host.snapshot()
    const people = snapshot.integrations.people
    const text = (rows: PersonRow[]) => (rows.length ? columns([['GITHUB', 'SLACK', 'SLACK USER', 'TEAM'], ...rows.map((r) => [r.githubLogin, r.slackName, r.slackUserId, r.slackTeamId])]).join('\n') : 'No linked people. `foreman slack people link <github> <slack-id> --team <id>` links one.')
    if (verb === 'list') return { people: people.map(personRow), text: text(people.map(personRow)) }
    if (verb !== 'link' && verb !== 'unlink') throw invalid(`Unknown verb “${verb}”. Use list, link or unlink.`)
    const githubLogin = textParam(p, 'githubLogin').trim().replace(/^@/, '')
    if (!githubLogin) throw invalid('Name the GitHub login.')
    const teams = [...new Set(connectionsOf(snapshot).flatMap((c) => (c.service === 'slack' && c.identity?.orgId ? [c.identity.orgId] : [])))]
    let team = textParam(p, 'teamId', { optional: true })?.trim()
    if (!team) {
      if (teams.length !== 1) throw invalid(teams.length ? `Several Slack workspaces are connected (${teams.join(', ')}). Pass --team.` : 'No Slack workspace is connected.', 'Add one with `foreman connections add slack`.')
      team = teams[0]
    } else if (teams.length && !teams.includes(team)) throw invalid(`“${team}” isn’t a connected Slack workspace. Connected: ${teams.join(', ')}.`)
    if (verb === 'unlink') {
      if (!people.some((x) => x.githubLogin.toLowerCase() === githubLogin.toLowerCase() && x.slackTeamId === team)) throw invalid(`${githubLogin} isn’t linked in that workspace.`)
      await host.api.unlinkPerson(githubLogin, team)
      return { people: people.filter((x) => !(x.githubLogin.toLowerCase() === githubLogin.toLowerCase() && x.slackTeamId === team)).map(personRow), text: `Unlinked ${githubLogin}.` }
    }
    const slackId = textParam(p, 'slackId').trim()
    if (!slackId || /\s/.test(slackId)) throw invalid('Give the Slack user’s id (it starts with U or W).')
    const link: PersonLink = { githubLogin, slackTeamId: team, slackUserId: slackId, slackName: textParam(p, 'name', { optional: true })?.trim() || slackId }
    await host.api.linkPerson(link)
    return { people: [...people.filter((x) => !(x.githubLogin.toLowerCase() === githubLogin.toLowerCase() && x.slackTeamId === team)), link].map(personRow), text: `Linked ${githubLogin} to ${link.slackName} (${slackId}).` }
  }
}

function deliveryRow(d: SlackDelivery): DeliveryRow {
  return { id: d.id, event: d.event, status: d.status, recipient: d.recipientName || d.recipientId || d.unmatched || '', title: d.title, at: d.at, ...(d.error ? { error: d.error } : {}) }
}

const slackDeliveries: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<SlackDeliveriesResult> {
    const p = paramsObject(params)
    const query = textParam(p, 'connection', { optional: true })
    const connection = query?.trim() ? pickConnection(host.snapshot(), query, 'slack') : undefined
    const rows = (await host.api.slackDeliveries(connection?.id)).map(deliveryRow)
    if (!rows.length) return { deliveries: rows, text: 'No Slack messages yet.' }
    const lines = columns([['ID', 'WHEN', 'EVENT', 'TO', 'STATUS', 'ABOUT'], ...rows.slice(0, 50).map((r) => [r.id.slice(0, 8), r.at.slice(0, 16).replace('T', ' '), r.event, r.recipient, r.error ? `${r.status}: ${firstLine(r.error, 40)}` : r.status, firstLine(r.title, 50)])])
    return { deliveries: rows, text: `${lines.join('\n')}${rows.length > 50 ? `\n… ${rows.length - 50} older` : ''}` }
  }
}

/** A delivery's full id from the start of it among `ids`; an id nothing starts with is passed on as it is (the service says if it is wrong). */
function fullId(ids: string[], query: string): string {
  const q = query.trim()
  if (ids.includes(q)) return q
  const found = q.length >= 4 ? ids.filter((id) => id.startsWith(q)) : []
  if (found.length > 1) throw invalid(`“${q}” starts several messages; give more of the id.`)
  return found[0] ?? q
}

const slackAnswer: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<SlackActionResult> {
    const p = paramsObject(params)
    const action = textParam(p, 'action')
    if (action !== 'send' && action !== 'skip') throw invalid('Answer with `send` or `skip`.')
    const text = textParam(p, 'text', { optional: true })
    if (text !== undefined && action === 'skip') throw invalid('A skipped message has no text to change.')
    const id = fullId(host.snapshot().slackAsks.map((d) => d.id), textParam(p, 'id'))
    await host.api.answerSlackAsk(id, action, text)
    return { id, text: action === 'send' ? 'Sent.' : 'Skipped; nothing was sent.' }
  }
}

const slackResend: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<SlackActionResult> {
    const p = paramsObject(params)
    const id = fullId((await host.api.slackDeliveries()).map((d) => d.id), textParam(p, 'id'))
    await host.api.resendSlackDelivery(id)
    return { id, text: 'Sent again.' }
  }
}

// ---- Linear ----

const linearIssues: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<LinearIssuesResult> {
    const p = paramsObject(params)
    const snapshot = host.snapshot()
    const repo = await resolveRepo(snapshot, textParam(p, 'cwd', { optional: true }) ?? process.cwd(), textParam(p, 'repo', { optional: true }))
    const result = await host.api.linearMyIssues(repo.id)
    if ('error' in result) throw new Error(result.error)
    const issues = result.issues.map((i): LinearIssueRow => ({ identifier: i.identifier, title: i.title, state: i.state.name, team: i.team.key, ...(i.priorityLabel ? { priority: i.priorityLabel } : {}), ...(i.assignee?.name ? { assignee: i.assignee.name } : {}), branch: i.branchName, url: i.url }))
    if (!issues.length) return { connection: result.connection, issues, text: `No open issues assigned to you in ${result.connection}.` }
    const lines = columns([['ISSUE', 'STATE', 'PRIORITY', 'TITLE'], ...issues.map((i) => [i.identifier, i.state, i.priority ?? '', firstLine(i.title, 80)])])
    return { connection: result.connection, issues, text: `${result.connection}\n${lines.join('\n')}` }
  }
}

export const INTEGRATIONS_METHODS: Record<string, MethodDef> = {
  'connections-list': connectionsList,
  'connections-add': connectionsAdd,
  'connections-check': connectionsCheck,
  'connections-remove': connectionsRemove,
  'connections-default': connectionsDefault,
  'connections-apply': connectionsApply,
  'slack-rules': slackRules,
  'slack-people': slackPeople,
  'slack-deliveries': slackDeliveries,
  'slack-answer': slackAnswer,
  'slack-resend': slackResend,
  'linear-issues': linearIssues
}
