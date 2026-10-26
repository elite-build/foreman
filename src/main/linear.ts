// Linear's GraphQL API with a personal API key: who a key is, one issue, and the issues
// assigned to the key's user. Keys are sent only to api.linear.app, never redirected.
import type { ConnectionIdentity } from '../shared/integrations'
import type { LinearIssue, LinearIssueSummary } from '../shared/linearLink'

export type Fetch = typeof fetch

const API = 'https://api.linear.app/graphql'

export class LinearError extends Error {
  constructor(
    message: string,
    readonly auth = false
  ) {
    super(message)
  }
}

async function query<T>(key: string, text: string, variables: Record<string, unknown> = {}, doFetch: Fetch = fetch): Promise<T> {
  let res: Response
  try {
    // A personal API key goes as is; an OAuth token would need "Bearer ".
    res = await doFetch(API, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: key },
      body: JSON.stringify({ query: text, variables }),
      signal: AbortSignal.timeout(15_000)
    })
  } catch (err) {
    throw new LinearError(`Couldn’t reach Linear: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (res.status === 401 || res.status === 403) throw new LinearError('Linear refused this key. It may have been revoked or mistyped.', true)
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message?: string; extensions?: { type?: string; code?: string } }[] } | null
  const error = body?.errors?.[0]
  if (error) {
    const auth = /auth/i.test(`${error.extensions?.type ?? ''} ${error.extensions?.code ?? ''}`)
    throw new LinearError(auth ? 'Linear refused this key. It may have been revoked or mistyped.' : `Linear: ${error.message ?? 'request failed'}`, auth)
  }
  if (!res.ok || !body?.data) throw new LinearError(`Linear answered ${res.status}`)
  return body.data
}

/** Who a key belongs to, and its organization. */
export async function linearViewer(key: string, doFetch?: Fetch): Promise<ConnectionIdentity> {
  const data = await query<{ viewer: { id: string; name: string; email?: string; organization: { id: string; name: string; urlKey: string } } }>(
    key,
    'query { viewer { id name email organization { id name urlKey } } }',
    {},
    doFetch
  )
  const v = data.viewer
  return { user: v.name, userId: v.id, email: v.email, org: v.organization.name, orgId: v.organization.id, orgKey: v.organization.urlKey, url: `https://linear.app/${v.organization.urlKey}`, checkedAt: new Date().toISOString() }
}

/** Whether the organization has Linear's own GitHub integration; null when the API won't say. */
export async function linearHasGithub(key: string, doFetch?: Fetch): Promise<boolean | null> {
  try {
    const data = await query<{ integrations: { nodes: { service: string }[] } }>(key, 'query { integrations(first: 50) { nodes { service } } }', {}, doFetch)
    return data.integrations.nodes.some((n) => /^github/i.test(n.service))
  } catch {
    return null
  }
}

const ISSUE_FIELDS = 'id identifier title url branchName priorityLabel state { name type } team { key name } assignee { name }'

/** One issue by id or identifier (ENG-123), with its description and recent comments. */
export async function linearIssue(key: string, id: string, doFetch?: Fetch): Promise<LinearIssue | null> {
  try {
    const data = await query<{
      issue: (LinearIssueSummary & { description?: string; branchName: string; team: { key: string; name: string }; organization?: never; comments: { nodes: { body: string; createdAt: string; user?: { name: string } | null }[] } }) | null
    }>(key, `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} description comments(first: 20) { nodes { body createdAt user { name } } } } }`, { id }, doFetch)
    const i = data.issue
    if (!i) return null
    return {
      identifier: i.identifier,
      title: i.title,
      url: i.url,
      branchName: i.branchName,
      state: i.state,
      priorityLabel: i.priorityLabel,
      team: i.team,
      assignee: i.assignee,
      description: i.description ?? '',
      comments: i.comments.nodes.map((c) => ({ author: c.user?.name ?? 'Linear', body: c.body, at: c.createdAt }))
    }
  } catch (err) {
    if (err instanceof LinearError && /not found|entity/i.test(err.message)) return null
    throw err
  }
}

/** Issues assigned to the key's user that aren't done or cancelled, most recently updated first. */
export async function linearMyIssues(key: string, doFetch?: Fetch): Promise<LinearIssueSummary[]> {
  const data = await query<{ viewer: { assignedIssues: { nodes: LinearIssueSummary[] } } }>(
    key,
    `query { viewer { assignedIssues(first: 40, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${ISSUE_FIELDS} } } } }`,
    {},
    doFetch
  )
  return data.viewer.assignedIssues.nodes.map((i) => ({ identifier: i.identifier, title: i.title, url: i.url, branchName: i.branchName, state: i.state, priorityLabel: i.priorityLabel, team: i.team, assignee: i.assignee }))
}
