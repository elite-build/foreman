// An AI employee's outward actions in the window (docs/ai-employees.md §6.6, §9): the ones waiting for you in Needs you,
// each with its exact preview (Slack: the channel and the text; Linear: the issue and the change; a push: the branch and
// the commits ahead; a pull request: its title, description, base ← branch and diff stat) and Send, Edit then send (the
// words only, never where it goes) or Skip; one Foreman isn't sure was sent asks you to check first. A task's log of its
// actions, the Team page's "Decided for you" (what went without asking in the last day, and which can't be undone), and
// each class's rule in words for the approval plan and the employee's page. Every action is read from the snapshot.
import { useState } from 'react'
import { actionPolicy, CANT_UNDO, editableFields, isActionKind, type EmployeeAction, type EmployeeActionPayload, type EmployeeActionState } from '../../../../shared/employeeActions'
import { EMPLOYEE_ACTIONS, type EmployeeActionPolicy, type EmployeeDefinition } from '../../../../shared/employees'
import type { PlainKey } from '../../../../shared/i18n'
import { formatDateTime } from '../../../../shared/i18n/time'
import { useT, type RendererT } from '../../i18n'
import { api, openEmployees, showToast, useStore } from '../../store'
import { Button, Callout, Card, Field, LinkButton, Status, Tag, TextArea, TextInput, type StatusTone } from '../../ui'
import { actionName, POLICY_LABEL } from './words'
import './employees.css'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const ACTION_STATE_LABEL: Record<EmployeeActionState, PlainKey> = {
  held: 'employees.heldAction.state.held',
  approved: 'employees.heldAction.state.approved',
  sent: 'employees.heldAction.state.sent',
  skipped: 'employees.heldAction.state.skipped',
  failed: 'employees.heldAction.state.failed',
  refused: 'employees.heldAction.state.refused',
  uncertain: 'employees.heldAction.state.uncertain'
}

export const ACTION_STATE_TONE: Record<EmployeeActionState, StatusTone> = { held: 'warn', approved: 'info', sent: 'ok', skipped: 'off', failed: 'error', refused: 'off', uncertain: 'warn' }

const HEADLINE = {
  'slack-post': 'employees.heldAction.slack',
  linear: 'employees.heldAction.linear',
  push: 'employees.heldAction.push',
  'pull-request': 'employees.heldAction.pullRequest'
} as const satisfies Record<EmployeeActionPayload['kind'], string>

const FIELD_LABEL: Record<string, PlainKey> = {
  text: 'employees.heldAction.message',
  title: 'employees.heldAction.title',
  body: 'employees.heldAction.body',
  description: 'employees.heldAction.body'
}

/** "Slack post to #launches", "Push of feature/x": what an action is, in a few words. */
export function actionNoun(p: EmployeeActionPayload, t: RendererT): string {
  switch (p.kind) {
    case 'slack-post':
      return t('employees.actionNoun.slack', { channel: p.channelName ? `#${p.channelName}` : p.channel })
    case 'linear':
      return p.issue ? t('employees.actionNoun.linearIssue', { tool: p.tool, issue: p.issue }) : t('employees.actionNoun.linear', { tool: p.tool })
    case 'push':
      return t('employees.actionNoun.push', { branch: p.branch })
    case 'pull-request':
      return t('employees.actionNoun.pullRequest', { title: p.title })
  }
}

const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))

