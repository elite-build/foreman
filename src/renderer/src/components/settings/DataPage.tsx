import { FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DataInfo } from '../../../../shared/types'
import type { DevicesInfo } from '../../../../shared/transfer'
import { mirrorSummary } from '../../../../shared/claudeMirror'
import { formatDate, formatDateTime, formatNumber, timeAgo } from '../../../../shared/i18n/time'
import { useT, type RendererT } from '../../i18n'
import { api, attempt, openPairDialog, showToast, useStore } from '../../store'
import { Button, LinkButton, Spinner, TextInput } from '../../ui'
import { Page, resetSettings, Row, saveSettings, Section, TextRow, ToggleRow, useSettings } from './controls'
import { GitBackupSection } from './GitBackupSection'

const mb = (bytes: number, t: RendererT) =>
  bytes >= 1024 * 1024
    ? t('transfer.size.mb', { size: (bytes / 1024 / 1024).toLocaleString(t.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
    : t('transfer.size.kb', { size: formatNumber(Math.max(1, Math.round(bytes / 1024)), t.locale) })

export function DataPage() {
  const t = useT()
  const settings = useSettings()
  const [info, setInfo] = useState<DataInfo | null>(null)
  const [backing, setBacking] = useState(false)
  const refresh = () => void api.dataInfo().then(setInfo, () => undefined)
  useEffect(refresh, [])

  const backUp = async () => {
    setBacking(true)
    const result = await attempt(() => api.backupNow())
    setBacking(false)
    if (!result) return
    showToast(result.missingAttachments ? t('settings.data.backedUpMissing', { path: result.path, count: result.missingAttachments }) : t('settings.data.backedUp', { path: result.path }))
    refresh()
  }
  const deleteLegacy = async () => {
    if (!window.confirm(t('settings.data.legacy.confirm'))) return
    await attempt(() => api.deleteLegacyFiles())
    refresh()
  }
  const chooseFolder = async () => {
    const dir = await attempt(() => api.pickPath({ kind: 'directory', title: t('settings.data.chooseFolder'), defaultPath: info?.backupFolder }))
    if (dir) void saveSettings({ backupFolder: dir }).then(refresh)
  }

  const m = info?.migration
  return (
    <Page title={t('settings.page.data')} description={t('settings.data.desc')}>
      <Section title={t('settings.advanced.section.storage')}>
        <Row
          id="database"
          label="foreman.db"
          help={info ? t('settings.data.db.help', { count: info.messages, size: mb(info.sizeBytes, t), messages: formatNumber(info.messages, t.locale) }) : t('settings.usage.reading')}
          detail={info && <code>{info.path}</code>}
        >
          <span className="set-granted">{m ? (m.status === 'migrated' ? t('settings.data.db.migrated') : t('settings.data.db.new')) : ''}</span>
          {info && (
            <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void attempt(() => api.openPath(info.dataFolder))}>
              {t('settings.data.showInFolder')}
            </Button>
          )}
        </Row>
        {info && (
          <Row
            id="claude-transcripts"
            label={t('settings.data.transcripts')}
            help={mirrorSummary(info.claudeTranscripts, t)}
            detail={t('settings.data.transcripts.detail')}
          />
        )}
        {m?.status === 'migrated' && (
          <Row
            label={t('settings.data.migration')}
            help={t('settings.data.migration.imported', {
              workspaces: t('settings.data.migration.workspaces', { count: m.counts.workspaces }),
              chats: t('settings.data.migration.chats', { count: m.counts.sessions }),
              items: t('settings.data.migration.items', { count: m.counts.items, items: formatNumber(m.counts.items, t.locale) }),
              date: formatDate(m.at, t.locale)
            })}
            detail={
              m.malformed || m.warnings.length ? (
                <>
                  {m.malformed > 0 && <div>{t('settings.data.migration.malformed', { count: m.malformed, list: m.malformedSample.map((r) => `${r.file}${r.line ? `:${r.line}` : ''} (${r.reason})`).join(', ') + (m.malformed > m.malformedSample.length ? ', …' : '') })}</div>}
                  {m.warnings.map((w) => (
                    <div key={w}>{w}</div>
                  ))}
                </>
              ) : undefined
            }
          />
        )}
        {info && info.legacy.files > 0 && (
          <Row label={t('settings.data.legacy')} help={`${t('settings.data.legacy.help', { count: info.legacy.files - 1, size: mb(info.legacy.bytes, t) })} ${t('settings.data.legacy.unused')}`}>
            <Button size="sm" onClick={() => void deleteLegacy()}>
              {t('settings.data.legacy.delete')}
            </Button>
          </Row>
        )}
        <ToggleRow
          id="keep-cleared-history"
          label={t('settings.data.keepCleared')}
          help={t('settings.data.keepCleared.help')}
          detail={settings.keepClearedHistory ? undefined : t('settings.data.keepCleared.detail')}
          checked={settings.keepClearedHistory}
          onChange={(keepClearedHistory) => void saveSettings({ keepClearedHistory })}
          onReset={settings.keepClearedHistory ? () => void resetSettings(['keepClearedHistory']) : undefined}
        />
      </Section>

      <Section title={t('settings.data.backups')}>
        <ToggleRow
          id="daily-backup"
          label={t('settings.data.dailyBackup')}
          help={t('settings.data.dailyBackup.help')}
          detail={t('settings.data.dailyBackup.detail')}
          checked={settings.dailyBackup}
          onChange={(dailyBackup) => void saveSettings({ dailyBackup })}
          onReset={settings.dailyBackup ? () => void resetSettings(['dailyBackup']) : undefined}
        />
        <TextRow
          id="backup-folder"
          label={t('settings.data.backupFolder')}
          help={info?.lastBackup ? t('settings.data.lastBackup', { date: formatDateTime(info.lastBackup.at, t.locale) }) : t('settings.data.noBackup')}
          mono
          wide
          placeholder={info?.backupFolder}
          value={settings.backupFolder}
          onCommit={(value) => void saveSettings({ backupFolder: value.trim() }).then(refresh)}
          after={
            <>
              <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void chooseFolder()}>
                {t('settings.openIn.choose')}
              </Button>
              <Button size="sm" disabled={backing} icon={backing ? <Spinner size={13} /> : undefined} onClick={() => void backUp()}>
                {t('settings.data.backUpNow')}
              </Button>
            </>
          }
        />
      </Section>

      <GitBackupSection />

      <DevicesSection />

      <p className="set-help" style={{ marginTop: 12 }}>
        {t('settings.data.syncWarning')}
      </p>
    </Page>
  )
}

/** Paired Macs: who this Mac can hand work to, and whether it listens for hand-offs itself. */
function DevicesSection() {
  const t = useT()
  const [info, setInfo] = useState<DevicesInfo | null>(null)
  const [online, setOnline] = useState<Record<string, boolean | 'checking'>>({})
  const [port, setPort] = useState('')
  // The paired list changes with snapshots (pairing finishes in the main process).
  const paired = useStore((s) => s.snapshot!.pairedDevices)
  const refresh = () => void api.devicesInfo().then((i) => (setInfo(i), setPort(String(i.port))), () => undefined)
  useEffect(refresh, [paired])
  const check = async (id: string) => {
    setOnline((o) => ({ ...o, [id]: 'checking' }))
    const up = await api.pingDevice(id).catch(() => false)
    setOnline((o) => ({ ...o, [id]: up }))
    refresh()
  }
  return (
    <Section
      title={t('settings.data.devices')}
      description={t('settings.data.devices.desc')}
    >
      <ToggleRow
        id="accept-hand-offs"
        label={t('settings.data.devices.accept')}
        help={info ? (info.accepting ? `${t('settings.data.devices.listening', { port: info.port })} ${t('settings.data.devices.reachAt', { addresses: info.addresses.map((a) => `${a}:${info.port}`).join(t('settings.data.devices.or')) || t('pairDialog.show.port', { port: info.port }) })}` : t('settings.data.devices.off')) : t('settings.usage.reading')}
        detail={t('settings.data.devices.acceptDetail')}
        checked={Boolean(info?.accepting)}
        onChange={(on) => void attempt(() => api.setAcceptHandOffs(on, Number(port) || undefined)).then((i) => i && setInfo(i))}
      />
      <Row id="device-port" label={t('settings.data.devices.port')} help={t('settings.data.devices.portHelp')}>
        {(control) => (
          <TextInput
            {...control}
            width={90}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            onBlur={() => info && Number(port) !== info.port && void attempt(() => api.setAcceptHandOffs(info.accepting, Number(port))).then((i) => i && setInfo(i))}
          />
        )}
      </Row>
      {info?.paired.map((d) => (
        <Row
          key={d.id}
          label={
            <>
              {d.name} <span className="faint small">{t('settings.data.devices.paired')}</span>
            </>
          }
          help={[
            online[d.id] === true ? t('settings.data.devices.online') : online[d.id] === false ? t('settings.data.devices.unreachable') : '',
            d.lastSeen ? t('settings.data.devices.lastSeen', { when: timeAgo(d.lastSeen, t.locale) }) : t('settings.data.devices.neverSeen'),
            d.host ? `${d.host}${d.port ? `:${d.port}` : ''}` : ''
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          <LinkButton disabled={online[d.id] === 'checking'} onClick={() => void check(d.id)}>
            {online[d.id] === 'checking' ? t('gitlab.accounts.checking') : t('settings.data.devices.check')}
          </LinkButton>
          <LinkButton onClick={() => window.confirm(t('settings.data.devices.unpairConfirm', { name: d.name })) && void attempt(() => api.unpairDevice(d.id)).then(refresh)}>
            {t('settings.data.devices.unpair')}
          </LinkButton>
        </Row>
      ))}
      <Row id="pair-mac" label={t('pairDialog.show.title')} help={t('settings.data.devices.pairHelp')}>
        <Button size="sm" onClick={() => openPairDialog('show')}>
          {t('pairDialog.enter.showCode')}
        </Button>
        <Button size="sm" onClick={() => openPairDialog('enter')}>
          {t('pairDialog.enter.title')}
        </Button>
      </Row>
    </Section>
  )
}
