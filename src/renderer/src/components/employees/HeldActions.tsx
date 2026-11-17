// An AI employee's outward actions in the window (docs/ai-employees.md §6.6, §9): one waiting for you is a decision card
// (components/DecisionCard.tsx) with its exact preview, where it goes and as whom (a push: the repository, the remote and
// its URL, the login, the commits and the files it changes, with a way to its workspace), the line saying what pressing
// the main button sends, and buttons named for the act: "Push branch" / "Don't push", "Post to #launches" / "Don't post",
// with Edit, then … for the words only. None of them has a key: each leaves this computer. One Foreman isn't sure was sent
// asks you to check first. A task's log of its actions, the Team page's "Decided for you" (what went without asking in
// the last day, and which can't be undone), and each class's rule in words for the employee's page. Every action is read
// from the snapshot.
import { useState, type ReactNode } from 'react'
import { actionPolicy, canPublish, CANT_UNDO, editableFields, isActionKind, PUBLISH_ACTIONS, type EmployeeAction, type EmployeeActionPayload, type EmployeeActionState } from '../../../../shared/employeeActions'
import { EMPLOYEE_ACTIONS, type EmployeeActionPolicy, type EmployeeDefinition } from '../../../../shared/employees'
import type { PlainKey } from '../../../../shared/i18n'
import { formatDateTime, timeAgo } from '../../../../shared/i18n/time'
import { useT, type RendererT } from '../../i18n'
import { api, openEmployees, requestOpenFile, selectWorkspace, showToast, useStore } from '../../store'
import { Callout, ChipButton, Field, LinkButton, Status, Tag, TextArea, TextInput, type StatusTone } from '../../ui'
import { PlacedDecision, type DecisionAct, type DecisionPlace } from '../DecisionCard'
import { ACTION_STATE_LABEL, actionName, actionNoun, POLICY_LABEL } from './words'
import './employees.css'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const ACTION_STATE_TONE: Record<EmployeeActionState, StatusTone> = { held: 'warn', approved: 'info', sent: 'ok', skipped: 'off', failed: 'error', refused: 'off', uncertain: 'warn' }

const FIELD_LABEL: Record<string, PlainKey> = {
  text: 'employees.heldAction.message',
  title: 'employees.heldAction.title',
  body: 'employees.heldAction.body',
  description: 'employees.heldAction.body'
}

const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))

/** The files a branch changes, each opening in its workspace, with its counts. */
function BranchFiles({ payload: p }: { payload: Extract<EmployeeActionPayload, { kind: 'push' | 'pull-request' }> }) {
  const t = useT()
  const exists = useStore((s) => s.snapshot!.workspaces.some((w) => w.id === p.workspaceId))
  if (!p.files?.length && !exists) return null
  return (
    <div className="decision-facts">
      {(p.files ?? []).map((f) => (
        <span key={f.path} className="decision-file">
          {exists ? (
            <ChipButton path onClick={() => requestOpenFile(p.workspaceId, f.path)}>
              {f.path}
            </ChipButton>
          ) : (
            <code>{f.path}</code>
          )}
          <span className="employee-faint">{t('employees.decision.fileCounts', { insertions: f.insertions, deletions: f.deletions })}</span>
        </span>
      ))}
      {exists && (
        <LinkButton size="sm" underline onClick={() => selectWorkspace(p.workspaceId)}>
          {t('employees.decision.viewChanges')}
        </LinkButton>
      )}
    </div>
  )
}

/** The exact thing that would be sent: where it goes and its words (as whom is said on the line above the buttons). */
export function ActionPreview({ payload: p }: { payload: EmployeeActionPayload }) {
  const t = useT()
  if (p.kind === 'slack-post')
    return (
      <dl className="employee-plan-list">
        <dt>{t('employees.heldAction.channel')}</dt>
        <dd>
          <span>{p.channelName ? `#${p.channelName}` : p.channel}</span>
          {p.channelName && <span className="employee-faint mono">{p.channel}</span>}
        </dd>
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
      <>
        <dl className="employee-plan-list">
          {commits}
          </dl>
        <BranchFiles payload={p} />
      </>
    )
  return (
    <>
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
      </dl>
      <BranchFiles payload={p} />
    </>
  )
}

