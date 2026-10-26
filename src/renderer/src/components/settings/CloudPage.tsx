// Settings → Remote workspaces: the experimental switch, how each
// agent signs in inside a sandbox (the subscription sign-in on this computer doesn't travel), the orphan
// and snapshot policies (on every provider), the running limit, and this month's use per provider. This
// page is the one remote surface shown while the switch is off: it's where the switch is.
import { CircleAlert, ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { cloudSettings, isCloudProviderId, providerLabel } from '../../../../shared/cloud'
import { formatDate } from '../../../../shared/i18n/time'
import type { CloudSettings, CloudUsageView } from '../../../../shared/types'
import { barTone, cloudCap, connectionPlan, countBar, cpuUsageBar, memoryUsageBar, runningCloud, setupTokenExpiry, setupTokenState, showsConcurrency, usageResetsAt, type UsageBar } from '../../cloudView'
import { useT } from '../../i18n'
import { api, attempt, openSettingsPage, showToast, useStore } from '../../store'
import { AgentIcon } from '../composer/AgentPicker'
import { Button, LinkButton, Meter, RadioCards, Spinner, Switch, Tag, TextInput, type MeterTone } from '../../ui'
import { Page, Row, rowDomId, saveSettings, Section, ToggleRow, useDraft, useSettings } from './controls'
import { SecretInput } from './integrations/AddConnectionDialog'
import { LoginTerminal } from './LoginTerminal'
import { useSandboxConnectionsKey } from '../cloud/CloudBits'
import '../cloud/cloud.css'

const save = (patch: Partial<CloudSettings>) => saveSettings({ cloud: patch as CloudSettings })

export function CloudPage() {
  const t = useT()
  const settings = useSettings()
  const cloud = cloudSettings(settings)
  // The sandbox connections there are, and whether any of them can be used.
  const connections = useStore((s) => s.snapshot!.integrations.connections)
  const sandbox = connections.filter((c) => isCloudProviderId(c.service))
  const working = sandbox.filter((c) => !c.problem)
  const usage = useUsage()
  const toIntegrations = () => openSettingsPage({ section: 'integrations' })
  return (
    <Page
      title={
        <>
          {t('settings.page.cloud')}
          <Tag tone="warn" className="cloud-title-tag">
            {t('cloud.experimental')}
          </Tag>
        </>
      }
      description={t('cloud.page.desc')}
    >
      <Section>
        <Row id="cloud-workspaces" label={t('cloud.flag.label')} help={t('cloud.flag.help')}>
          {(control) => (
            <>
              {working.length ? (
                <Tag tone="ok">
                  {t('cloud.flag.connected', { providers: [...new Set(working.map((c) => providerLabel(isCloudProviderId(c.service) ? c.service : undefined)))].join(', ') })}
                </Tag>
              ) : sandbox.length ? (
                <LinkButton size="sm" danger onClick={toIntegrations}>
                  <CircleAlert size={12} aria-hidden /> {t('cloud.flag.problem')}
                </LinkButton>
              ) : (
                <LinkButton size="sm" onClick={toIntegrations}>
                  {t('cloud.flag.connect')}
                </LinkButton>
              )}
              <Switch {...control} checked={cloud.enabled} onChange={(enabled) => void save({ enabled })} />
            </>
          )}
        </Row>
      </Section>

      <Section title={t('cloud.claude.title')}>
        <ClaudeSignIn claudeAuth={cloud.claudeAuth} />
      </Section>

      <Section title={t('cloud.codex.title')}>
        <CodexRow />
      </Section>

      <Section title={t('cloud.house.title')}>
        <ToggleRow
          id="cloud-wake-on-open"
          label={t('cloud.house.wake.label')}
          help={t('cloud.house.wake.help')}
          checked={cloud.wakeOnOpen}
          onChange={(wakeOnOpen) => void save({ wakeOnOpen })}
        />
        <ToggleRow
          id="cloud-stop-orphans"
          label={t('cloud.house.orphans.label')}
          help={t.rich('cloud.house.orphans.help', { tag: <code key="tag">app=foreman</code> })}
          checked={cloud.stopOrphansOnLaunch}
          onChange={(stopOrphansOnLaunch) => void save({ stopOrphansOnLaunch })}
        />
        <ToggleRow
          id="cloud-delete-snapshots"
          label={t('cloud.house.snapshots.label')}
          help={t('cloud.house.snapshots.help')}
          checked={cloud.deleteSnapshotsOnForget}
          onChange={(deleteSnapshotsOnForget) => void save({ deleteSnapshotsOnForget })}
        />
        {/* One provider: its plan's concurrency is the ceiling worth saying; with several, each has its own. */}
        <MaxRunningRow value={cloud.maxRunning} planCap={usage?.length === 1 && showsConcurrency(usage[0].limits) ? usage[0].limits.maxConcurrent : undefined} />
      </Section>

      {usage?.map((view, i) => <UsageSection key={view.provider} view={view} first={i === 0} />)}
    </Page>
  )
}

// ---- Claude: a setup token or the API key ----

function ClaudeSignIn({ claudeAuth }: { claudeAuth: CloudSettings['claudeAuth'] }) {
  const t = useT()
  const keyHint = useStore((s) => s.snapshot!.agentKeys.ANTHROPIC_API_KEY)
  const [token, setToken] = useState<{ hint: string; savedAt?: string } | null | undefined>(undefined)
  const [terminal, setTerminal] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => void api.cloudClaudeToken().then(setToken, () => setToken(null)), [])
  useEffect(load, [load])

  const state = setupTokenState(token, Date.now())
  const expiry = setupTokenExpiry(token?.savedAt)
  const date = (at: number | string) => formatDate(at, t.locale, { day: 'numeric', month: 'short', year: 'numeric' })
  const tokenDesc =
    state === 'missing'
      ? t('cloud.claude.token.missing')
      : state === 'expired' && expiry
        ? t('cloud.claude.token.expired', { date: date(expiry) })
        : state === 'expiring' && expiry
          ? t('cloud.claude.token.expiring', { date: date(expiry) })
          : t('cloud.claude.token.saved', { hint: token?.hint ?? '', date: token?.savedAt ? date(token.savedAt) : '' })
  // Expired is the problem state (mocks, screen 3); a token not saved yet is just a step to take.
  const bad = claudeAuth === 'setup-token' && state === 'expired'

  const savePasted = async () => {
    if (!pasted.trim() || busy) return
    setBusy(true)
    const ok = await attempt(async () => (await api.cloudSetClaudeToken(pasted.trim()), true))
    setBusy(false)
    if (!ok) return
    setPasted('')
    setPasting(false)
    showToast(t('cloud.claude.token.savedToast'))
    load()
  }
  const remove = async () => {
    if (await attempt(async () => (await api.cloudSetClaudeToken(null), true))) {
      showToast(t('cloud.claude.token.removedToast'))
      load()
    }
  }

  return (
    <Row id="cloud-claude-auth" label={t('cloud.claude.label')} help={t('cloud.claude.help')} stacked>
      <div className="cloud-claude">
        <RadioCards<CloudSettings['claudeAuth']>
          legend={t('cloud.claude.label')}
          hideLegend
          value={claudeAuth}
          onChange={(next) => void save({ claudeAuth: next })}
          options={[
            {
              value: 'setup-token',
              icon: <AgentIcon agent="claude" size={13} />,
              label: t.rich('cloud.claude.token.label', { command: <code key="c">claude setup-token</code> }),
              description: token === undefined ? <Spinner size={12} label={t('common.loading')} /> : tokenDesc,
              invalid: bad && token !== undefined,
              actions: (
                <>
                  <Button size="sm" variant={state === 'expired' || state === 'expiring' ? 'primary' : 'default'} onClick={() => setTerminal(true)}>
                    {t('cloud.claude.token.run')}
                  </Button>
                  <LinkButton size="sm" aria-expanded={pasting} onClick={() => setPasting(!pasting)}>
                    {t('cloud.claude.token.paste')}
                  </LinkButton>
                  {token && (
                    <LinkButton size="sm" danger onClick={() => void remove()}>
                      {t('common.remove')}
                    </LinkButton>
                  )}
                </>
              )
            },
            {
              value: 'api-key',
              label: t('cloud.claude.key.label'),
              description: keyHint !== undefined ? t('cloud.claude.key.saved', { hint: keyHint }) : t('cloud.claude.key.missing'),
              invalid: keyHint === undefined,
              actions:
                keyHint === undefined ? (
                  <LinkButton size="sm" onClick={() => openSettingsPage({ section: 'agents', agent: 'claude' })}>
                    {t('cloud.claude.key.open')}
                  </LinkButton>
                ) : undefined
            }
          ]}
        />
        {terminal && (
          <div className="cloud-terminal">
            <LoginTerminal
              command="claude-setup-token"
              commandLabel="claude setup-token"
              buttonLabel={t('cloud.claude.token.run')}
              startOpen
              onClose={() => setTerminal(false)}
              onDone={() => {
                setTerminal(false)
                setPasting(true)
              }}
            />
            <p className="set-help">{t('cloud.claude.token.terminalHint')}</p>
          </div>
        )}
        {pasting && (
          <div className="cloud-paste">
            <SecretInput value={pasted} onChange={setPasted} label={t('cloud.claude.token.fieldLabel')} placeholder="sk-ant-oat01-…" onEnter={() => void savePasted()} />
            <Button size="sm" variant="primary" icon={busy ? <Spinner size={12} /> : undefined} disabled={!pasted.trim() || busy} onClick={() => void savePasted()}>
              {t('cloud.claude.token.save')}
            </Button>
          </div>
        )}
      </div>
    </Row>
  )
}

