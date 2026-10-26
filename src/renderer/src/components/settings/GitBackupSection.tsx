import { FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { GitBackupPreview, GitBackupRestoreChoice, GitBackupRestoreResult, GitBackupStatus } from '../../../../shared/gitBackup'
import { formatDateTime } from '../../../../shared/i18n/time'
import { useT } from '../../i18n'
import { api, attempt, showToast } from '../../store'
import { Button, Checkbox, Field, Segmented, Select, Spinner, Switch, TextInput } from '../../ui'
import { AgentDialog } from './AgentDialog'
import { useGithubAccounts } from './GithubAccount'
import { Row, Section } from './controls'

const CATEGORY_LABEL = {
  settings: 'settings.gitBackup.category.settings',
  templates: 'settings.gitBackup.category.templates',
  repositories: 'settings.gitBackup.category.repositories',
  workspaces: 'settings.gitBackup.category.workspaces'
} as const

const TEMPLATE_ACTION = { add: 'settings.gitBackup.action.add', update: 'settings.gitBackup.action.update', same: 'settings.gitBackup.action.same' } as const

export function GitBackupSection() {
  const t = useT()
  const [status, setStatus] = useState<GitBackupStatus>({})
  const [remote, setRemote] = useState('')
  const [name, setName] = useState('foreman-settings-backup')
  const [account, setAccount] = useState('')
  const [mode, setMode] = useState<'existing' | 'create'>('existing')
  const [busy, setBusy] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const accounts = useGithubAccounts()
  const refresh = () => void api.gitBackupStatus().then((next) => {
    setStatus(next)
    setRemote((old) => old || next.config?.remoteUrl || '')
    setAccount((old) => old || next.config?.account || '')
  }, () => undefined)
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 10_000)
    return () => clearInterval(timer)
  }, [])

  const connect = async () => {
    setBusy(true)
    const next = mode === 'create'
      ? await attempt(() => api.createGitBackupGithubRepo(name, account || undefined))
      : await attempt(() => api.configureGitBackup({ remoteUrl: remote, account: account || undefined, daily: status.config?.daily ?? false }))
    setBusy(false)
    if (next) {
      setStatus(next)
      setRemote(next.config?.remoteUrl ?? remote)
      showToast(t('settings.gitBackup.connected'))
    }
  }
  const backUp = async () => {
    setBusy(true)
    const result = await attempt(() => api.gitBackupNow())
    setBusy(false)
    refresh()
    if (result) showToast(result.changed ? t('settings.gitBackup.backedUp') : t('settings.gitBackup.upToDate'))
  }
  const setDaily = async (daily: boolean) => {
    const config = status.config
    if (!config) return
    const next = await attempt(() => api.configureGitBackup({ ...config, daily }))
    if (next) setStatus(next)
  }

  return (
    <Section title={t('settings.gitBackup.title')} description={t('settings.gitBackup.desc')}>
      <Row id="git-backup-destination" label={t('settings.gitBackup.destination')} help={status.config?.remoteUrl || t('settings.gitBackup.destinationHelp')} stacked>
        <div className="git-backup-controls">
          <Segmented
            small
            className="git-backup-choice"
            label={t('settings.gitBackup.destination')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'existing', label: t('settings.gitBackup.existingRemote') },
              { value: 'create', label: t('settings.gitBackup.newRepo') }
            ]}
          />
          <TextInput
            mono
            className="git-backup-input"
            aria-label={mode === 'existing' ? t('settings.gitBackup.remoteUrl') : t('settings.gitBackup.repoName')}
            placeholder={mode === 'existing' ? 'https://github.com/you/backup.git' : 'foreman-settings-backup'}
            value={mode === 'existing' ? remote : name}
            onChange={(e) => (mode === 'existing' ? setRemote(e.target.value) : setName(e.target.value))}
          />
          {accounts && accounts.length > 0 && (
            <Field className="git-backup-account" label={t('settings.gitBackup.account')}>
              {(control) => (
                <Select
                  {...control}
                  value={account}
                  onChange={setAccount}
                  options={[{ value: '', label: t('settings.gitBackup.activeAccount') }, ...accounts.map((a) => ({ value: a.login, label: a.active ? t('settings.gitBackup.accountActive', { login: a.login }) : a.login }))]}
                />
              )}
            </Field>
          )}
          <Button size="sm" disabled={busy || !(mode === 'existing' ? remote.trim() : name.trim())} icon={busy ? <Spinner size={13} /> : undefined} onClick={() => void connect()}>
            {mode === 'existing' ? t('settings.gitBackup.connect') : t('settings.gitBackup.createRepo')}
          </Button>
        </div>
      </Row>
      <Row id="daily-git-backup" label={t('settings.gitBackup.daily')} help={t('settings.gitBackup.dailyHelp')}>
        <Switch checked={status.config?.daily ?? false} disabled={!status.config || busy} onChange={(value) => void setDaily(value)} label={t('settings.gitBackup.daily')} />
      </Row>
      <Row label={t('settings.gitBackup.backupRestore')} help={status.lastSuccessAt ? t('settings.gitBackup.lastSuccess', { date: formatDateTime(status.lastSuccessAt, t.locale) }) : t('settings.gitBackup.noSuccess')}
        detail={status.lastError && <span className="git-backup-error" role="alert">{status.lastError}</span>}>
        <Button size="sm" disabled={!status.config || busy} icon={busy ? <Spinner size={13} /> : undefined} onClick={() => void backUp()}>
          {t('settings.data.backUpNow')}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => setRestoreOpen(true)}>
          {t('settings.gitBackup.restoreFromGit')}
        </Button>
      </Row>
      <p className="set-help git-backup-warning">{t('settings.gitBackup.warning')}</p>
      {restoreOpen && <RestoreDialog initialRemote={status.config?.remoteUrl || remote} initialAccount={status.config?.account || account} onClose={() => setRestoreOpen(false)} />}
    </Section>
  )
}