/** The words a person may change before sending, as they are now. */
function editsOf(p: EmployeeActionPayload): Record<string, string> {
  const fields = editableFields(p)
  const source: Record<string, unknown> = p.kind === 'linear' ? p.args : (p as unknown as Record<string, unknown>)
  return Object.fromEntries(fields.map((f) => [f, typeof source[f] === 'string' ? (source[f] as string) : '']))
}

/** The account it goes out as: the login when Foreman knows it, else the connection's name. */
const asWhom = (p: EmployeeActionPayload) => ('login' in p && p.login ? `@${p.login}` : p.connection)

/** What the act will do, in a sentence, said just above its button: where it goes, as whom, and whether it can be undone. */
export function actionConsequence(p: EmployeeActionPayload, repoName: string, t: RendererT): string {
  switch (p.kind) {
    case 'push':
      return t('employees.decision.push.consequence', { count: p.ahead, branch: p.branch, remote: p.remote ?? 'origin', where: p.remoteUrl ?? p.repo ?? repoName, who: asWhom(p) })
    case 'pull-request':
      return t('employees.decision.pr.consequence', { branch: p.branch, remote: p.remote ?? 'origin', where: p.remoteUrl ?? p.repo ?? repoName, base: p.base, who: asWhom(p) })
    case 'slack-post':
      return t('employees.decision.slack.consequence', { channel: p.channelName ? `#${p.channelName}` : p.channel, who: asWhom(p) })
    case 'linear':
      return t('employees.decision.linear.consequence', { who: asWhom(p) })
  }
}

/** The kind word a decision's header and row carry. */
export function actionKindWord(p: EmployeeActionPayload, t: RendererT): string {
  return p.kind === 'push' ? t('decision.kind.push') : p.kind === 'pull-request' ? t('decision.kind.pullRequest') : p.kind === 'slack-post' ? t('decision.kind.slack') : t('decision.kind.linear')
}

/** The thing decided, in one line: "Push max/launch-2.4 to site". */
export function actionSubject(p: EmployeeActionPayload, repoName: string, t: RendererT): ReactNode {
  switch (p.kind) {
    case 'push':
      return t.rich('employees.decision.push.subject', { branch: <code key="b">{p.branch}</code>, repo: p.repo ?? repoName })
    case 'pull-request':
      return t('employees.decision.pr.subject', { title: p.title || p.branch, repo: p.repo ?? repoName })
    case 'slack-post':
      return t('employees.decision.slack.subject', { channel: p.channelName ? `#${p.channelName}` : p.channel })
    case 'linear':
      return p.issue ? t('employees.decision.linear.subjectIssue', { issue: p.issue }) : t('employees.decision.linear.subject')
  }
}

// Each class's act (Slack's names its channel), its refusal and its Edit, then … button.
const ACT: Record<EmployeeActionPayload['kind'], { act?: PlainKey; decline: PlainKey; edit: PlainKey }> = {
  push: { act: 'employees.decision.push.act', decline: 'employees.decision.push.decline', edit: 'employees.decision.push.edit' },
  'pull-request': { act: 'employees.decision.pr.act', decline: 'employees.decision.pr.decline', edit: 'employees.decision.pr.edit' },
  'slack-post': { decline: 'employees.decision.slack.decline', edit: 'employees.decision.slack.edit' },
  linear: { act: 'employees.decision.linear.act', decline: 'employees.decision.linear.decline', edit: 'employees.decision.linear.edit' }
}

/**
 * One action waiting for you, as a decision: its preview and the line saying where it goes, then Don't … · Edit, then … ·
 * the act (none with a key: it leaves this computer); while editing, the words as fields and Send edited; one Foreman
 * isn't sure was sent, It arrived · It didn't arrive: send again.
 */
