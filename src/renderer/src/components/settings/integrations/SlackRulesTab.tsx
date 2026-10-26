// Slack rules: When <event> in <repositories> message <whom>, asking first or not. Messages to
// yourself just send. Messages to anyone else ask first until you consent, in a sheet that
// spells out exactly what will happen; changing the rule afterwards asks again.
import { Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  DEFAULT_TEMPLATES,
  recipientsFor,
  renderTemplate,
  ruleFingerprint,
  SLACK_EVENTS,
  TEMPLATE_FIELDS,
  type ConnectionView,
  type SlackDelivery,
  type SlackEvent,
  type SlackRecipient,
  type SlackRule
} from '../../../../../shared/integrations'
import { formatClock } from '../../../../../shared/i18n/time'
import { useT } from '../../../i18n'
import { api, attempt, showToast, useStore } from '../../../store'
import { Button, Callout, Checkbox, Dialog, Field, RadioList, Select, Spinner, Status, Switch, TextArea, type StatusTone } from '../../../ui'
import { flashSaved } from '../controls'

const SAMPLE = { reviewer: 'Priya', 'pr.title': 'Fix login redirect loop', 'pr.number': 482, 'pr.url': 'https://github.com/acme/web/pull/482', repo: 'web', author: 'you', workspace: 'fix-login', agent: 'Claude Code', reason: 'wants to run pnpm db:migrate' }

function newRule(connection: ConnectionView): SlackRule {
  return { id: '', connectionId: connection.id, event: 'review-requested', repos: 'all', recipient: 'reviewer', template: DEFAULT_TEMPLATES['review-requested'], mode: 'ask', enabled: true }
}

export function SlackRulesTab() {
  const t = useT()
  const all = useStore((s) => s.snapshot!.integrations.connections)
  const connections = all.filter((c) => c.service === 'slack')
  const rules = useStore((s) => s.snapshot!.integrations.rules)
  const [editing, setEditing] = useState<SlackRule | null>(null)
  const [consent, setConsent] = useState<SlackRule | null>(null)
  if (!connections.length) return <p className="int-empty">{t('integrations.rules.noSlack')}</p>
  const save = async (rule: SlackRule) => {
    const saved = await attempt(() => api.saveSlackRule(rule))
    if (saved) {
      flashSaved()
      setEditing(null)
      // Asked to send automatically: the consent sheet comes next.
      if (rule.mode === 'auto' && saved.mode !== 'auto') setConsent(saved)
    }
  }
  return (
    <div className="int-rules">
      <div className="int-row">
        <span className="set-help grow">{t('integrations.rules.help')}</span>
        <Button size="sm" icon={<Plus size={12} />} onClick={() => setEditing(newRule(connections[0]))}>
          {t('integrations.rules.new')}
        </Button>
      </div>
      {editing && !editing.id && <RuleEditor rule={editing} connections={connections} onSave={save} onCancel={() => setEditing(null)} />}
      {rules.map((rule) =>
        editing?.id === rule.id ? (
          <RuleEditor key={rule.id} rule={editing} connections={connections} onSave={save} onCancel={() => setEditing(null)} />
        ) : (
          <RuleRow key={rule.id} rule={rule} connections={connections} onEdit={() => setEditing(rule)} />
        )
      )}
      {!rules.length && !editing && <p className="int-empty">{t('integrations.rules.none')}</p>}
      {consent && <ConsentDialog rule={consent} onClose={() => setConsent(null)} />}
      <Deliveries />
    </div>
  )
}

function useRuleWords() {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const event = (e: SlackEvent) => t(`integrations.event.${e}`)
  const recipient = (r: SlackRule) => (r.recipient === 'me' ? t('integrations.recipient.me') : r.recipient === 'reviewer' ? t('integrations.recipient.reviewer') : `#${r.channel?.name ?? '?'}`)
  const where = (r: SlackRule, connection?: ConnectionView) =>
    r.repos === 'all' ? t('integrations.rules.allRepos', { name: connection?.name ?? 'Slack' }) : r.repos.map((id) => repos.find((x) => x.id === id)?.name ?? '?').join(', ')
  return { event, recipient, where }
}

function RuleRow({ rule, connections, onEdit }: { rule: SlackRule; connections: ConnectionView[]; onEdit: () => void }) {
  const t = useT()
  const words = useRuleWords()
  const connection = connections.find((c) => c.id === rule.connectionId)
  const auto = rule.recipient === 'me' || (rule.mode === 'auto' && rule.consent?.fingerprint === ruleFingerprint(rule))
  const toggle = async (enabled: boolean) => {
    if (await attempt(() => api.saveSlackRule({ ...rule, enabled }))) flashSaved()
  }
  return (
    <div className={`int-rule ${rule.enabled ? '' : 'off'}`}>
      <Switch checked={rule.enabled} onChange={(v) => void toggle(v)} label={t('integrations.rules.enabled')} />
      <div className="int-rule-text">
        <div>
          {t.rich('integrations.rules.sentence', {
            event: <b key="e">{words.event(rule.event)}</b>,
            where: <b key="w">{words.where(rule, connection)}</b>,
            whom: <b key="r">{words.recipient(rule)}</b>
          })}
          {rule.awayOnly && <span className="muted"> {t('integrations.rules.awayOnly')}</span>}
        </div>
        <div className="int-rule-sub">
          {auto ? (rule.recipient === 'me' ? t('integrations.rules.sendsToMe') : t('integrations.rules.consented', { date: rule.consent?.at.slice(0, 10) ?? '' })) : t('integrations.rules.asksFirst')}
          {connections.length > 1 && connection ? ` · ${connection.name}` : ''}
        </div>
      </div>
      <Button size="sm" variant="ghost" onClick={onEdit}>
        {t('integrations.rules.edit')}
      </Button>
    </div>
  )
}

