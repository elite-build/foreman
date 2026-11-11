// Settings → Data & devices → Agents on this computer (docs/agent-access.md §9): the switch and the port, the address and
// how to add it to Claude Code or Codex, each sign-in waiting for the code its browser page shows, and the signed-in agents.
import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AGENT_ACCESS_LEVELS, agentAccessSetup, DEFAULT_AGENT_ACCESS_LEVEL, type AgentAccessInfo, type AgentAccessLevel, type AgentAccessPending, type AgentGrant } from '../../../../shared/agentAccess'
import type { PlainKey } from '../../../../shared/i18n'
import { formatClock, formatDate, timeAgo } from '../../../../shared/i18n/time'
import { useT } from '../../i18n'
import { api, attempt, onAgentAccess, showToast } from '../../store'
import { ActionRow, Button, Callout, Field, IconButton, RadioList, TextInput, type FieldControlProps } from '../../ui'
import { Row, saveSettings, Section, ToggleRow, useSettings } from './controls'
import './agentAccess.css'

const LEVEL_KEYS: Record<AgentAccessLevel, { label: PlainKey; desc: PlainKey }> = {
  read: { label: 'agentAccess.level.read', desc: 'agentAccess.level.read.desc' },
  ask: { label: 'agentAccess.level.ask', desc: 'agentAccess.level.ask.desc' },
  'ask-except-edits': { label: 'agentAccess.level.askExceptEdits', desc: 'agentAccess.level.askExceptEdits.desc' },
  auto: { label: 'agentAccess.level.auto', desc: 'agentAccess.level.auto.desc' },
  'never-ask': { label: 'agentAccess.level.neverAsk', desc: 'agentAccess.level.neverAsk.desc' }
}

const MIN_PORT = 1024
const MAX_PORT = 65_535

/** What main says about agents on this computer: read once, then kept current by the `agent-access` event. */
function useAgentAccess(): [AgentAccessInfo | null, (next: AgentAccessInfo) => void] {
  const [info, setInfo] = useState<AgentAccessInfo | null>(null)
  useEffect(() => {
    let live = true
    void api.agentAccessInfo().then((next) => live && setInfo(next), () => undefined)
    const off = onAgentAccess((next) => setInfo(next))
    return () => {
      live = false
      off()
    }
  }, [])
  return [info, setInfo]
}

/** Read-only text to copy (the address, a setup command), as the browser link in the phone's pairing panel. */
function CopyText({ control, value, copyLabel }: { control: FieldControlProps; value: string; copyLabel: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const copy = () =>
    void navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => showToast(t('settings.masked.copyFailed', { label: value }), 'error')
    )
  return (
    <div className="aa-copy">
      <TextInput {...control} className="aa-copy-text" mono readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
      <IconButton label={copied ? t('settings.data.agentAccess.copied') : copyLabel} onClick={copy}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </IconButton>
    </div>
  )
}

/** One sign-in waiting: what it calls itself, where it returns, the code its page shows, the level, Approve and Deny. */
function PendingSignIn({ pending, onInfo }: { pending: AgentAccessPending; onInfo: (next: AgentAccessInfo) => void }) {
  const t = useT()
  const [code, setCode] = useState('')
  const [level, setLevel] = useState<AgentAccessLevel>(DEFAULT_AGENT_ACCESS_LEVEL)
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const approve = async () => {
    if (!code.trim()) return setError(t('settings.data.agentAccess.codeMissing'))
    setBusy(true)
    try {
      const next = await api.agentAccessApprove(pending.id, code, level)
      setError(undefined)
      showToast(t('settings.data.agentAccess.approved', { name: pending.name }))
      onInfo(next)
    } catch (err) {
      // A wrong code says how many tries are left; the third denies the sign-in, and the list drops it.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const deny = async () => {
    const next = await attempt(() => api.agentAccessDeny(pending.id))
    if (next) onInfo(next)
  }
  return (
    <Row
      label={t('settings.data.agentAccess.pendingTitle', { name: pending.name })}
      help={t('settings.data.agentAccess.pendingWhere', { redirect: pending.redirect, time: formatClock(pending.expiresAt, t.locale) })}
      below={
        <div className="aa-pending" role="group" aria-label={t('settings.data.agentAccess.pendingTitle', { name: pending.name })}>
          <Field label={t('settings.data.agentAccess.code')} description={t('settings.data.agentAccess.codeHelp')} error={error}>
            {(control) => (
              <TextInput
                {...control}
                mono
                width={140}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void approve()}
              />
            )}
          </Field>
          <RadioList<AgentAccessLevel>
            legend={t('settings.data.agentAccess.level')}
            value={level}
            onChange={setLevel}
            options={AGENT_ACCESS_LEVELS.map((value) => ({ value, label: t(LEVEL_KEYS[value].label), description: t(LEVEL_KEYS[value].desc) }))}
          />
          <div className="aa-actions">
            <Button size="sm" disabled={busy} onClick={() => void deny()}>
              {t('settings.data.agentAccess.deny')}
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void approve()}>
              {t('settings.data.agentAccess.approve')}
            </Button>
          </div>
        </div>
      }
    />
  )
}