export function ActionDecision({ action, place, who, task }: { action: EmployeeAction; place: DecisionPlace; who: ReactNode; task?: string }) {
  const t = useT()
  const name = useStore((s) => s.snapshot!.employees?.[action.orgId]?.employees.find((e) => e.id === action.employeeId)?.name) || action.employeeId
  const repoName = useStore((s) => s.snapshot!.repos.find((r) => r.id === action.repoId)?.name) ?? ''
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [edits, setEdits] = useState<Record<string, string> | null>(null)
  const p = action.payload
  const fields = editableFields(p)
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
  const send = (options: { edits?: Record<string, string>; checked?: boolean } = {}) => run(() => api.sendEmployeeAction(action.id, options), t('employees.heldAction.sentToast', { name }))
  const skip = () => run(() => api.skipEmployeeAction(action.id), t('employees.heldAction.skippedToast', { name }))
  const changed = edits ? Object.fromEntries(Object.entries(edits).filter(([k, v]) => v !== editsOf(p)[k])) : {}
  const { act: actKey, decline: declineKey, edit: editKey } = ACT[p.kind]
  const actLabel = p.kind === 'slack-post' ? t('employees.decision.slack.act', { channel: p.channelName ? `#${p.channelName}` : p.channel }) : actKey ? t(actKey) : t('employees.heldAction.send')

  let decline: DecisionAct | undefined
  let alternate: DecisionAct | undefined
  let main: DecisionAct | undefined
  if (action.state === 'uncertain') {
    main = { label: t('employees.heldAction.arrived'), disabled: busy, onAct: () => void run(() => api.confirmEmployeeAction(action.id), t('employees.heldAction.arrivedToast')) }
    alternate = { label: t('employees.heldAction.didntArrive'), disabled: busy, outward: true, onAct: () => void send({ checked: true }) }
  } else if (edits) {
    decline = { label: t('employees.heldAction.cancelEdit'), disabled: busy, onAct: () => setEdits(null) }
    main = { label: busy ? t('employees.heldAction.sending') : t('employees.heldAction.sendEdited'), disabled: busy, outward: true, onAct: () => void send({ edits: changed }) }
  } else {
    decline = { label: t(declineKey), disabled: busy, onAct: () => void skip() }
    if (fields.length) alternate = { label: t(editKey), disabled: busy, onAct: () => setEdits(editsOf(p)) }
    main = { label: busy ? t('employees.heldAction.sending') : action.state === 'failed' ? t('employees.heldAction.sendAgain') : actLabel, disabled: busy, outward: true, onAct: () => void send() }
  }

  const body = (
    <>
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
        </div>
      ) : (
        <ActionPreview payload={p} />
      )}
      {error && (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      )}
    </>
  )
  return (
    <PlacedDecision
      place={place}
      parts={{
        who,
        kind: actionKindWord(p, t),
        age: timeAgo(action.createdAt, t.locale),
        subject: actionSubject(p, repoName, t),
        children: body,
        leaves: action.state !== 'uncertain',
        consequence: action.state === 'uncertain' ? t('employees.decision.uncertain.consequence') : actionConsequence(p, repoName, t),
        decline,
        alternate,
        main,
        // Anything that leaves this computer is read before it can go: the row only opens the card.
        rowAct: { label: t('decision.review'), onAct: place.onToggle ?? (() => undefined) }
      }}
    />
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
 * Each outward action class with its rule in words (§9), for the approval plan and the employee's page: Foreman's
 * brokered routes the definition can take (one it doesn't list is held), then any other class it lists, which Foreman
 * can't hold; plainly that one with no Write access can't push or open pull requests at all; and that a shell, and the
 * MCP servers every run has, act with no hold.
 */
export function ActionRules({ definition: d }: { definition: Pick<EmployeeDefinition, 'access'> }) {
  const t = useT()
  const publishes = canPublish(d)
  const kinds = EMPLOYEE_ACTIONS.filter((kind) => publishes || !PUBLISH_ACTIONS.includes(kind))
  const others = Object.keys(d.access.actions).filter((a) => !isActionKind(a))
  return (
    <div className="employee-plan-section">
      <ul className="employee-plan-items">
        {kinds.map((kind) => {
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
      {!publishes && <p className="employee-faint">{t('employees.rules.noWrite')}</p>}
      <p className="employee-faint">{d.access.profile === 'shell' ? t('employees.rules.shell') : t('employees.rules.noShell')}</p>
      <p className="employee-faint">{t('employees.rules.mcpAll')}</p>
    </div>
  )
}