// ---- Codex: the API key, read-only here ----

function CodexRow() {
  const t = useT()
  const hint = useStore((s) => s.snapshot!.agentKeys.CODEX_API_KEY)
  return (
    <Row id="cloud-codex-auth" label={t('cloud.codex.label')} help={hint !== undefined ? t('cloud.codex.saved', { hint }) : t('cloud.codex.missing')}>
      {hint !== undefined ? (
        <Tag tone="ok">{t('cloud.codex.chip')}</Tag>
      ) : (
        <>
          <Tag tone="warn">{t('cloud.codex.noKey')}</Tag>
          <LinkButton size="sm" onClick={() => openSettingsPage({ section: 'agents', agent: 'codex' })}>
            {t('cloud.claude.key.open')}
          </LinkButton>
        </>
      )}
    </Row>
  )
}

function MaxRunningRow({ value, planCap }: { value: number; planCap?: number }) {
  const t = useT()
  const draft = useDraft(String(value), (next) => {
    const n = Number(next.trim())
    if (!Number.isInteger(n) || n < 1 || n > 10_000) {
      showToast(t('cloud.house.max.invalid'), 'error')
      return false
    }
    if (n !== value) void save({ maxRunning: n })
  })
  return (
    <Row
      id="cloud-max-running"
      label={t('cloud.house.max.label')}
      help={planCap !== undefined ? t('cloud.house.max.help', { limit: planCap }) : t('cloud.house.max.helpNoCap')}
    >
      {(control) => (
        <span className="cloud-num">
          <TextInput {...control} {...draft} mono inputMode="numeric" autoComplete="off" onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.currentTarget.blur()} />
        </span>
      )}
    </Row>
  )
}