function RestoreDialog({ initialRemote, initialAccount, onClose }: { initialRemote: string; initialAccount: string; onClose: () => void }) {
  const t = useT()
  const [remote, setRemote] = useState(initialRemote)
  const [account, setAccount] = useState(initialAccount)
  const [preview, setPreview] = useState<GitBackupPreview | null>(null)
  const [choice, setChoice] = useState<GitBackupRestoreChoice | null>(null)
  const [result, setResult] = useState<GitBackupRestoreResult | null>(null)
  const [busy, setBusy] = useState(false)
  const accounts = useGithubAccounts()
  const inspect = async () => {
    setBusy(true)
    const next = await attempt(() => api.previewGitBackup(remote, account || undefined))
    setBusy(false)
    if (!next) return
    setPreview(next)
    setResult(null)
    setChoice({
      stageId: next.stageId,
      categories: { settings: true, templates: true, repositories: true, workspaces: true },
      repositoryPaths: Object.fromEntries(next.repositories.map((r) => [r.id, r.suggestedPath || ''])),
      workspacePaths: Object.fromEntries(next.workspaces.map((w) => [w.id, w.suggestedPath || '']))
    })
  }
  const restore = async () => {
    if (!choice) return
    setBusy(true)
    const next = await attempt(() => api.restoreGitBackup(choice))
    setBusy(false)
    if (next) {
      setResult(next)
      showToast(t('settings.gitBackup.restoreFinished'))
    }
  }
  const pick = async (kind: 'repositoryPaths' | 'workspacePaths', id: string) => {
    const folder = await api.pickPath({ kind: 'directory', title: kind === 'repositoryPaths' ? t('settings.gitBackup.pickRepo') : t('settings.gitBackup.pickWorktree') })
    if (folder) setChoice((old) => old ? { ...old, [kind]: { ...old[kind], [id]: folder } } : old)
  }
  const field = (kind: 'repositoryPaths' | 'workspacePaths', id: string, label: string) => (
    <div className="git-backup-path" key={id}>
      <Field className="git-backup-field" label={label}>
        {(control) => (
          <TextInput
            {...control}
            mono
            value={choice?.[kind][id] ?? ''}
            placeholder={t('settings.gitBackup.pathPlaceholder')}
            onChange={(e) => setChoice((old) => old ? { ...old, [kind]: { ...old[kind], [id]: e.target.value } } : old)}
          />
        )}
      </Field>
      <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void pick(kind, id)}>
        {t('settings.gitBackup.browse')}
      </Button>
    </div>
  )
  return (
    <AgentDialog
      title={t('settings.gitBackup.restoreTitle')}
      onClose={onClose}
      description={t('settings.gitBackup.restoreDesc')}
      footer={
        <>
          <Button size="sm" onClick={onClose}>
            {result ? t('common.done') : t('common.cancel')}
          </Button>
          {choice && !result && (
            <Button size="sm" variant="primary" disabled={busy || !Object.values(choice.categories).some(Boolean)} icon={busy ? <Spinner size={13} /> : undefined} onClick={() => void restore()}>
              {t('settings.gitBackup.restoreSelected')}
            </Button>
          )}
        </>
      }
    >
      {!preview && (
        <div className="git-backup-restore-source">
          <Field label={t('settings.gitBackup.remoteUrl')}>
            {(control) => <TextInput {...control} mono className="git-backup-input" value={remote} onChange={(e) => setRemote(e.target.value)} placeholder="https://github.com/you/backup.git" />}
          </Field>
          {accounts && accounts.length > 0 && (
            <Field label={t('settings.gitBackup.account')}>
              {(control) => (
                <Select {...control} value={account} onChange={setAccount} options={[{ value: '', label: t('settings.gitBackup.activeAccount') }, ...accounts.map((a) => ({ value: a.login, label: a.login }))]} />
              )}
            </Field>
          )}
          <Button size="sm" disabled={busy || !remote.trim()} icon={busy ? <Spinner size={13} /> : undefined} onClick={() => void inspect()}>
            {t('settings.gitBackup.preview')}
          </Button>
        </div>
      )}
      {preview && choice && !result && <div className="git-backup-preview">
        <p>{t('settings.gitBackup.backupFrom', { date: formatDateTime(preview.createdAt, t.locale) })}</p>
        <div className="git-backup-categories">
          {(['settings', 'templates', 'repositories', 'workspaces'] as const).map((key) => (
            <Checkbox key={key} checked={choice.categories[key]} onChange={(e) => setChoice({ ...choice, categories: { ...choice.categories, [key]: e.target.checked } })}>
              {t(CATEGORY_LABEL[key], { count: key === 'settings' ? preview.settingsChanged.length : key === 'templates' ? preview.templates.length : preview[key].length })}
            </Checkbox>
          ))}
        </div>
        {choice.categories.settings && <><p className="faint small">{t('settings.gitBackup.changedSettings', { list: preview.settingsChanged.join(', ') || t('settings.gitBackup.none') })}</p>
          {preview.machinePaths.map((p, i) => <p className="faint small" key={`${p.key}:${i}`}>{p.key}: <code>{p.saved}</code> {p.available ? t('settings.gitBackup.pathAvailable') : t('settings.gitBackup.pathUnavailable')}</p>)}</>}
        {choice.categories.templates && <p className="faint small">{t('settings.gitBackup.templates', { list: preview.templates.map((tpl) => `${tpl.name} (${t(TEMPLATE_ACTION[tpl.action])})`).join(', ') || t('settings.gitBackup.none') })}</p>}
        {preview.unavailableAccounts.length > 0 && <p className="git-backup-error">{t('settings.gitBackup.unavailableAccounts', { accounts: preview.unavailableAccounts.join(', ') })}</p>}
        {choice.categories.repositories && <><h3>{t('settings.nav.repositories')}</h3>{preview.repositories.map((r) => field('repositoryPaths', r.id, `${r.name}${r.matchedRepoId ? ` · ${t('settings.gitBackup.alreadyAdded')}` : ''}`))}</>}
        {choice.categories.workspaces && <><h3>{t('palette.group.workspaces')}</h3>{preview.workspaces.map((w) => field('workspacePaths', w.id, `${w.name} · ${w.branch}${w.alreadyAdded ? ` · ${t('settings.gitBackup.alreadyAdded')}` : ''}`))}</>}
        <div className="faint small">{t('settings.gitBackup.variablesToCheck')}
          {preview.variableChecklist.length ? <ul>{preview.variableChecklist.map((v, i) => <li key={`${v.scope}:${v.name}:${i}`}>{v.present ? '✓' : '○'} {v.scope}: <code>{v.name}</code> {v.present ? t('settings.gitBackup.variableSet') : t('settings.gitBackup.variableMissing')}</li>)}</ul> : ` ${t('settings.gitBackup.none')}`}
        </div>
      </div>}
      {result && <div className="git-backup-result"><p>{t('settings.gitBackup.restored', {
        settings: t('settings.gitBackup.restored.settings', { count: result.settings }),
        templates: t('settings.gitBackup.restored.templates', { count: result.templates }),
        repositories: t('settings.gitBackup.restored.repositories', { count: result.repositories }),
        workspaces: t('settings.gitBackup.restored.workspaces', { count: result.workspaces })
      })}</p>{result.skipped.length > 0 && <><h3>{t('settings.gitBackup.skipped')}</h3><ul>{result.skipped.map((s, i) => <li key={i}>{s}</li>)}</ul></>}</div>}
    </AgentDialog>
  )
}
