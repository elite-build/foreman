// Settings → Environment: variables passed to agents, scripts and terminals,
// for the user or one repository (where user values are inherited).
import { ChevronRight, FileText, FolderOpen, Lock, Pencil, Plus, Settings as Gear, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TFunction } from '../../../../shared/i18n'
import type { EnvFileInfo, EnvScope, EnvVarRow, EnvView } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, attempt, openSettingsPage, useStore } from '../../store'
import { Button, Disclosure, IconButton, LinkButton, Tag, TextInput } from '../../ui'
import { flashSaved, MaskedValue, Row, rowDomId, Section } from './controls'
import { AddVariableSheet, DOCUMENTED_ENV_VARS, documentedDescription, EditVariableSheet, fileName, ViewVariableSheet } from './EnvSheet'
import './environment.css'

type SheetState =
  | { kind: 'add'; key?: string; lockKey?: boolean }
  | { kind: 'edit'; row: EnvVarRow }
  | { kind: 'view'; row: EnvVarRow; layer: 'shared' | 'inherited' }

const DOC_ORDER = new Map(DOCUMENTED_ENV_VARS.map((d, i) => [d.key, i]))

/** Documented variables first (in catalog order), then the rest alphabetically; env-file rows last. */
function sortRows(rows: EnvVarRow[]): EnvVarRow[] {
  const rank = (r: EnvVarRow) => (r.origin === 'file' ? 1 : 0)
  return [...rows].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    const da = DOC_ORDER.get(a.key)
    const db = DOC_ORDER.get(b.key)
    if (da !== undefined || db !== undefined) return (da ?? Infinity) - (db ?? Infinity)
    return a.key.localeCompare(b.key)
  })
}