/** The exact thing that would be sent: where it goes, as whom, and its words. */
export function ActionPreview({ payload: p }: { payload: EmployeeActionPayload }) {
  const t = useT()
  const as = p.connection ? (
    <>
      <dt>{t('employees.heldAction.as')}</dt>
      <dd>{p.connection}</dd>
    </>
  ) : null
  if (p.kind === 'slack-post')
    return (
      <dl className="employee-plan-list">
        <dt>{t('employees.heldAction.channel')}</dt>
        <dd>
          <span>{p.channelName ? `#${p.channelName}` : p.channel}</span>
          {p.channelName && <span className="employee-faint mono">{p.channel}</span>}
        </dd>
        {as}
        <dt>{t('employees.heldAction.message')}</dt>
        <dd>
          <pre className="employee-proposal-text">{p.text}</pre>
        </dd>
      </dl>
    )
  if (p.kind === 'linear') {
    const args = Object.entries(p.args)
    return (
      <dl className="employee-plan-list">
        <dt>{t('employees.heldAction.issue')}</dt>
        <dd>{p.issue ? <span className="mono">{p.issue}</span> : t('employees.heldAction.noIssue')}</dd>
        <dt>{t('employees.heldAction.change')}</dt>
        <dd>
          <span className="mono">{p.tool}</span>
          {args.length > 0 && (
            <ul className="employee-plan-items">
              {args.map(([k, v]) => (
                <li key={k}>
                  <span className="mono">{k}</span>: <span className="employee-proposal-text">{show(v)}</span>
                </li>
              ))}
            </ul>
          )}
        </dd>
        {as}
      </dl>
    )
  }
  const commits = (
    <>
      <dt>{t('employees.heldAction.commits')}</dt>
      <dd>
        <span>{t('employees.heldAction.ahead', { count: p.ahead, base: p.base })}</span>
        {p.commits.length > 0 && (
          <ul className="employee-plan-items">
            {p.commits.map((c) => (
              <li key={c.sha}>
                <span className="mono">{c.sha}</span> {c.subject}
              </li>
            ))}
          </ul>
        )}
      </dd>
    </>
  )
  if (p.kind === 'push')
    return (
      <dl className="employee-plan-list">
        <dt>{t('employees.heldAction.branch')}</dt>
        <dd className="mono">{p.branch}</dd>
        {commits}
        {as}
      </dl>
    )
  return (
    <dl className="employee-plan-list">
      <dt>{t('employees.heldAction.title')}</dt>
      <dd>{p.title}</dd>
      <dt>{t('employees.heldAction.body')}</dt>
      <dd>{p.body.trim() ? <pre className="employee-proposal-text">{p.body}</pre> : <span className="employee-faint">{t('employees.heldAction.noBody')}</span>}</dd>
      <dt>{t('employees.heldAction.into')}</dt>
      <dd className="mono">{t('employees.heldAction.intoValue', { base: p.base, branch: p.branch })}</dd>
      {p.diffStat && (
        <>
          <dt>{t('employees.heldAction.diff')}</dt>
          <dd>{t('employees.heldAction.diffValue', { count: p.diffStat.files, insertions: p.diffStat.insertions, deletions: p.diffStat.deletions })}</dd>
        </>
      )}
      {commits}
      {as}
    </dl>
  )
}

/** The words a person may change before sending, as they are now. */
function editsOf(p: EmployeeActionPayload): Record<string, string> {
  const fields = editableFields(p)
  const source: Record<string, unknown> = p.kind === 'linear' ? p.args : (p as unknown as Record<string, unknown>)
  return Object.fromEntries(fields.map((f) => [f, typeof source[f] === 'string' ? (source[f] as string) : '']))
}