function RuleEditor({ rule: initial, connections, onSave, onCancel }: { rule: SlackRule; connections: ConnectionView[]; onSave: (r: SlackRule) => void; onCancel: () => void }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const words = useRuleWords()
  const [rule, setRule] = useState<SlackRule>(initial)
  const connection = connections.find((c) => c.id === rule.connectionId) ?? connections[0]
  const recipients = recipientsFor(rule.event)
  const set = (patch: Partial<SlackRule>) => setRule((r) => ({ ...r, ...patch }))
  const setEvent = (event: SlackEvent) => {
    const allowed = recipientsFor(event)
    // A template the user didn't touch follows the event.
    const template = rule.template === DEFAULT_TEMPLATES[rule.event] ? DEFAULT_TEMPLATES[event] : rule.template
    set({ event, template, recipient: allowed.includes(rule.recipient) ? rule.recipient : allowed[0], ...(event.startsWith('agent-') ? {} : { awayOnly: undefined }) })
  }
  const toMe = rule.recipient === 'me'
  const remove = async () => {
    if (!rule.id || !window.confirm(t('integrations.rules.deleteConfirm'))) return
    if ((await attempt(async () => (await api.deleteSlackRule(rule.id), true))) !== undefined) {
      flashSaved()
      onCancel()
    }
  }
  return (
    <div className="int-rule open">
      <div className="int-sentence">
        <span className="muted">{t('integrations.rules.when')}</span>
        <Select<SlackEvent> label={t('integrations.rules.when')} value={rule.event} options={SLACK_EVENTS.map((e) => ({ value: e, label: words.event(e) }))} onChange={setEvent} />
        <span className="muted">{t('integrations.rules.in')}</span>
        <Select
          label={t('integrations.rules.in')}
          value={rule.repos === 'all' ? 'all' : (rule.repos[0] ?? 'all')}
          options={[{ value: 'all', label: t('integrations.rules.allRepos', { name: connection.name }) }, ...repos.map((r) => ({ value: r.id, label: r.name }))]}
          onChange={(v) => set({ repos: v === 'all' ? 'all' : [v] })}
        />
        <span className="muted">{t('integrations.rules.message')}</span>
        <Select
          label={t('integrations.rules.message')}
          value={rule.recipient === 'channel' ? `channel:${rule.channel?.id ?? ''}` : rule.recipient}
          options={[
            ...(recipients.includes('reviewer') ? [{ value: 'reviewer', label: t('integrations.recipient.reviewer') }] : []),
            ...(recipients.includes('me') ? [{ value: 'me', label: t('integrations.recipient.me') }] : []),
            ...(recipients.includes('channel') ? (connection.slack?.destinations ?? []).map((d) => ({ value: `channel:${d.id}`, label: `#${d.name}` })) : [])
          ]}
          onChange={(v) => {
            if (v.startsWith('channel:')) {
              const d = connection.slack?.destinations.find((x) => x.id === v.slice(8))
              set({ recipient: 'channel', channel: d })
            } else set({ recipient: v as SlackRecipient, channel: undefined })
          }}
        />
        {connections.length > 1 && (
          <Select
            label={t('integrations.rules.via')}
            value={rule.connectionId}
            options={connections.map((c) => ({ value: c.id, label: c.name }))}
            onChange={(v) => set({ connectionId: v, channel: undefined })}
          />
        )}
      </div>
      {rule.recipient === 'channel' && !connection.slack?.destinations.length && <Callout tone="warn">{t('integrations.rules.noChannels')}</Callout>}
      {toMe && !connection.slack?.me && <Callout tone="warn">{t('integrations.card.slackNoMe')}</Callout>}
      {rule.event.startsWith('agent-') && (
        <Checkbox checked={Boolean(rule.awayOnly)} onChange={(e) => set({ awayOnly: e.target.checked || undefined })}>
          {t('integrations.rules.awayOnlyLabel')}
        </Checkbox>
      )}
      <Field label={t('integrations.rules.template')} description={t('integrations.rules.templateHelp', { fields: TEMPLATE_FIELDS.map((f) => `{${f}}`).join(', ') })}>
        {(c) => <TextArea {...c} mono rows={2} value={rule.template} onChange={(e) => set({ template: e.target.value })} />}
      </Field>
      <div className="int-preview">
        <div className="int-preview-who">{t('integrations.rules.previewFrom')}</div>
        <div>{renderTemplate(rule.template, SAMPLE).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')}</div>
      </div>
      {!toMe && (
        <div className="int-modes">
          <RadioList<'ask' | 'auto'>
            inline
            legend={t('integrations.rules.sending')}
            hideLegend
            value={rule.mode}
            onChange={(mode) => set({ mode })}
            options={[
              { value: 'ask', label: t('integrations.rules.askFirst') },
              { value: 'auto', label: t('integrations.rules.sendAuto') }
            ]}
          />
          {rule.mode === 'auto' && rule.consent?.fingerprint !== ruleFingerprint(rule) && <span className="set-help">{t('integrations.rules.needsConsent')}</span>}
        </div>
      )}
      {rule.recipient === 'reviewer' && <p className="set-help">{t('integrations.rules.reviewerHelp')}</p>}
      <div className="int-row">
        {rule.id && (
          <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={() => void remove()}>
            {t('integrations.rules.delete')}
          </Button>
        )}
        <span className="grow" />
        <Button size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="primary" disabled={!rule.template.trim() || (rule.recipient === 'channel' && !rule.channel)} onClick={() => onSave({ ...rule, connectionId: connection.id })}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  )
}

/** Consent for sending to other people without asking: exactly what, to whom, from where, and how often. */
function ConsentDialog({ rule, onClose }: { rule: SlackRule; onClose: () => void }) {
  const t = useT()
  const words = useRuleWords()
  const connection = useStore((s) => s.snapshot!.integrations.connections.find((c) => c.id === rule.connectionId))
  const people = useStore((s) => s.snapshot!.integrations.people.filter((p) => p.slackTeamId === connection?.identity?.orgId).length)
  const agree = async () => {
    if (await attempt(() => api.consentSlackRule(rule.id))) {
      flashSaved()
      onClose()
    }
  }
  return (
    <Dialog
      title={t('integrations.consent.title')}
      size="lg"
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('integrations.consent.keepAsking')}</Button>
          <Button variant="primary" onClick={() => void agree()}>
            {t('integrations.consent.agree')}
          </Button>
        </>
      }
    >
      <table className="int-consent">
        <tbody>
          <tr>
            <th>{t('integrations.consent.when')}</th>
            <td>{words.event(rule.event)}</td>
          </tr>
          <tr>
            <th>{t('integrations.consent.where')}</th>
            <td>{words.where(rule, connection)}</td>
          </tr>
          <tr>
            <th>{t('integrations.consent.who')}</th>
            <td>{rule.recipient === 'reviewer' ? t('integrations.consent.reviewers', { count: people }) : words.recipient(rule)}</td>
          </tr>
          <tr>
            <th>{t('integrations.consent.from')}</th>
            <td>{t('integrations.consent.bot', { workspace: connection?.identity?.org ?? 'Slack' })}</td>
          </tr>
          <tr>
            <th>{t('integrations.consent.often')}</th>
            <td>{t(`integrations.often.${rule.event}`)}</td>
          </tr>
        </tbody>
      </table>
      <div className="int-preview">
        <div className="int-preview-who">{t('integrations.rules.previewFrom')}</div>
        <div>{renderTemplate(rule.template, SAMPLE).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')}</div>
      </div>
      <p className="set-help">{t('integrations.consent.reset')}</p>
    </Dialog>
  )
}

