// New workspace → Runs on: This computer or Remote, shown when
// remote workspaces are on and the repository offers them. Remote says which provider and connection the
// workspace will run on, what it starts from, and the one honest caveat for providers with short sessions;
// at the running limit it's refused with a way to free a slot.
import { useState } from 'react'
import { cloudSettings, providerLabel, providerRegion, providerVcpus, repoCloud } from '../../../../shared/cloud'
import type { CloudProviderView, Repo } from '../../../../shared/types'
import { blocksChoice, cloudReadiness, memoryGb, providerFacts, sessionCap, shortSessionsFor, type CloudBlock, type CloudReadiness } from '../../cloudView'
import { useT, type RendererT } from '../../i18n'
import { openSettingsPage, timeAgo, useStore } from '../../store'
import { Button, Callout, LinkButton, Segmented, Tag } from '../../ui'
import { cloudAction, useRepoProvider } from './CloudBits'
import './cloud.css'

export type RunsOnLocation = 'local' | 'cloud'

/** Whether the repository offers Remote now and why not, with main's view of its provider; null while there's no repository. */
export function useCloudReadiness(repo: Repo | undefined): (CloudReadiness & { view?: CloudProviderView }) | null {
  const settings = useStore((s) => s.snapshot!.settings)
  const connections = useStore((s) => s.snapshot!.integrations.connections)
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  const view = useRepoProvider(repo)?.provider
  return repo ? { ...cloudReadiness({ settings, repo, connections, workspaces, provider: view }), ...(view ? { view } : {}) } : null
}

function blockText(t: RendererT, block: CloudBlock, provider: string): string {
  switch (block) {
    case 'flag':
      return t('cloud.nw.block.flag')
    case 'repo':
      return t('cloud.nw.block.repo')
    case 'soon':
      return t('cloud.nw.block.soon', { provider })
    case 'connection':
      return t('cloud.nw.block.connection', { provider })
    case 'connection-problem':
      return t('cloud.nw.block.connectionProblem', { provider })
    case 'no-build':
      return t('cloud.nw.block.noBuild')
    case 'building':
      return t('cloud.nw.block.building')
    case 'build-failed':
      return t('cloud.nw.block.buildFailed')
    case 'limit':
      return ''
  }
}

