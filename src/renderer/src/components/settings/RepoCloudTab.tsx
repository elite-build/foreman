// Repository → Remote: turn remote workspaces on for this repository,
// pick where they run (Vercel, Docker, E2B, Daytona: each needs a connection, and only implemented providers can be
// picked), the connection when there are several, the sandbox's size and region as that provider offers them, the
// sleep policy, and its base: the sandbox every new workspace starts from (the clone plus the install script,
// saved), on providers that keep one. The setup steps from Scripts & checks still run on every new workspace.
// Kept on this computer, never in settings.toml.
import { Check, CircleDashed, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CLOUD_PROVIDER_IDS, cloudProvider, logTail, providerLabel, providerRegion, repoCloud, type CloudProviderId } from '../../../../shared/cloud'
import { formatClock } from '../../../../shared/i18n/time'
import { sandboxServiceFor, type ConnectionView } from '../../../../shared/integrations'
import { duration } from '../../../../shared/setupSteps'
import type { CloudBuild, Repo, RepoCloud, SetupStep, Workspace } from '../../../../shared/types'
import { CLOUD_REGIONS, cloudStatusWord, connectionPlan, memoryGb, minutesLeft, providerFacts, repoProviderId, sandboxConnection } from '../../cloudView'
import { useT } from '../../i18n'
import { api, attempt, onCloudBuildLog, openSettingsPage, showToast, timeAgo, useStore } from '../../store'
import { cloudAction, cloudTone, statusText, useLimitLabel, useRepoProvider } from '../cloud/CloudBits'
import { Button, LinkButton, RadioCards, Segmented, Select, Spinner, Status, Tag, TextArea, TextInput } from '../../ui'
import { Row, rowDomId, saveRepo, Section, ToggleRow, useDraft } from './controls'
import { ServiceMark } from './integrations/ServiceMark'
import { Dialog } from './RepoDialog'
import '../cloud/cloud.css'

type CloudPatch = Partial<Omit<RepoCloud, 'build'>>

const NO_STEPS: SetupStep[] = []

const save = (repoId: string, patch: CloudPatch) => saveRepo(repoId, { cloud: patch })

/** A provider's region, with Vercel's city names where they're known. */
function regionLabel(t: ReturnType<typeof useT>, region: string): string {
  return (CLOUD_REGIONS as readonly string[]).includes(region) ? t('cloud.regionLabel', { region, city: t(`cloud.region.${region as (typeof CLOUD_REGIONS)[number]}`) }) : region
}

