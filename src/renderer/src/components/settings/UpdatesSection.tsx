// Settings → General → Updates (main/updates.ts): the running version with Check now and what the last check found, then
// whether and how often Foreman checks, what it does with a new version, and the release channel. Where this copy can't
// install updates itself (shared/appUpdate.ts InstallUnavailable), the download choices say why and Tell me applies.
import { Download } from 'lucide-react'
import { useState } from 'react'
import { type UpdateCheckResult, type UpdateInterval, type UpdateMode } from '../../../../shared/appUpdate'
import { formatClock, formatDateTime } from '../../../../shared/i18n/time'
import type { PlainKey } from '../../../../shared/i18n'
import type { Settings } from '../../../../shared/types'
import { useT, type RendererT } from '../../i18n'
import { api, attempt, timeAgo, useStore } from '../../store'
import { Button, RadioList, Segmented, Status } from '../../ui'
import { resetSettings, Row, saveSettings, Section, ToggleRow, useSettings } from './controls'

const DEFAULTS = { checkForUpdates: true, updateInterval: 'every-4-hours', updateMode: 'download', updateChannel: 'stable' } satisfies Partial<Settings>

const UNAVAILABLE: Record<string, PlainKey> = {
  development: 'settings.general.updates.unavailable.development',
  unsigned: 'settings.general.updates.unavailable.unsigned',
  unsupported: 'settings.general.updates.unavailable.unsupported'
}

/** "14:06", or "Tue 14:06" when it isn't today. */
function when(iso: string, t: RendererT): string {
  const at = new Date(iso)
  return at.toDateString() === new Date().toDateString() ? formatClock(at, t.locale) : formatDateTime(at, t.locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

export function UpdatesSection() {
  const t = useT()
  const settings = useSettings()
  const view = useStore((s) => s.snapshot!.update)
  // Without the main process's view (tests), nothing is installed in place.
  const unavailable = view ? view.installUnavailable : 'unsupported'
  const reset = (key: keyof typeof DEFAULTS) => (settings[key] === DEFAULTS[key] ? undefined : () => void resetSettings([key]))
  const reason = unavailable ? t(UNAVAILABLE[unavailable]) : undefined

  return (
    <Section title={t('settings.general.section.updates')} description={t('settings.general.updates.desc')}>
      <UpdateStatusRow installable={!unavailable} />
      <ToggleRow
        id="check-for-updates"
        label={t('settings.general.checkForUpdates.label')}
        help={t('settings.general.checkForUpdates.help')}
        checked={settings.checkForUpdates}
        onChange={(checkForUpdates) => void saveSettings({ checkForUpdates })}
        onReset={reset('checkForUpdates')}
      />
      <Row label={t('settings.general.updates.interval.label')} disabled={!settings.checkForUpdates} onReset={reset('updateInterval')}>
        {(control) => (
          <Segmented<UpdateInterval>
            {...control}
            small
            label={t('settings.general.updates.interval.label')}
            value={settings.updateInterval}
            options={[
              { value: 'hourly', label: t('settings.general.updates.interval.hourly'), disabled: !settings.checkForUpdates },
              { value: 'every-4-hours', label: t('settings.general.updates.interval.every4'), disabled: !settings.checkForUpdates },
              { value: 'daily', label: t('settings.general.updates.interval.daily'), disabled: !settings.checkForUpdates }
            ]}
            onChange={(updateInterval) => void saveSettings({ updateInterval })}
          />
        )}
      </Row>
      <Row label={t('settings.general.updates.mode.label')} stacked onReset={reset('updateMode')}>
        <RadioList<UpdateMode>
          legend={t('settings.general.updates.mode.label')}
          hideLegend
          name="update-mode"
          // What applies: a copy that can't install updates only tells.
          value={unavailable ? 'notify' : settings.updateMode}
          onChange={(updateMode) => void saveSettings({ updateMode })}
          options={[
            { value: 'notify', label: t('settings.general.updates.mode.notify'), description: t('settings.general.updates.mode.notifyHelp') },
            { value: 'download', label: t('settings.general.updates.mode.download'), description: t('settings.general.updates.mode.downloadHelp'), disabled: Boolean(unavailable), reason },
            { value: 'quit', label: t('settings.general.updates.mode.quit'), description: t('settings.general.updates.mode.quitHelp'), disabled: Boolean(unavailable), reason }
          ]}
        />
      </Row>
      <Row label={t('settings.general.updates.channel.label')} help={t('settings.general.updates.channel.help')} onReset={reset('updateChannel')}>
        {(control) => (
          <Segmented<Settings['updateChannel']>
            {...control}
            small
            label={t('settings.general.updates.channel.label')}
            value={settings.updateChannel}
            options={[
              { value: 'stable', label: t('settings.general.updates.channel.stable') },
              { value: 'beta', label: t('settings.general.updates.channel.beta') }
            ]}
            onChange={(updateChannel) => void saveSettings({ updateChannel })}
          />
        )}
      </Row>
    </Section>
  )
}

/** The running version and Check now (which works with automatic checks on or off), when the last and next checks are, and what was found. */
function UpdateStatusRow({ installable }: { installable: boolean }) {
  const t = useT()
  const version = useStore((s) => s.snapshot!.appVersion)
  const view = useStore((s) => s.snapshot!.update)
  const [result, setResult] = useState<UpdateCheckResult | 'checking' | null>(null)
  const check = async () => {
    setResult('checking')
    setResult(await api.checkForUpdates().catch((): UpdateCheckResult => ({ state: 'failed', current: version ?? '' })))
  }
  const checking = result === 'checking' || Boolean(view?.checking)
  const found: { state: UpdateCheckResult['state']; version?: string; url?: string } | null =
    result && result !== 'checking'
      ? { state: result.state, ...(result.state === 'available' ? { version: result.update.version, url: result.update.url } : {}) }
      : view?.lastResult
        ? { state: view.lastResult, version: view.latest?.version, url: view.latest?.url }
        : null
  const times = [
    view?.lastChecked && t('settings.general.updates.lastChecked', { when: timeAgo(view.lastChecked) }),
    view?.nextCheck && t('settings.general.updates.nextCheck', { time: when(view.nextCheck, t) })
  ].filter(Boolean)
  // The card already offers a release that's downloading or downloaded.
  const offered = view?.notice && view.notice.phase.state !== 'available'
  return (
    <Row
      label={version ? t('settings.general.checkForUpdates.version', { version }) : t('settings.general.section.updates')}
      help={times.length ? times.join(' · ') : undefined}
      below={
        <div className="update-check" role="status">
          {!checking && found?.state === 'current' && <Status tone="ok" label={t('settings.general.checkForUpdates.upToDate')} />}
          {!checking && found?.state === 'failed' && <Status tone="error" label={t('settings.general.checkForUpdates.failed')} />}
          {!checking && found?.state === 'available' && found.version && <Status tone="info" label={t('update.available', { version: found.version })} />}
          {!checking && found?.state === 'available' && found.url && !offered && (
            <Button
              size="sm"
              variant="primary"
              icon={<Download size={12} />}
              title={installable ? t('update.downloadInAppTitle') : t('update.downloadTitle')}
              onClick={() => void attempt(() => (installable ? api.downloadUpdate() : api.openExternal(found.url!)))}
            >
              {t('update.download')}
            </Button>
          )}
        </div>
      }
    >
      <Button size="sm" disabled={checking} onClick={() => void check()}>
        {t(checking ? 'settings.general.checkForUpdates.checking' : 'settings.general.checkForUpdates.checkNow')}
      </Button>
    </Row>
  )
}