function GrantRow({ grant, onInfo }: { grant: AgentGrant; onInfo: (next: AgentAccessInfo) => void }) {
  const t = useT()
  const revoke = async () => {
    if (!window.confirm(t('settings.data.agentAccess.revokeConfirm', { name: grant.name }))) return
    const next = await attempt(() => api.agentAccessRevoke(grant.id))
    if (next) onInfo(next)
  }
  const used = grant.lastSeen ? t('settings.data.agentAccess.lastUsed', { when: timeAgo(grant.lastSeen, t.locale) }) : t('settings.data.agentAccess.neverUsed')
  return (
    <li>
      <ActionRow
        divided
        actions={
          <Button size="sm" aria-label={t('settings.data.agentAccess.revokeNamed', { name: grant.name })} onClick={() => void revoke()}>
            {t('settings.data.agentAccess.revoke')}
          </Button>
        }
      >
        <span className="aa-grant">
          <span className="aa-grant-name">{grant.name}</span>
          <span className="faint small">
            {t('settings.data.agentAccess.grantLine', { level: t(LEVEL_KEYS[grant.level].label), date: formatDate(grant.grantedAt, t.locale) })} · {used} · {grant.redirect}
          </span>
        </span>
      </ActionRow>
    </li>
  )
}

export function AgentAccessSection() {
  const t = useT()
  const settings = useSettings()
  const [info, setInfo] = useAgentAccess()
  const [port, setPort] = useState(String(settings.agentAccessPort))
  useEffect(() => setPort(String(settings.agentAccessPort)), [settings.agentAccessPort])

  const commitPort = () => {
    const next = Number(port.trim())
    if (next === settings.agentAccessPort) return
    if (!/^\d+$/.test(port.trim()) || next < MIN_PORT || next > MAX_PORT) {
      showToast(t('settings.data.agentAccess.portInvalid', { min: MIN_PORT, max: MAX_PORT }), 'error')
      return setPort(String(settings.agentAccessPort))
    }
    void saveSettings({ agentAccessPort: next })
  }

  const on = Boolean(info?.enabled)
  const setup = info ? agentAccessSetup(info.url) : null
  return (
    <Section title={t('settings.data.agentAccess.section')} description={`${t('settings.data.agentAccess.sectionDesc')} ${t('settings.data.agentAccess.limits')}`}>
      <ToggleRow
        id="agent-access"
        label={t('settings.data.agentAccess')}
        help={t('settings.row.agentAccess.desc')}
        detail={on && info ? t('settings.data.agentAccess.listening', { address: `127.0.0.1:${info.port}` }) : undefined}
        // Whether it listens: a port it couldn't bind turns the setting off, which the next snapshot says too.
        checked={info ? info.enabled : settings.agentAccessEnabled}
        onChange={(agentAccessEnabled) => void saveSettings({ agentAccessEnabled })}
      />
      <Row id="agent-access-port" label={t('settings.data.agentAccessPort')} help={t('settings.row.agentAccessPort.desc')}>
        {(control) => (
          <TextInput
            {...control}
            width={90}
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            onBlur={commitPort}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.currentTarget.blur()}
          />
        )}
      </Row>
      {info?.error && (
        <div className="aa-callout">
          <Callout tone="error" role="alert">
            {info.error}
          </Callout>
        </div>
      )}
      {on && info && setup && (
        <>
          <Row label={t('settings.data.agentAccess.address')} help={t('settings.data.agentAccess.addressHelp')} stacked>
            {(control) => <CopyText control={control} value={info.url} copyLabel={t('settings.data.agentAccess.copy', { what: t('settings.data.agentAccess.address') })} />}
          </Row>
          <Row label={t('settings.data.agentAccess.claude')} help={t('settings.data.agentAccess.claudeHelp')} stacked>
            {(control) => <CopyText control={control} value={setup.claude} copyLabel={t('settings.data.agentAccess.copy', { what: t('settings.data.agentAccess.claude') })} />}
          </Row>
          <Row label={t('settings.data.agentAccess.codex')} help={t('settings.data.agentAccess.codexHelp')} stacked>
            {(control) => <CopyText control={control} value={setup.codex} copyLabel={t('settings.data.agentAccess.copy', { what: t('settings.data.agentAccess.codex') })} />}
          </Row>
        </>
      )}
      {info?.pending.map((p) => <PendingSignIn key={p.id} pending={p} onInfo={setInfo} />)}
      {info && (on || info.grants.length > 0) && (
        <Row
          label={t('settings.data.agentAccess.signedIn')}
          below={
            info.grants.length ? (
              <ul className="aa-grants" aria-label={t('settings.data.agentAccess.signedIn')}>
                {info.grants.map((g) => (
                  <GrantRow key={g.id} grant={g} onInfo={setInfo} />
                ))}
              </ul>
            ) : (
              <Callout tone="neutral">{t('settings.data.agentAccess.none')}</Callout>
            )
          }
        />
      )}
    </Section>
  )
}