export function RepoCloudTab({ repo }: { repo: Repo }) {
  const t = useT()
  const cloudOn = useStore((s) => Boolean(s.snapshot!.settings.cloud?.enabled))
  const connections = useStore((s) => s.snapshot!.integrations.connections)
  const settings = repoCloud(repo)
  const id = repoProviderId(repo, connections)
  const label = providerLabel(id)
  const preflight = useRepoProvider(repo)
  const { limits, capabilities } = providerFacts(id, preflight?.provider)
  const connection = sandboxConnection(connections, id, settings.connectionId || undefined)
  const usable = Boolean(cloudProvider(id).implemented && connection && !connection.problem)
  const limit = useLimitLabel(capabilities.sessionCap ? limits.maxSessionMs : undefined)
  const [confirmOff, setConfirmOff] = useState(false)
  const [moveTo, setMoveTo] = useState<{ provider: CloudProviderId; connectionId: string } | null>(null)

  // The experimental switch gates everything but the page that turns it on.
  if (!cloudOn) {
    return (
      <Section>
        <Row label={t('cloud.repo.enabled.label')} help={t('cloud.repo.flagOff')}>
          <Button size="sm" onClick={() => openSettingsPage({ section: 'cloud', scrollTo: 'cloud-workspaces' })}>
            {t('cloud.repo.openCloudSettings')}
          </Button>
        </Row>
      </Section>
    )
  }

  const integrations = (
    <LinkButton key="int" underline onClick={() => openSettingsPage({ section: 'integrations' })}>
      {t('settings.page.integrations')}
    </LinkButton>
  )
  const setEnabled = (on: boolean) => {
    // Turning it off deletes the base sandbox (WorkspaceService.updateRepo), so that asks first.
    if (!on && settings.build) setConfirmOff(true)
    else void save(repo.id, { enabled: on })
  }
  /** Another provider or connection: sizes and regions follow it, and a base on the old one is deleted (so that asks first). */
  const choose = (next: { provider: CloudProviderId; connectionId: string }) => {
    if (next.provider === id && next.connectionId === (settings.connectionId ?? '')) return
    if (settings.build) setMoveTo(next)
    else void move(next)
  }
  const move = (next: { provider: CloudProviderId; connectionId: string }) => {
    const caps = cloudProvider(next.provider).capabilities
    return save(repo.id, {
      ...next,
      region: providerRegion(settings.region, caps, next.provider),
      vcpus: caps.vcpuOptions.includes(settings.vcpus) ? settings.vcpus : cloudProvider(next.provider).defaultVcpus
    })
  }
  const service = sandboxServiceFor(id)
  const sameService = connections.filter((c) => c.service === service)
  const sizes = capabilities.vcpuOptions.map((vcpus) => {
    const tooBig = vcpus > limits.maxVcpus
    return {
      value: String(vcpus),
      label: (
        <>
          {id === 'vercel' ? t('cloud.size', { vcpus, gb: memoryGb(vcpus) }) : t('cloud.sizeVcpus', { vcpus })}
          {tooBig && id === 'vercel' && <Tag tone="outline" className="cloud-seg-pro">
              {t('cloud.repo.size.pro')}
            </Tag>}
        </>
      ),
      disabled: tooBig,
      title: tooBig ? t('cloud.repo.size.needsPro') : undefined
    }
  })
  const regionValue = providerRegion(settings.region, capabilities, id)
  const regions = capabilities.regions.map((region) => ({ value: region, label: regionLabel(t, region) }))
  const sizeHelp = id === 'vercel' ? t('cloud.repo.size.help', { plan: t(`cloud.plan.${connectionPlan(connection)}`), max: limits.maxVcpus }) : t('cloud.repo.size.helpProvider', { provider: label, max: limits.maxVcpus })

  return (
    <>
      <Section>
        <Row id="repo-cloud-provider" stacked label={t('cloud.repo.provider.label')} help={t('cloud.repo.provider.help')}>
          <ProviderPicker value={id} connections={connections} onPick={(provider) => choose({ provider, connectionId: '' })} />
        </Row>
        {sameService.length > 1 && (
          <Row id="repo-cloud-connection" label={t('cloud.repo.connection.label')} help={t('cloud.repo.connection.help', { provider: label })}>
            <Select
              label={t('cloud.repo.connection.label')}
              value={settings.connectionId ?? ''}
              options={[
                { value: '', label: t('cloud.repo.connection.default', { name: sameService.find((c) => c.isDefault)?.name ?? label }) },
                ...sameService.map((c) => ({ value: c.id, label: c.name }))
              ]}
              onChange={(connectionId) => choose({ provider: id, connectionId })}
            />
          </Row>
        )}
        <ToggleRow
          id="repo-cloud-enabled"
          label={t('cloud.repo.enabled.label')}
          help={connection ? t('cloud.repo.enabled.help', { provider: label, connection: connection.name }) : t('cloud.repo.enabled.helpNone', { provider: label })}
          detail={
            !cloudProvider(id).implemented
              ? t('cloud.repo.enabled.soon', { provider: label })
              : !connection
                ? t.rich('cloud.repo.enabled.noConnection', { provider: label, integrations })
                : connection.problem
                  ? t.rich('cloud.repo.enabled.connectionProblem', { provider: label, integrations })
                  : undefined
          }
          checked={settings.enabled}
          disabled={!settings.enabled && !usable}
          onChange={setEnabled}
        />
        {settings.enabled && (
          <>
            <Row id="repo-cloud-size" label={t('cloud.repo.size.label')} help={sizeHelp}>
              <Segmented label={t('cloud.repo.size.label')} value={String(settings.vcpus)} options={sizes} onChange={(v) => void save(repo.id, { vcpus: Number(v) })} />
            </Row>
            {/* Providers without regions (Docker) have no control here. */}
            {regions.length > 0 && (
              <Row id="repo-cloud-region" label={t('cloud.repo.region.label')} help={t('cloud.repo.region.help')}>
                <Select label={t('cloud.repo.region.label')} value={regionValue} options={regions} onChange={(region) => void save(repo.id, { region })} />
              </Row>
            )}
          </>
        )}
      </Section>

      {settings.enabled && (
        <>
          <Section title={t('cloud.repo.sleep.title')}>
            <IdleRow repoId={repo.id} value={settings.idleMinutes} />
            {/* Only providers whose sessions end by themselves cut a turn off. */}
            {capabilities.sessionCap && (
              <ToggleRow
                id="repo-cloud-continue"
                label={t('cloud.repo.continue.label')}
                help={t('cloud.repo.continue.help', { limit })}
                checked={settings.autoContinue}
                onChange={(autoContinue) => void save(repo.id, { autoContinue })}
              />
            )}
          </Section>

          <Section title={t('cloud.repo.computer.title')} description={capabilities.base ? t('cloud.repo.computer.desc') : t('cloud.repo.computer.descNoBase', { provider: label })}>
            {capabilities.base ? <BuildBlock repo={repo} build={settings.build} canBuild={usable} provider={label} /> : <FreshCloneRow provider={label} />}
            <InstallScriptRow repoId={repo.id} value={settings.installScript} built={capabilities.base && settings.build?.status === 'active'} />
            <SetupStepsRow repoId={repo.id} />
          </Section>

          <Section title={t('cloud.repo.running.title')} plain>
            <RunningList repoId={repo.id} />
          </Section>
        </>
      )}

      {confirmOff && (
        <Dialog
          title={t('cloud.repo.off.title', { repo: repo.name })}
          description={t('cloud.repo.off.desc')}
          onClose={() => setConfirmOff(false)}
          footer={
            <>
              <span className="spacer" />
              <Button autoFocus onClick={() => setConfirmOff(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmOff(false)
                  void save(repo.id, { enabled: false })
                }}
              >
                {t('cloud.repo.off.confirm')}
              </Button>
            </>
          }
        />
      )}
      {moveTo && (
        <Dialog
          title={t('cloud.repo.move.title', { repo: repo.name, provider: providerLabel(moveTo.provider) })}
          description={t('cloud.repo.move.desc', { from: label, provider: providerLabel(moveTo.provider) })}
          onClose={() => setMoveTo(null)}
          footer={
            <>
              <span className="spacer" />
              <Button autoFocus onClick={() => setMoveTo(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const next = moveTo
                  setMoveTo(null)
                  void move(next)
                }}
              >
                {t('cloud.repo.move.confirm')}
              </Button>
            </>
          }
        />
      )}
    </>
  )
}

