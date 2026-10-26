// Repository → Misc: icon, paths, preview URLs, files to copy, removal.
import { ArrowDown, ArrowUp, FolderOpen, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { PreviewUrl, Repo } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, attempt, openSettingsPage, showToast, useStore } from '../../store'
import { Button, Glyph, IconButton, Spinner, TextArea, TextInput } from '../../ui'
import { Row, Section, useDraft, useRepoSetting } from './controls'
import { Dialog } from './RepoDialog'
import { RepoIconPicker } from './RepoIcon'

/** The repo's folder under the workspaces root; matches safeDirName in the main process. */
export function workspacesFolder(root: string, repoName: string, platform: string): string {
  const sep = platform === 'win32' ? '\\' : '/'
  const safe = repoName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '') || 'workspace'
  return `${root.replace(/[\\/]+$/, '')}${sep}${safe}`
}

export function MiscTab({ repo }: { repo: Repo }) {
  const t = useT()
  const workspacesRoot = useStore((s) => s.snapshot!.settings.workspacesRoot)
  const platform = useStore((s) => s.snapshot!.platform)
  return (
    <>
      <Section>
        <Row id="repo-icon" label={t('repoSettings.icon.label')} help={t('repoSettings.icon.help')}>
          <RepoIconPicker repo={repo} />
        </Row>
        <PathRow
          id="root-path"
          label={t('repoSettings.rootPath.label')}
          openLabel={t('repoSettings.rootPath.open')}
          path={repo.rootPath}
          warning={t('repoSettings.rootPath.warning')}
        />
        <PathRow
          id="workspaces-path"
          label={t('repoSettings.workspacesPath.label')}
          openLabel={t('repoSettings.workspacesPath.open')}
          path={workspacesFolder(workspacesRoot, repo.name, platform)}
          warning={t('repoSettings.workspacesPath.warning')}
        />
      </Section>
      <Section>
        <PreviewUrlsRow repoId={repo.id} />
        <FilesToCopyRow repo={repo} />
      </Section>
      <Section>
        <RemoveRepoRow repo={repo} />
      </Section>
    </>
  )
}

function PathRow({ id, label, openLabel, path, warning }: { id: string; label: string; openLabel: string; path: string; warning: string }) {
  const t = useT()
  return (
    <Row
      id={id}
      label={label}
      stacked
      detail={
        <span className="repo-warning">
          <Glyph name="warn" /> {warning}
        </span>
      }
    >
      <div className="repo-path">
        <span className="mono repo-path-text" title={path}>
          {path}
        </span>
        <IconButton label={openLabel} onClick={() => void attempt(() => api.openPath(path))}>
          <FolderOpen size={14} />
        </IconButton>
      </div>
    </Row>
  )
}

// ---- preview URLs ----

const sameUrls = (a: PreviewUrl[], b: PreviewUrl[]) => JSON.stringify(a) === JSON.stringify(b)