const DELIVERY_TONE: Record<SlackDelivery['status'], StatusTone> = { sent: 'ok', failed: 'error', uncertain: 'warn', asking: 'warn', queued: 'warn', skipped: 'off' }

function Deliveries() {
  const t = useT()
  const asks = useStore((s) => s.snapshot!.slackAsks.length)
  const [list, setList] = useState<SlackDelivery[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = () => void api.slackDeliveries().then(setList, () => setList([]))
  useEffect(load, [asks])
  const resend = async (id: string) => {
    setBusy(id)
    const ok = await attempt(async () => (await api.resendSlackDelivery(id), true))
    setBusy(null)
    if (ok) showToast(t('integrations.deliveries.resent'))
    load()
  }
  if (!list?.length) return null
  return (
    <section className="int-deliveries">
      <h3>{t('integrations.deliveries.title')}</h3>
      <div className="int-log">
        {list.slice(0, 30).map((d) => (
          <div key={d.id} className="int-log-row">
            <span className="int-log-time">{formatClock(d.sentAt ?? d.at, t.locale)}</span>
            <Status className="int-status" tone={DELIVERY_TONE[d.status]} label={t(`integrations.status.${d.status}`)} />
            <span className="grow" title={d.text}>
              {t('integrations.deliveries.line', { to: d.recipientName, what: d.title })}
              {d.error && <span className="muted"> · {d.error}</span>}
            </span>
            {(d.status === 'failed' || d.status === 'uncertain') && (
              <Button size="sm" variant="ghost" disabled={busy === d.id} icon={busy === d.id ? <Spinner size={12} /> : <RotateCcw size={12} />} onClick={() => void resend(d.id)}>
                {t('integrations.deliveries.sendAgain')}
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