/**
 * One card per provider. A provider can be picked when its module is implemented and a connection for it exists;
 * the others say why not ("coming soon", "not connected").
 */
function ProviderPicker({ value, connections, onPick }: { value: CloudProviderId; connections: ConnectionView[]; onPick: (provider: CloudProviderId) => void }) {
  const t = useT()
  return (
    <RadioCards<CloudProviderId>
      legend={t('cloud.repo.provider.label')}
      hideLegend
      value={value}
      onChange={(p) => {
        const connection = sandboxConnection(connections, p)
        if (cloudProvider(p).implemented && connection) onPick(p)
      }}
      options={CLOUD_PROVIDER_IDS.map((p) => {
        const info = cloudProvider(p)
        const connection = sandboxConnection(connections, p)
        const selectable = info.implemented && Boolean(connection)
        const status = !info.implemented ? t('cloud.repo.provider.soon') : !connection ? t('cloud.repo.provider.notConnected') : connection.problem ? t('cloud.repo.provider.problem') : t('cloud.repo.provider.connected', { name: connection.name })
        return {
          value: p,
          icon: <ServiceMark service={sandboxServiceFor(p)} size={18} />,
          label: (
            <>
              {info.label}
              {!info.implemented && (
                <>
                  {' '}
                  <Tag tone="outline">{t('cloud.repo.provider.soonTag')}</Tag>
                </>
              )}
            </>
          ),
          description: (
            <>
              <span className="cloud-provider-sub">{info.kind === 'local' ? t('cloud.repo.provider.local') : t('cloud.repo.provider.hosted')}</span>
              <span className="cloud-provider-sub">{status}</span>
            </>
          ),
          disabled: !selectable && value !== p,
          invalid: Boolean(connection?.problem)
        }
      })}
    />
  )
}

/** A provider without bases: nothing to build; each workspace is cloned and set up when it's made. */
function FreshCloneRow({ provider }: { provider: string }) {
  const t = useT()
  return (
    <div id={rowDomId('repo-cloud-build')}>
      <div className="cloud-build">
        <span className="cloud-build-icon ok" aria-hidden>
          <Check size={15} />
        </span>
        <div className="cloud-build-main">
          <div className="cloud-build-title">{t('cloud.build.noBase')}</div>
          <div className="cloud-build-sub">{t('cloud.build.noBaseHelp', { provider })}</div>
        </div>
      </div>
    </div>
  )
}