function PreviewUrlsRow({ repoId }: { repoId: string }) {
  const t = useT()
  const s = useRepoSetting(repoId, 'previewUrls')
  const [rows, setRows] = useState<PreviewUrl[]>(s.value)
  const [focusLast, setFocusLast] = useState(false)
  const editing = useRef(false)
  const latest = useRef({ rows, s })
  latest.current = { rows, s }

  // Pick up outside changes unless an input is being edited.
  const saved = JSON.stringify(s.value)
  useEffect(() => {
    if (!editing.current) setRows(JSON.parse(saved) as PreviewUrl[])
  }, [saved])

  const commit = (next: PreviewUrl[]) => {
    const { s: setting } = latest.current
    const clean = next.map((r) => ({ name: r.name.trim(), url: r.url.trim() })).filter((r) => r.url)
    if (sameUrls(clean, setting.value)) return
    if (!clean.length) {
      if (setting.source === 'local') void setting.reset()
      return
    }
    void setting.set(clean)
  }

  // Save edits that are still in progress when the page closes.
  useEffect(() => () => commit(latest.current.rows), [])

  const update = (index: number, patch: Partial<PreviewUrl>) => setRows(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  const apply = (next: PreviewUrl[]) => {
    setRows(next)
    commit(next)
  }
  const move = (index: number, by: number) => {
    const next = rows.slice()
    const [row] = next.splice(index, 1)
    next.splice(index + by, 0, row)
    apply(next)
  }
  const field = {
    onFocus: () => {
      editing.current = true
    },
    onBlur: () => {
      editing.current = false
      commit(latest.current.rows)
    },
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && e.currentTarget.blur()
  }

  return (
    <Row
      id="preview-urls"
      label={t('repoSettings.previewUrls.label')}
      stacked
      help={t.rich('repoSettings.previewUrls.help', { port: <code key="port">$FOREMAN_PORT</code>, next: <code key="next">$((FOREMAN_PORT + 1))</code> })}
      source={s.sourceInfo}
      onReset={s.source === 'local' ? () => void s.reset() : undefined}
    >
      <div className="repo-urls">
        {rows.map((row, i) => (
          <div key={i} className="repo-url-row">
            <TextInput
              className="repo-url-name"
              placeholder={t('repoSettings.field.name')}
              aria-label={t('repoSettings.previewUrls.nameLabel', { n: i + 1 })}
              spellCheck={false}
              autoFocus={focusLast && i === rows.length - 1}
              value={row.name}
              onChange={(e) => update(i, { name: e.target.value })}
              {...field}
            />
            <TextInput
              className="repo-url-url"
              mono
              placeholder="http://localhost:$FOREMAN_PORT"
              aria-label={t('repoSettings.previewUrls.urlLabel', { n: i + 1 })}
              spellCheck={false}
              value={row.url}
              onChange={(e) => update(i, { url: e.target.value })}
              {...field}
            />
            {rows.length > 1 && (
              <>
                <IconButton label={t('setupSteps.moveUp')} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={13} />
                </IconButton>
                <IconButton label={t('setupSteps.moveDown')} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown size={13} />
                </IconButton>
              </>
            )}
            <IconButton label={t('repoSettings.previewUrls.remove')} onClick={() => apply(rows.filter((_, j) => j !== i))}>
              <Trash2 size={13} />
            </IconButton>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            icon={<Plus size={13} />}
            onClick={() => {
              setFocusLast(true)
              setRows([...rows, { name: '', url: '' }])
            }}
          >
            {t('repoSettings.previewUrls.add')}
          </Button>
        </div>
      </div>
    </Row>
  )
}

// ---- files to copy ----

const toPatterns = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

type CopyPreview = { status: 'loading' } | { status: 'error' } | { status: 'ready'; files: string[] }

const PREVIEW_LIMIT = 100

function FilesToCopyRow({ repo }: { repo: Repo }) {
  const t = useT()
  const s = useRepoSetting(repo.id, 'filesToCopy')
  const text = s.value.join('\n')
  const draft = useDraft(text, (next) => {
    const patterns = toPatterns(next)
    if (patterns.join('\n') === text) return false
    void s.set(patterns)
  })
  const [preview, setPreview] = useState<CopyPreview>({ status: 'loading' })
  const [fromInclude, setFromInclude] = useState(false)
  // The patterns from .worktreeinclude, shown read-only when that file is in use.
  const [includeText, setIncludeText] = useState('')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let live = true
    setPreview({ status: 'loading' })
    const timer = setTimeout(() => {
      api
        .previewFilesToCopy(repo.id, toPatterns(draft.value))
        .then((result) => {
          if (!live) return
          setFromInclude(result.fromWorktreeInclude)
          setIncludeText(result.fromWorktreeInclude ? result.patterns.join('\n') : '')
          setPreview({ status: 'ready', files: result.files })
        })
        .catch(() => live && setPreview({ status: 'error' }))
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [repo.id, draft.value, refresh])

  return (
    <Row
      id="files-to-copy"
      label={t('repoSettings.filesToCopy.label')}
      stacked
      help={t('repoSettings.filesToCopy.help')}
      source={fromInclude ? undefined : s.sourceInfo}
      onReset={!fromInclude && s.source === 'local' ? () => void s.reset() : undefined}
      detail={
        fromInclude ? (
          <span className="repo-warning-text">{t('repoSettings.filesToCopy.fromInclude')}</span>
        ) : undefined
      }
    >
      {(control) => (
        <div className="repo-copy">
          <TextArea
            {...control}
            className="repo-script"
            mono
            rows={Math.min(12, Math.max(3, draft.value.split('\n').length + 1))}
            spellCheck={false}
            readOnly={fromInclude}
            placeholder={'.env\n*.local\n!.keep.local'}
            {...draft}
            value={fromInclude ? includeText : draft.value}
          />
          <div className="repo-copy-preview" aria-live="polite">
            <div className="repo-copy-head">
              <span className="repo-copy-status">
                {preview.status === 'loading'
                  ? t('repoSettings.filesToCopy.finding')
                  : preview.status === 'error'
                    ? t('repoSettings.filesToCopy.failed')
                    : preview.files.length === 0
                      ? t('repoSettings.filesToCopy.none')
                      : t.rich('repoSettings.filesToCopy.count', {
                          count: preview.files.length,
                          path: (
                            <span key="path" className="mono">
                              {repo.rootPath}
                            </span>
                          )
                        })}
              </span>
              <IconButton label={t('repoSettings.filesToCopy.refresh')} disabled={preview.status === 'loading'} onClick={() => setRefresh((n) => n + 1)}>
                {preview.status === 'loading' ? <Spinner size={12} /> : <RefreshCw size={12} />}
              </IconButton>
            </div>
            {preview.status === 'ready' && preview.files.length > 0 && (
              <ul className="repo-copy-list">
                {preview.files.slice(0, PREVIEW_LIMIT).map((file) => (
                  <li key={file} className="mono">
                    {file}
                  </li>
                ))}
                {preview.files.length > PREVIEW_LIMIT && <li className="repo-copy-more">{t('repoSettings.filesToCopy.more', { count: preview.files.length - PREVIEW_LIMIT })}</li>}
              </ul>
            )}
          </div>
        </div>
      )}
    </Row>
  )
}

// ---- remove ----

function RemoveRepoRow({ repo }: { repo: Repo }) {
  const t = useT()
  const [confirming, setConfirming] = useState(false)
  return (
    <Row id="remove-repository" label={t('repoSettings.remove.label')} help={t('repoSettings.remove.help')}>
      <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => setConfirming(true)}>
        {t('repoSettings.remove.label')}
      </Button>
      {confirming && <RemoveRepoDialog repo={repo} onClose={() => setConfirming(false)} />}
    </Row>
  )
}

/** Confirms and removes a repository from Foreman (Settings and the repo rail's menu). */
export function RemoveRepoDialog({ repo, onClose }: { repo: Repo; onClose: () => void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const workspaces = useStore((s) => s.snapshot!.workspaces.filter((w) => w.repoId === repo.id && w.state !== 'archived').length)
  const settingsOnRepo = useStore((s) => s.settingsPage?.section === 'repo' && s.settingsPage.repoId === repo.id)

  const remove = async () => {
    setBusy(true)
    const removed = await attempt(async () => (await api.removeRepo(repo.id), true))
    setBusy(false)
    if (!removed) return
    onClose()
    if (settingsOnRepo) openSettingsPage({ section: 'general' })
    showToast(t('repoSettings.remove.toast', { name: repo.name }))
  }

  const what = workspaces
    ? t('repoSettings.remove.withWorkspaces', { count: workspaces })
    : t('repoSettings.remove.noWorkspaces')
  return (
    <Dialog
      title={t('repoSettings.remove.title', { name: repo.name })}
      onClose={() => !busy && onClose()}
      description={what}
      footer={
        <>
          <span className="spacer" />
          <Button disabled={busy} autoFocus onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void remove()}>
            {busy ? t('repoSettings.remove.busy') : t('common.remove')}
          </Button>
        </>
      }
    />
  )
}