// ---- this month, per provider ----

/** Each provider's usage this month (Api.cloudUsage), asked again when a sandbox starts or stops. */
function useUsage(): CloudUsageView[] | null {
  const running = useStore((s) => runningCloud(s.snapshot!.workspaces).length)
  const connections = useSandboxConnectionsKey()
  const [usage, setUsage] = useState<CloudUsageView[] | null>(null)
  useEffect(() => {
    void api.cloudUsage().then(setUsage, () => setUsage(null))
  }, [running, connections])
  return usage
}

function UsageSection({ view, first }: { view: CloudUsageView; first: boolean }) {
  const t = useT()
  const settings = useSettings()
  const connection = useStore((s) => s.snapshot!.integrations.connections.find((c) => c.id === view.connectionId))
  const provider = providerLabel(view.provider)
  // Only Vercel's plan has monthly allowances to draw bars against (shared/cloud.ts planAllowances).
  const plan = view.provider === 'vercel' ? connectionPlan(connection) : null
  const { usage } = view
  const cpu = cpuUsageBar(usage, plan)
  const memory = memoryUsageBar(usage, plan)
  const slots = countBar(view.running, cloudCap(settings, view.limits))
  const resets = formatDate(usageResetsAt(Date.now()), t.locale, { day: 'numeric', month: 'short' })
  const url = connection?.identity?.url
  return (
    <Section
      title={t('cloud.usage.title', { provider })}
      description={plan ? t('cloud.usage.desc', { plan: t(`cloud.plan.${plan}`), date: resets }) : t('cloud.usage.descProvider', { name: view.connectionName ?? provider, date: resets })}
    >
      <div id={first ? rowDomId('cloud-usage') : undefined}>
        <div className="cloud-usage">
          {view.capabilities.billed && (
            <>
              <UsageLine label={t('cloud.usage.cpu')} bar={cpu} text={cpu.of !== undefined ? t('cloud.usage.cpuOf', { used: cpu.used, of: cpu.of }) : t('cloud.usage.cpuHours', { used: cpu.used })} />
              {memory ? (
                <UsageLine
                  label={t('cloud.usage.memory')}
                  bar={memory}
                  text={memory.of !== undefined ? t('cloud.usage.memoryOf', { used: memory.used, of: memory.of }) : t('cloud.usage.memoryGbHours', { used: memory.used })}
                />
              ) : (
                <>
                  <span className="cloud-usage-label">{t('cloud.usage.memory')}</span>
                  <span />
                  <span className="faint">{t('cloud.usage.memoryUnknown')}</span>
                </>
              )}
            </>
          )}
          <UsageLine label={t('cloud.usage.running')} bar={slots} text={t('cloud.usage.runningOf', { used: slots.used, of: slots.of ?? 0 })} />
          <span className="cloud-usage-label">{t('cloud.usage.stops')}</span>
          <span />
          <span>{t('cloud.usage.stopsCount', { count: usage.stops })}</span>
        </div>
        <div className="cloud-usage-foot">
          {t('cloud.usage.foot')} {view.capabilities.billed && t('cloud.usage.memoryFoot')}{' '}
          {url && view.provider === 'vercel' && (
            <LinkButton size="sm" onClick={() => void attempt(() => api.openExternal(`${url.replace(/\/$/, '')}/~/usage`))}>
              {t('cloud.usage.open', { provider })} <ExternalLink size={11} aria-hidden />
            </LinkButton>
          )}
        </div>
      </div>
    </Section>
  )
}

const METER_TONE: Record<ReturnType<typeof barTone>, MeterTone> = { green: 'ok', amber: 'warn', red: 'error' }

function UsageLine({ label, bar, text }: { label: string; bar: UsageBar; text: string }) {
  return (
    <>
      <span className="cloud-usage-label">{label}</span>
      {bar.fraction !== undefined ? (
        <Meter label={label} value={bar.fraction * 100} valueText={text} tone={METER_TONE[barTone(bar.fraction)]} />
      ) : (
        <span />
      )}
      <span>{text}</span>
    </>
  )
}