function IdleRow({ repoId, value }: { repoId: string; value: number }) {
  const t = useT()
  const draft = useDraft(String(value), (next) => {
    const minutes = Number(next.trim())
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      showToast(t('cloud.repo.idle.invalid'), 'error')
      return false
    }
    if (minutes !== value) void save(repoId, { idleMinutes: minutes })
  })
  return (
    <Row id="repo-cloud-idle" label={t('cloud.repo.idle.label')} help={t('cloud.repo.idle.help')}>
      {(control) => (
        <span className="cloud-num">
          <TextInput {...control} mono inputMode="numeric" autoComplete="off" onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.currentTarget.blur()} {...draft} />
          <span>{t('cloud.repo.idle.unit')}</span>
        </span>
      )}
    </Row>
  )
}

/** The build's log: the record's tail, plus chunks streamed since the window last heard about the repository. */
function useBuildLog(repoId: string, build: CloudBuild | undefined): string {
  const saved = build?.log ?? ''
  const savedRef = useRef(saved)
  savedRef.current = saved
  const [live, setLive] = useState<{ id: string; text: string } | null>(null)
  useEffect(
    () =>
      onCloudBuildLog((repo, buildId, chunk) => {
        if (repo !== repoId) return
        setLive((prev) => ({ id: buildId, text: logTail((prev?.id === buildId ? prev.text : savedRef.current) + chunk) }))
      }),
    [repoId]
  )
  return live && live.id === build?.id && live.text.length > saved.length ? live.text : saved
}

function BuildBlock({ repo, build, canBuild, provider }: { repo: Repo; build: CloudBuild | undefined; canBuild: boolean; provider: string }) {
  const t = useT()
  const log = useBuildLog(repo.id, build)
  const [showLog, setShowLog] = useState(false)
  const [starting, setStarting] = useState(false)
  const pre = useRef<HTMLPreElement>(null)
  const building = build?.status === 'building'
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [log, showLog])
  const start = async () => {
    setStarting(true)
    const started = await attempt(() => api.cloudBuildBase(repo.id))
    setStarting(false)
    if (!started) return
    setShowLog(true)
    showToast(t('cloud.build.startedToast', { repo: repo.name }))
  }
  const buildButton = (label: string, primary: boolean) => (
    <Button
      size="sm"
      variant={primary ? 'primary' : 'default'}
      disabled={!canBuild || starting || building}
      title={canBuild ? undefined : t('cloud.build.needsConnection', { provider })}
      icon={starting ? <Spinner size={12} /> : undefined}
      onClick={() => void start()}
    >
      {label}
    </Button>
  )
  const logButton = build && (
    <Button size="sm" aria-expanded={showLog} onClick={() => setShowLog(!showLog)}>
      {showLog ? t('cloud.build.hideLog') : t('cloud.build.viewLog')}
    </Button>
  )

  let icon = <CircleDashed size={15} />
  let tone = ''
  let title = t('cloud.build.none')
  let sub: string = t('cloud.build.noneHelp')
  if (building) {
    icon = <Spinner size={15} />
    title = t('cloud.build.building')
    sub = t('cloud.build.started', { ago: timeAgo(build.startedAt) })
  } else if (build?.status === 'active') {
    icon = <Check size={15} />
    tone = 'ok'
    title = t('cloud.build.active')
    const took = build.finishedAt ? Date.parse(build.finishedAt) - Date.parse(build.startedAt) : NaN
    sub = [
      t('cloud.build.builtAgo', { ago: timeAgo(build.finishedAt ?? build.startedAt) }),
      build.commit ? t('cloud.build.fromCommit', { commit: build.commit.slice(0, 7) }) : '',
      Number.isFinite(took) ? t('cloud.build.took', { duration: duration(took, t) }) : ''
    ]
      .filter(Boolean)
      .join(' · ')
  } else if (build?.status === 'failed') {
    icon = <X size={15} />
    tone = 'bad'
    title = t('cloud.build.failed')
    sub = [build.error, t('cloud.build.failedNote')].filter(Boolean).join(' ')
  }
  // A failed build shows the end of its log straight away: that's where it says why.
  const tail = build?.status === 'failed' && !showLog ? log.split('\n').filter(Boolean).slice(-8).join('\n') : ''

  return (
    <div id={rowDomId('repo-cloud-build')}>
      <div className="cloud-build">
        <span className={`cloud-build-icon ${tone}`} aria-hidden>
          {icon}
        </span>
        <div className="cloud-build-main">
          <div className="cloud-build-title">{title}</div>
          <div className="cloud-build-sub">{sub}</div>
        </div>
        <div className="cloud-build-actions">
          {logButton}
          {!build && buildButton(t('cloud.build.build'), true)}
          {build?.status === 'active' && buildButton(t('cloud.build.build'), false)}
          {build?.status === 'failed' && buildButton(t('cloud.build.retry'), true)}
        </div>
      </div>
      {(showLog || (building && log)) && (
        <div className="cloud-log-wrap">
          <pre ref={pre} className="cloud-log" aria-label={t('cloud.build.log')} tabIndex={0}>
            {log || '…'}
          </pre>
        </div>
      )}
      {tail && (
        <div className="cloud-log-wrap">
          <pre className="cloud-log tail" aria-label={t('cloud.build.log')}>
            {tail}
          </pre>
        </div>
      )}
    </div>
  )
}