/** One action waiting for you: its preview, and Send, Edit then send or Skip (or, uncertain, check first). */
function HeldActionRow({ action, who, task }: { action: EmployeeAction; who: string; task?: string }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [edits, setEdits] = useState<Record<string, string> | null>(null)
  const fields = editableFields(action.payload)
  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true)
    setError('')
    try {
      await what()
      setEdits(null)
      showToast(done)
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }
  const send = (options: { edits?: Record<string, string>; checked?: boolean } = {}) => run(() => api.sendEmployeeAction(action.id, options), t('employees.heldAction.sentToast', { name: who }))
  const changed = edits ? Object.fromEntries(Object.entries(edits).filter(([k, v]) => v !== editsOf(action.payload)[k])) : {}
  return (
    <Card as="li" className="employee-task">
      <div className="employee-task-head">
        <Status tone={ACTION_STATE_TONE[action.state]} label={t(ACTION_STATE_LABEL[action.state])} />
        <span className="employee-task-title">{t(HEADLINE[action.kind], { name: who })}</span>
      </div>
      {task && <span className="employee-faint">{t('employees.heldAction.task', { title: task })}</span>}
      {action.state === 'uncertain' && (
        <Callout tone="warn" role="status" title={t('employees.heldAction.uncertainTitle')}>
          {t('employees.heldAction.uncertainBody', { reason: action.reason ?? action.result?.error ?? '' })}
        </Callout>
      )}
      {action.state === 'failed' && (
        <Callout tone="error" role="status" title={t('employees.heldAction.failedTitle')}>
          {action.result?.error ?? ''}
        </Callout>
      )}
      {edits ? (
        <div className="employee-question">
          <p className="employee-faint">{t('employees.heldAction.editHint')}</p>
          {fields.map((f) => (
            <Field key={f} label={t(FIELD_LABEL[f] ?? 'employees.heldAction.message')}>
              {(c) =>
                f === 'title' ? (
                  <TextInput {...c} value={edits[f] ?? ''} onChange={(e) => setEdits({ ...edits, [f]: e.target.value })} />
                ) : (
                  <TextArea {...c} rows={f === 'text' ? 4 : 6} value={edits[f] ?? ''} onChange={(e) => setEdits({ ...edits, [f]: e.target.value })} />
                )
              }
            </Field>
          ))}
          <ActionPreview payload={{ ...action.payload, ...(action.payload.kind === 'linear' ? { args: { ...action.payload.args, ...edits } } : edits) } as EmployeeActionPayload} />
        </div>
      ) : (
        <ActionPreview payload={action.payload} />
      )}
      {action.kind === 'pull-request' && <p className="employee-faint">{t('employees.heldAction.draft')}</p>}
      {error && (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      )}
      <div className="employee-card-actions">
        {action.state === 'uncertain' ? (
          <>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(() => api.confirmEmployeeAction(action.id), t('employees.heldAction.arrivedToast'))}>
              {t('employees.heldAction.arrived')}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void send({ checked: true })}>
              {t('employees.heldAction.didntArrive')}
            </Button>
          </>
        ) : edits ? (
          <>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void send({ edits: changed })}>
              {busy ? t('employees.heldAction.sending') : t('employees.heldAction.sendEdited')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEdits(null)}>
              {t('employees.heldAction.cancelEdit')}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void send()}>
              {busy ? t('employees.heldAction.sending') : action.state === 'failed' ? t('employees.heldAction.sendAgain') : t('employees.heldAction.send')}
            </Button>
            {fields.length > 0 && (
              <Button size="sm" disabled={busy} onClick={() => setEdits(editsOf(action.payload))}>
                {t('employees.heldAction.edit')}
              </Button>
            )}
          </>
        )}
        {!edits && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.skipEmployeeAction(action.id), t('employees.heldAction.skippedToast', { name: who }))}>
            {t('employees.heldAction.skip')}
          </Button>
        )}
        <span className="employee-faint">{CANT_UNDO[action.kind] ? t('employees.heldAction.cantUndo') : t('employees.heldAction.canUndo')}</span>
      </div>
    </Card>
  )
}

/** The organization's outward actions waiting for you (Needs you), oldest first; nothing when there are none. */
export function HeldActions({ orgId }: { orgId: string }) {
  const t = useT()
  const view = useStore((s) => s.snapshot!.employeeWork?.[orgId])
  const roster = useStore((s) => s.snapshot!.employees?.[orgId]?.employees ?? [])
  const actions = view?.actions ?? []
  if (!actions.length) return null
  const title = (taskId: string) => view?.tasks.find((x) => x.id === taskId)?.title ?? Object.values(view?.last ?? {}).find((x) => x.id === taskId)?.title
  return (
    <section className="team-needs-you" aria-labelledby={`held-actions-${orgId}`}>
      <h3 id={`held-actions-${orgId}`} className="employee-subheading">
        {t('employees.heldAction.heading', { count: actions.length })}
      </h3>
      <ul className="employee-work-list" aria-labelledby={`held-actions-${orgId}`}>
        {actions.map((a) => (
          <HeldActionRow key={a.id} action={a} who={roster.find((e) => e.id === a.employeeId)?.name || a.employeeId} task={title(a.taskId)} />
        ))}
      </ul>
    </section>
  )
}