export function RunsOnField({
  repo,
  readiness,
  value,
  onChange,
  onLeave
}: {
  repo: Repo
  readiness: CloudReadiness & { view?: CloudProviderView }
  value: RunsOnLocation
  onChange: (next: RunsOnLocation) => void
  onLeave: () => void
}) {
  const t = useT()
  const settings = useStore((s) => s.snapshot!.settings)
  const steps = useStore((s) => s.snapshot!.repoSettings[repo.id]?.values.setupSteps.length ?? 0)
  const [sleeping, setSleeping] = useState<string | null>(null)
  const { block, provider: id, connection } = readiness
  const provider = providerLabel(id)
  const blocked = blocksChoice(block)
  const { limits, capabilities } = providerFacts(id, readiness.view)
  const own = repoCloud(repo)
  const vcpus = providerVcpus(own.vcpus, capabilities, limits)
  const region = providerRegion(own.region, capabilities, id)
  const cap = sessionCap(limits)
  const leaveTo = (to: 'cloud' | 'integrations', scrollTo?: string) => {
    onLeave()
    openSettingsPage(to === 'integrations' ? { section: 'integrations' } : { section: 'repo', repoId: repo.id, tab: 'cloud', scrollTo })
  }
  const cloud = value === 'cloud' && !blocked
  const claude = cloudSettings(settings).claudeAuth === 'setup-token' ? t('cloud.nw.claudeToken') : t('cloud.nw.claudeKey')
  const where = [provider, connection?.identity?.org ?? connection?.name, region].filter(Boolean).join(' · ')
  return (
    <div className="field nw-cloud">
      <span>{t('cloud.nw.runsOn')}</span>
      <div>
        <Segmented
          plain
          label={t('cloud.nw.runsOn')}
          value={cloud ? 'cloud' : 'local'}
          onChange={onChange}
          options={[
            { value: 'local', label: t('cloud.nw.local') },
            {
              value: 'cloud',
              label: (
                <>
                  {t('cloud.nw.cloud')}
                  {block === 'limit' && (
                    <Tag tone="outline" className="nw-runs-tag">
                      {t('cloud.nw.inUse', { running: readiness.running.length, limit: readiness.cap })}
                    </Tag>
                  )}
                </>
              ),
              disabled: blocked,
              title: block && blocked ? blockText(t, block, provider) : undefined
            }
          ]}
        />
      </div>

      {/* Why Remote can't be picked, and where to fix it. */}
      {blocked && block && (
        <small className="nw-hint">
          {blockText(t, block, provider)}{' '}
          {block === 'connection' || block === 'connection-problem' ? (
            <LinkButton size="sm" onClick={() => leaveTo('integrations')}>
              {t('cloud.nw.openIntegrations')}
            </LinkButton>
          ) : (
            <LinkButton size="sm" onClick={() => leaveTo('cloud', block === 'soon' ? 'repo-cloud-provider' : 'repo-cloud-build')}>
              {t('cloud.nw.openSettings')}
            </LinkButton>
          )}
        </small>
      )}

      {/* At the limit: refused, with the running sandboxes to put to sleep. */}
      {value === 'cloud' && block === 'limit' && (
        <Callout
          tone="error"
          role="alert"
          actions={readiness.running.slice(0, 4).map((ws) => (
            <Button
              key={ws.id}
              size="sm"
              disabled={sleeping !== null || ws.cloud?.status !== 'running'}
              onClick={() => {
                setSleeping(ws.id)
                void cloudAction('sleep', ws, t).finally(() => setSleeping(null))
              }}
            >
              {t('cloud.action.sleepName', { name: ws.name })}
            </Button>
          ))}
        >
          {readiness.capScope === 'repo' ? t('cloud.nw.limitRepo', { limit: readiness.cap }) : t('cloud.nw.limitApp', { limit: readiness.cap })}
        </Callout>
      )}

      {cloud && block !== 'limit' && (
        <>
          <dl className="nw-cloud-facts">
            <dt>{t('cloud.nw.sandbox')}</dt>
            <dd>{where}</dd>
            <dt>{t('cloud.nw.size')}</dt>
            <dd>
              {id === 'vercel' ? t('cloud.size', { vcpus, gb: memoryGb(vcpus) }) : t('cloud.sizeVcpus', { vcpus })}
              <LinkButton size="sm" onClick={() => leaveTo('cloud', 'repo-cloud-size')}>
                {t('cloud.nw.change')}
              </LinkButton>
            </dd>
            <dt>{t('cloud.nw.startsFrom')}</dt>
            <dd>{capabilities.base ? t('cloud.nw.startsFromValue', { ago: timeAgo(own.build?.finishedAt ?? own.build?.startedAt) }) : t('cloud.nw.startsFromClone')}</dd>
            <dt>{t('cloud.nw.sleeps')}</dt>
            <dd>{t('cloud.nw.sleepsValue', { minutes: own.idleMinutes })}</dd>
            <dt>{t('cloud.nw.signIn')}</dt>
            <dd>{[claude, t('cloud.nw.codexKey')].join(' · ')}</dd>
          </dl>
          {/* The one honest caveat, only where sessions end by themselves in under 2 hours. */}
          {shortSessionsFor(capabilities, limits) && cap.minutes !== undefined && (
            <Callout tone="warn">{t('cloud.nw.shortSession', { provider, minutes: cap.minutes })}</Callout>
          )}
          {steps > 0 && <small className="nw-hint">{t('cloud.nw.setupSteps', { count: steps })}</small>}
        </>
      )}
    </div>
  )
}