function InstallScriptRow({ repoId, value, built }: { repoId: string; value: string; built: boolean }) {
  const t = useT()
  const draft = useDraft(value, (next) => {
    if (next === value) return
    void save(repoId, { installScript: next }).then((ok) => ok && built && showToast(t('cloud.repo.install.changed')))
  })
  return (
    <Row
      id="repo-cloud-install"
      stacked
      label={t('cloud.repo.install.label')}
      help={t.rich('cloud.repo.install.help', { flags: <code key="f">set -euo pipefail</code>, setup: <b key="s">{t('cloud.repo.install.setupPath')}</b> })}
    >
      {(control) => <TextArea {...control} mono className="cloud-script" rows={6} spellCheck={false} placeholder={t('cloud.repo.install.placeholder')} {...draft} />}
    </Row>
  )
}

function SetupStepsRow({ repoId }: { repoId: string }) {
  const t = useT()
  const steps = useStore((s) => s.snapshot!.repoSettings[repoId]?.values.setupSteps) ?? NO_STEPS
  const commands = steps.map((step) => step.command.split('\n')[0].trim() || step.name).join(', ')
  return (
    <Row
      label={t('cloud.repo.setup.label')}
      help={steps.length ? <span className="cloud-commands">{t.rich('cloud.repo.setup.steps', { count: steps.length, commands: <code key="c">{commands}</code> })}</span> : t('cloud.repo.setup.none')}
    >
      <Button size="sm" onClick={() => openSettingsPage({ section: 'repo', repoId, tab: 'scripts', scrollTo: 'setup-script' })}>
        {t('cloud.repo.setup.edit')}
      </Button>
    </Row>
  )
}

function RunningList({ repoId }: { repoId: string }) {
  const t = useT()
  // Filtered after the read: a selector must return what the store holds, not a new array each time.
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  const list = workspaces.filter((w) => w.repoId === repoId && w.cloud && w.state !== 'archived')
  if (!list.length) {
    return (
      <div className="cloud-running">
        <p className="cloud-empty">{t('cloud.repo.running.none')}</p>
      </div>
    )
  }
  return (
    <div className="cloud-running">
      {list.map((ws) => (
        <RunningRow key={ws.id} ws={ws} />
      ))}
    </div>
  )
}

function RunningRow({ ws }: { ws: Workspace }) {
  const t = useT()
  const turnRunning = useStore((s) => s.snapshot!.sessions.some((x) => x.workspaceId === ws.id && x.status === 'running'))
  const [busy, setBusy] = useState(false)
  const cloud = ws.cloud!
  const left = minutesLeft(cloud.sessionExpiresAt, Date.now())
  const extra =
    cloud.status === 'running' && left !== undefined
      ? t('cloud.repo.running.endsIn', { minutes: left })
      : cloud.status === 'sleeping' && cloud.lastActivityAt
        ? t('cloud.repo.running.since', { time: formatClock(cloud.lastActivityAt, t.locale) })
        : ''
  const act = (kind: 'wake' | 'sleep') => {
    setBusy(true)
    void cloudAction(kind, ws, t).finally(() => setBusy(false))
  }
  return (
    <div className="cloud-run-row">
      <span className="cloud-run-name">{ws.name}</span>
      <Status tone={cloudTone(cloud.status)} label={statusText(t, cloudStatusWord(cloud.status, turnRunning))} />
      <span className="cloud-run-text">{extra}</span>
      {busy && <Spinner size={12} />}
      {cloud.status === 'running' && (
        <LinkButton size="sm" disabled={busy} onClick={() => act('sleep')}>
          {t('cloud.action.sleep')}
        </LinkButton>
      )}
      {(cloud.status === 'sleeping' || cloud.status === 'capped') && (
        <LinkButton size="sm" disabled={busy} onClick={() => act('wake')}>
          {t('cloud.action.wake')}
        </LinkButton>
      )}
    </div>
  )
}