/** A task's outward actions, for its chain and receipts: each with its state (held → sent or skipped) and where it went. */
export function ActionLog({ actions }: { actions: readonly EmployeeAction[] }) {
  const t = useT()
  if (!actions.length) return null
  return (
    <ul className="employee-chain-list" aria-label={t('employees.chain.actions')}>
      {actions.map((a) => (
        <li key={a.id} className="employee-chain-line">
          <Status tone={ACTION_STATE_TONE[a.state]} label={t(ACTION_STATE_LABEL[a.state])} />
          <span>{actionNoun(a.payload, t)}</span>
          {a.decidedBy === 'definition' && <span className="employee-faint">{t('employees.heldAction.byDefinition')}</span>}
          {a.edited && <span className="employee-faint">{t('employees.heldAction.edited')}</span>}
          {a.result?.link && (
            <LinkButton size="sm" underline onClick={() => void api.openExternal(a.result!.link!)}>
              {t('employees.heldAction.open')}
            </LinkButton>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * "Decided for you" (§6.6, the OpenRig lesson): each outward action that went without asking you in the last day, as
 * its employee's definition allows, with how to revisit it (open what it made, change the rule) and plainly whether it
 * can be undone; or that nothing was decided for you.
 */
export function DecidedForYou({ orgId }: { orgId: string }) {
  const t = useT()
  const decided = useStore((s) => s.snapshot!.employeeWork?.[orgId]?.decided)
  const roster = useStore((s) => s.snapshot!.employees?.[orgId]?.employees ?? [])
  if (!decided) return null
  const name = (id: string) => roster.find((e) => e.id === id)?.name || id
  return (
    <section className="team-needs-you" aria-labelledby={`decided-${orgId}`}>
      <h2 id={`decided-${orgId}`} className="employee-subheading">
        {t('employees.decided.heading')}
      </h2>
      {!decided.length ? (
        <p className="employee-faint">{t('employees.decided.none')}</p>
      ) : (
        <>
          <p className="employee-faint">{t('employees.decided.intro', { count: decided.length })}</p>
          <ul className="employee-chain-list" aria-labelledby={`decided-${orgId}`}>
            {[...decided].reverse().map((a) => (
              <li key={a.id} className="employee-chain-line">
                <span>{t('employees.decided.item', { name: name(a.employeeId), what: actionNoun(a.payload, t) })}</span>
                <span className="employee-faint">{formatDateTime(a.sentAt ?? a.createdAt, t.locale, { hour: '2-digit', minute: '2-digit' })}</span>
                {a.state === 'uncertain' ? (
                  <Tag tone="warn">{t('employees.decided.uncertain')}</Tag>
                ) : CANT_UNDO[a.kind] ? (
                  <Tag tone="warn">{t('employees.decided.cantUndo')}</Tag>
                ) : (
                  <Tag tone="outline">{t('employees.decided.canUndo')}</Tag>
                )}
                {a.result?.link && (
                  <LinkButton size="sm" underline onClick={() => void api.openExternal(a.result!.link!)}>
                    {t('employees.heldAction.open')}
                  </LinkButton>
                )}
                <LinkButton size="sm" underline onClick={() => openEmployees({ orgId, page: 'employee', id: a.employeeId, edit: true })}>
                  {t('employees.decided.rule', { name: name(a.employeeId) })}
                </LinkButton>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

const RULE: Record<EmployeeActionPolicy, PlainKey> = { held: 'employees.rules.held', allowed: 'employees.rules.allowed', never: 'employees.rules.never' }

/**
 * Each outward action class with its rule in words (§9), for the approval plan and the employee's page: Foreman's four
 * brokered routes always (one the definition doesn't list is held), then any other class it lists, which Foreman can't
 * hold; and plainly that a shell, and MCP servers it keeps, act with no hold.
 */
export function ActionRules({ definition: d }: { definition: Pick<EmployeeDefinition, 'access'> }) {
  const t = useT()
  const others = Object.keys(d.access.actions).filter((a) => !isActionKind(a))
  const ownServers = d.access.mcp.filter((s) => !s.startsWith('foreman-'))
  return (
    <div className="employee-plan-section">
      <ul className="employee-plan-items">
        {EMPLOYEE_ACTIONS.map((kind) => {
          const listed = d.access.actions[kind]
          const policy = actionPolicy(d, kind)
          return (
            <li key={kind}>
              {actionName(kind, t)} <Tag tone={policy === 'allowed' ? 'warn' : 'outline'}>{t(POLICY_LABEL[policy])}</Tag>{' '}
              <span className="employee-faint">{listed || policy !== 'held' ? t(RULE[policy]) : t('employees.rules.heldUnlisted')}</span>
              {kind === 'pull-request' && policy !== (listed ?? 'held') && <span className="employee-faint"> {t('employees.rules.prPush')}</span>}
            </li>
          )
        })}
        {others.map((action) => (
          <li key={action}>
            {actionName(action, t)} <Tag tone="outline">{t(POLICY_LABEL[d.access.actions[action]])}</Tag> <span className="employee-faint">{t('employees.rules.notBrokered')}</span>
          </li>
        ))}
      </ul>
      <p className="employee-faint">{d.access.profile === 'shell' ? t('employees.rules.shell') : t('employees.rules.noShell')}</p>
      {ownServers.length > 0 && <p className="employee-faint">{t('employees.rules.mcp', { servers: ownServers.join(t('employees.list.separator')) })}</p>}
    </div>
  )
}