export function EnvironmentPage({ scope }: { scope: EnvScope }) {
  const t = useT()
  const repoId = scope.kind === 'repo' ? scope.repoId : null
  const isUser = repoId === null
  // The caller may pass a new object every render.
  const stableScope = useMemo<EnvScope>(() => (repoId ? { kind: 'repo', repoId } : { kind: 'user' }), [repoId])
  const platform = useStore((s) => s.snapshot!.platform)
  const [view, setView] = useState<EnvView | null>(null)
  const [failed, setFailed] = useState(false)
  const [sheet, setSheet] = useState<SheetState | null>(null)
  const [showDocumented, setShowDocumented] = useState(false)
  const request = useRef(0)

  const load = useCallback(async () => {
    const id = ++request.current
    try {
      const next = await api.envView(stableScope)
      if (id !== request.current) return
      setView(next)
      setFailed(false)
    } catch {
      if (id === request.current) setFailed(true)
    }
  }, [stableScope])

  useEffect(() => {
    void load()
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  const own = useMemo(() => sortRows(view?.vars ?? []), [view])
  const ownKeys = useMemo(() => new Set(own.map((r) => r.key)), [own])
  const unsetDocumented = DOCUMENTED_ENV_VARS.filter((d) => !ownKeys.has(d.key))

  const remove = async (key: string) => {
    const done = await attempt(async () => (await api.setEnvVars(stableScope, [{ key, value: null }]), true))
    if (!done) return
    flashSaved()
    void load()
  }

  // On the user page values from env files are read-only; a repository can override them.
  const editable = (row: EnvVarRow) => row.origin === 'saved' || (!isUser && row.origin === 'file')

  return (
    <div className="set-page env-page">
      <div className="env-head">
        <div className="env-head-text">
          <h1>{t('settings.page.environment')}</h1>
          <p className="set-page-desc">
            {isUser
              ? t('settings.env.desc.user')
              : t('settings.env.desc.repo')}
          </p>
        </div>
        <Button variant="primary" size="sm" className="env-add" icon={<Plus size={13} />} onClick={() => setSheet({ kind: 'add' })}>
          {t('settings.env.add')}
        </Button>
      </div>

      <Section plain>
        <div id={rowDomId(isUser ? 'environment-variables' : 'repo-environment-variables')} className="env-block">
          <div className="env-table" role="table" aria-label={t('settings.env.table')}>
            {!view ? (
              <div className="env-empty">
                {failed ? (
                  <>
                    <div className="env-empty-title">{t('settings.env.loadFailed')}</div>
                    <Button size="sm" className="env-retry" onClick={() => void load()}>
                      {t('repoSettings.branch.tryAgain')}
                    </Button>
                  </>
                ) : (
                  <div className="env-empty-sub">{t('common.loading')}</div>
                )}
              </div>
            ) : own.length === 0 ? (
              <div className="env-empty">
                <div className="env-empty-title">{t('settings.env.empty.title')}</div>
                <div className="env-empty-sub">{t('settings.env.empty.sub')}</div>
              </div>
            ) : (
              own.map((row) => (
                <VarRow
                  key={`${row.origin}:${row.key}`}
                  row={row}
                  value={<MaskedValue label={row.key} reveal={() => api.revealEnvVar(stableScope, row.key, 'own')} />}
                  actions={
                    editable(row) && (
                      <>
                        <IconButton label={t('settings.env.editVar', { name: row.key })} onClick={() => setSheet({ kind: 'edit', row })}>
                          <Pencil size={13} />
                        </IconButton>
                        {row.origin === 'saved' && (
                          <IconButton label={t('commands.edit.deleteLabel', { name: row.key })} onClick={() => void remove(row.key)}>
                            <Trash2 size={13} />
                          </IconButton>
                        )}
                      </>
                    )
                  }
                />
              ))
            )}
          </div>
          {view && (unsetDocumented.length > 0 || showDocumented) && (
            <Disclosure
              quiet
              className="env-doc-toggle"
              open={showDocumented}
              onOpenChange={setShowDocumented}
              label={showDocumented ? t('settings.env.hideDocumented') : t('settings.env.showDocumented', { count: unsetDocumented.length })}
            >
              <div className="env-table env-documented" role="table" aria-label={t('settings.env.documentedTable')}>
                {unsetDocumented.map((doc) => (
                  <VarRow
                    key={`doc:${doc.key}`}
                    row={{ key: doc.key, origin: 'saved' }}
                    unset
                    value={<Tag tone="outline">{t('gitlab.accounts.notSet')}</Tag>}
                    actions={
                      <IconButton label={t('settings.env.setVar', { name: doc.key })} onClick={() => setSheet({ kind: 'add', key: doc.key, lockKey: true })}>
                        <Plus size={14} />
                      </IconButton>
                    }
                  />
                ))}
              </div>
            </Disclosure>
          )}
        </div>
      </Section>

      <Section>
        <Row
          id={isUser ? 'env-files' : 'repo-env-files'}
          label={t('settings.env.files.label')}
          stacked
          help={
            <>
              {t('settings.env.files.help')}
              {platform === 'darwin' && ` ${t('settings.env.files.helpMac')}`}
            </>
          }
        >
          <EnvFiles scope={stableScope} files={view?.files ?? []} placeholder={isUser ? '~/.env' : '.env'} onChanged={() => void load()} />
        </Row>
      </Section>

      {!isUser && view && (
        <InheritedSections
          scope={stableScope}
          view={view}
          onOpen={(row, layer) => setSheet({ kind: 'view', row, layer })}
        />
      )}

      {sheet?.kind === 'add' && (
        <AddVariableSheet
          scope={stableScope}
          existing={ownKeys}
          presetKey={sheet.key}
          lockKey={sheet.lockKey}
          onClose={() => setSheet(null)}
          onSaved={() => void load()}
        />
      )}
      {sheet?.kind === 'edit' && (
        <EditVariableSheet scope={stableScope} row={sheet.row} existing={ownKeys} onClose={() => setSheet(null)} onSaved={() => void load()} />
      )}
      {sheet?.kind === 'view' && (
        <ViewVariableSheet
          scope={stableScope}
          row={sheet.row}
          layer={sheet.layer}
          onClose={() => setSheet(null)}
          onOverride={ownKeys.has(sheet.row.key) ? undefined : () => setSheet({ kind: 'add', key: sheet.row.key })}
        />
      )}
    </div>
  )
}

// ---- rows ----

function originIcon(row: EnvVarRow, t: TFunction): { icon: ReactNode; title: string } {
  if (row.origin === 'file') return { icon: <Gear size={13} />, title: row.file ? t('settings.env.origin.file', { file: row.file }) : t('settings.env.origin.fileUnnamed') }
  if (row.origin === 'shared') return { icon: <FileText size={13} />, title: row.file ? t('settings.env.origin.shared', { file: row.file }) : t('settings.env.origin.sharedDefault') }
  return { icon: <Lock size={13} />, title: t('settings.env.origin.saved') }
}

interface VarRowProps {
  row: EnvVarRow
  value: ReactNode
  actions?: ReactNode
  unset?: boolean
  // Read-only rows open a view sheet when clicked.
  onOpen?: () => void
}

function VarRow({ row, value, actions, unset, onOpen }: VarRowProps) {
  const t = useT()
  const origin = originIcon(row, t)
  const description = documentedDescription(row.key, t)
  return (
    <div
      className={`env-row ${unset ? 'unset' : ''} ${row.overridden ? 'overridden' : ''} ${onOpen ? 'clickable' : ''}`}
      role="row"
      onClick={onOpen}
      title={row.overridden ? t('settings.env.overridden') : undefined}
    >
      <span className="env-origin" role="cell" title={unset ? undefined : origin.title}>
        {unset ? <Plus size={13} className="env-origin-unset" /> : origin.icon}
      </span>
      <div className="env-name" role="cell">
        <span className="mono env-key">{row.key}</span>
        {description && <span className="env-desc">{description}</span>}
        {row.overridden && <span className="env-desc">{t('settings.env.overridden')}</span>}
      </div>
      {/* Reveal and copy shouldn't open the row. */}
      <div className="env-value" role="cell" onClick={(e) => e.stopPropagation()}>
        {value}
      </div>
      <div className="env-actions" role="cell" onClick={(e) => e.stopPropagation()}>
        {actions}
      </div>
    </div>
  )
}

function InheritedSections({
  scope,
  view,
  onOpen
}: {
  scope: EnvScope
  view: EnvView
  onOpen: (row: EnvVarRow, layer: 'shared' | 'inherited') => void
}) {
  const t = useT()
  const shared = useMemo(() => sortRows(view.shared ?? []), [view])
  const inherited = useMemo(() => sortRows(view.inherited ?? []), [view])
  const readOnlyRow = (row: EnvVarRow, layer: 'shared' | 'inherited') => (
    <VarRow
      key={`${row.origin}:${row.key}`}
      row={row}
      onOpen={() => onOpen(row, layer)}
      value={<MaskedValue label={row.key} reveal={() => api.revealEnvVar(scope, row.key, layer)} />}
      actions={
        <IconButton label={t('settings.env.viewVar', { name: row.key })} onClick={() => onOpen(row, layer)}>
          <ChevronRight size={14} />
        </IconButton>
      }
    />
  )
  return (
    <>
      {shared.length > 0 && (
        <Section title={t('settings.env.shared.title')} description={t('settings.env.shared.desc')} plain>
          <div className="env-table" role="table" aria-label={t('settings.env.shared.table')}>
            {shared.map((row) => readOnlyRow(row, 'shared'))}
          </div>
        </Section>
      )}
      <Section
        title={t('settings.env.inherited.title')}
        description={
          <>
            {t('settings.env.inherited.desc')}{' '}
            <LinkButton size="sm" underline onClick={() => openSettingsPage({ section: 'environment' })}>
              {t('settings.env.inherited.edit')}
            </LinkButton>
          </>
        }
        plain
      >
        <div className="env-table" role="table" aria-label={t('settings.env.inherited.title')}>
          {inherited.length ? (
            inherited.map((row) => readOnlyRow(row, 'inherited'))
          ) : (
            <div className="env-empty compact">
              <div className="env-empty-sub">{t('settings.env.inherited.empty')}</div>
            </div>
          )}
        </div>
      </Section>
    </>
  )
}

// ---- env files ----

function EnvFiles({ scope, files, placeholder, onChanged }: { scope: EnvScope; files: EnvFileInfo[]; placeholder: string; onChanged: () => void }) {
  const t = useT()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (next: string[]): Promise<boolean> => {
    setBusy(true)
    const saved = await attempt(async () => (await api.setEnvFiles(scope, next), true))
    setBusy(false)
    if (!saved) return false
    flashSaved()
    onChanged()
    return true
  }

  const close = () => {
    setAdding(false)
    setDraft('')
  }

  const add = async (entry: string) => {
    const path = entry.trim()
    if (!path || files.some((f) => f.path === path)) return close()
    if (await save([...files.map((f) => f.path), path])) close()
  }

  const browse = async () => {
    const picked = await attempt(() => api.pickPath({ kind: 'file', title: t('settings.env.files.pick') }))
    if (picked) await add(picked)
  }

  return (
    <div className="env-files">
      {files.map((file) => (
        <div key={file.path} className={`env-file ${file.error ? 'error' : ''}`} title={file.resolved}>
          <FileText size={13} className="env-file-icon" />
          <span className="mono env-file-name">{fileName(file.path)}</span>
          <span className="env-file-count">{file.error ?? t('settings.env.files.loaded', { count: file.count })}</span>
          <IconButton label={t('settings.env.files.remove', { path: file.path })} disabled={busy} onClick={() => void save(files.filter((f) => f.path !== file.path).map((f) => f.path))}>
            <Trash2 size={13} />
          </IconButton>
        </div>
      ))}
      {adding ? (
        <div className="env-file-add">
          <div className="env-file-input">
            <TextInput
              mono
              autoFocus
              spellCheck={false}
              autoComplete="off"
              placeholder={placeholder}
              aria-label={t('settings.env.files.path')}
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void add(draft)
                } else if (e.key === 'Escape') {
                  // Keep settings open.
                  e.preventDefault()
                  close()
                }
              }}
            />
            <IconButton className="env-file-browse" label={t('settings.env.files.browse')} disabled={busy} onClick={() => void browse()}>
              <FolderOpen size={14} />
            </IconButton>
          </div>
          <Button size="sm" disabled={busy || !draft.trim()} onClick={() => void add(draft)}>
            {t('common.add')}
          </Button>
          <IconButton label={t('common.cancel')} onClick={close}>
            <X size={14} />
          </IconButton>
        </div>
      ) : (
        <div>
          <Button size="sm" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
            {t('settings.env.files.add')}
          </Button>
        </div>
      )}
    </div>
  )
}
