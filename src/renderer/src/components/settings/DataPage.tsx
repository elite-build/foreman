import { FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DataInfo } from '../../../../shared/types'
import { mirrorSummary } from '../../../../shared/claudeMirror'
import { formatDate, formatDateTime, formatNumber } from '../../../../shared/i18n/time'
import { useT, type RendererT } from '../../i18n'
import { api, attempt, showToast } from '../../store'
import { Button, Callout, Spinner } from '../../ui'
import { Page, Part, resetSettings, Row, saveSettings, Section, TextRow, ToggleRow, useSettings } from './controls'
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
      <Section part="storage" title={t('settings.advanced.section.storage')}>
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
      {/* About foreman.db above it: a synced live database can corrupt it. */}
      <Part id="storage">
        <Callout tone="warn" className="set-after-card">
          {t('settings.data.syncWarning')}
        </Callout>
      </Part>

      <Section part="backups" title={t('settings.data.backups')}>
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

      <Part id="git-backup" lead>
        <GitBackupSection />
      </Part>
    </Page>
  )
}
