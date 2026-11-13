// An organization's Memory view (docs/ai-employees.md §4 and §10): its memory repository's folders as a tree, the file
// chosen (Markdown rendered, anything else as lines), Edit with compare-and-set through the memory service, the file's
// history with its trailers, a search over the index, and what to do when the repository holds changes Foreman didn't
// make. Everything goes through the memory service; nothing here touches the folder.
import { Brain, ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Pencil, RotateCw, Save, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { snippetParts } from '../../../../shared/chatIndex'
import { sortEntries } from '../../../../shared/fileTree'
import type { PlainKey } from '../../../../shared/i18n'
import { formatDateTime } from '../../../../shared/i18n/time'
import { memoryFolders, type MemoryCommit, type MemoryEntry, type MemoryFile, type MemorySearchHit, type MemoryStatus } from '../../../../shared/memory'
import { useT } from '../../i18n'
import { api, attempt, closeMemory, openSettingsPage, useStore } from '../../store'
import { Button, Callout, Combobox, IconButton, LinkButton, Segmented, Spinner, Status, Tab, TabList, TabPanel, Tabs, Tag, TextArea, Tree, TreeItem } from '../../ui'
import { Markdown } from '../Markdown'
import { MemoryProposals } from '../employees/MemoryProposals'
import './memory.css'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const isMarkdown = (file: string) => /\.(md|markdown)$/i.test(file)
const baseName = (file: string) => file.slice(file.lastIndexOf('/') + 1)

interface Row {
  path: string
  name: string
  dir: boolean
  depth: number
  expanded?: boolean
}

/** The visible rows: folders first, then files, each open folder's children under it. `.gitkeep` files only make folders. */
export function memoryRows(entries: readonly MemoryEntry[], expanded: ReadonlySet<string>): Row[] {
  const children = new Map<string, { name: string; path: string; dir: boolean }[]>()
  const add = (file: string, dir: boolean) => {
    const slash = file.lastIndexOf('/')
    const parent = slash < 0 ? '' : file.slice(0, slash)
    const list = children.get(parent) ?? []
    list.push({ name: file.slice(slash + 1), path: file, dir })
    children.set(parent, list)
  }
  for (const folder of memoryFolders(entries)) add(folder, true)
  for (const e of entries) if (baseName(e.path) !== '.gitkeep') add(e.path, false)
  const rows: Row[] = []
  const walk = (parent: string, depth: number) => {
    for (const node of sortEntries(children.get(parent) ?? [])) {
      const open = node.dir && expanded.has(node.path)
      rows.push({ ...node, depth, ...(node.dir ? { expanded: open } : {}) })
      if (open) walk(node.path, depth + 1)
    }
  }
  walk('', 0)
  return rows
}

/** The folders that hold `file`, so opening it from search shows where it is. */
const foldersOf = (file: string) => file.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))

export function MemoryView({ organizationId }: { organizationId: string }) {
  const t = useT()
  const organization = useStore((s) => s.snapshot!.organizations?.find((o) => o.id === organizationId))
  const repo = useStore((s) => s.snapshot!.repos.find((r) => r.id === organization?.memoryRepoId))
  const status = useStore((s) => s.snapshot!.memory?.[organizationId])
  // Employees' proposed changes, kept or retired here as in Needs you (docs/ai-employees.md §10).
  const proposals = useStore((s) => s.snapshot!.employeeWork?.[organizationId]?.proposals?.length ?? 0)
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['memory', 'memory/org', 'bots', 'repos']))
  const [selected, setSelected] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const head = status && status.state !== 'unavailable' ? status.head : null
  const name = organization?.name ?? ''

  // Opening the view (and Look again) asks the service to look at the folder: foreign changes show up here.
  useEffect(() => {
    if (repo) void attempt(() => api.memoryStatus(organizationId))
  }, [organizationId, repo, reload])

  useEffect(() => {
    if (!repo) return
    let live = true
    api.memoryTree(organizationId).then(
      (tree) => {
        if (!live) return
        setEntries(tree.entries)
        setError('')
      },
      (err: unknown) => live && setError(message(err))
    )
    return () => {
      live = false
    }
  }, [organizationId, repo, head, reload])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if ((e.target as Element | null)?.closest?.('.modal, input, textarea, select, [role="menu"], [role="listbox"]')) return
      e.preventDefault()
      closeMemory()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const open = (file: string) => {
    setSelected(file)
    setExpanded((set) => new Set([...set, ...foldersOf(file)]))
  }

  return (
    <div className="memory-view">
      <header className="titlebar drag memory-head">
        <span className="memory-title" role="heading" aria-level={1}>
          <Brain size={15} aria-hidden /> {t('memory.title', { organization: name })}
        </span>
        {repo && (
          <span className="memory-repo faint small">
            <span className="mono">{repo.name}</span>
            <Tag>{t('spaces.memoryTag')}</Tag>
          </span>
        )}
        <span className="memory-head-end">
          {repo && (
            <IconButton label={t('memory.refresh')} onClick={() => setReload((n) => n + 1)}>
              <RotateCw size={14} />
            </IconButton>
          )}
          <IconButton label={t('memory.close')} onClick={closeMemory}>
            <X size={15} />
          </IconButton>
        </span>
      </header>
      {!repo ? (
        <div className="memory-none">
          <Callout tone="info" title={t('memory.noMemory', { organization: name })}>
            <LinkButton underline onClick={() => openSettingsPage({ section: 'spaces' })}>
              {t('memory.noMemoryLink')}
            </LinkButton>
          </Callout>
        </div>
      ) : (
        <>
          {status && status.state !== 'ok' && <StatusCallout organizationId={organizationId} status={status} />}
          {error && (
            <Callout tone="error" role="alert" banner>
              {error}
            </Callout>
          )}
          {proposals > 0 && (
            <div className="memory-proposals">
              <MemoryProposals orgId={organizationId} />
            </div>
          )}
          <div className="memory-body">
            <nav className="memory-side" aria-label={t('memory.side', { organization: name })}>
              <MemorySearch organizationId={organizationId} onOpen={open} />
              {entries === null && !error ? (
                <div className="files-line" role="status">
                  <Spinner size={13} /> <span>{t('common.loading')}</span>
                </div>
              ) : (
                entries && <MemoryTreeList entries={entries} expanded={expanded} onExpanded={setExpanded} selected={selected} onOpen={setSelected} />
              )}
              <p className="memory-shared faint small">{t('memory.readsShared', { organization: name })}</p>
            </nav>
            <section className="memory-main" aria-label={selected ?? t('memory.pickFile')}>
              {selected ? (
                <MemoryFilePane key={selected} organizationId={organizationId} path={selected} head={head} writable={status?.state === 'ok'} />
              ) : (
                <div className="panel-empty faint">{t('memory.pickFile')}</div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}

const UNAVAILABLE: Record<Exclude<Extract<MemoryStatus, { state: 'unavailable' }>['reason'], 'branch'>, PlainKey> = {
  missing: 'memory.unavailable.missing',
  'not-git': 'memory.unavailable.notGit',
  empty: 'memory.unavailable.empty',
  busy: 'memory.unavailable.busy'
}

/** Foreign changes (with Accept), or why Foreman can't use the folder now. */
function StatusCallout({ organizationId, status }: { organizationId: string; status: Exclude<MemoryStatus, { state: 'ok' }> }) {
  const t = useT()
  const [working, setWorking] = useState(false)
  if (status.state === 'unavailable') {
    return (
      <Callout tone="warn" role="status" banner title={t('memory.unavailable.title')}>
        {status.reason === 'branch' ? t('memory.unavailable.branch', { branch: status.branch ?? '' }) : t(UNAVAILABLE[status.reason])}
      </Callout>
    )
  }
  const accept = async () => {
    setWorking(true)
    await attempt(() => api.memoryAcceptForeign(organizationId))
    setWorking(false)
  }
  return (
    <Callout
      tone="warn"
      role="status"
      banner
      title={t('memory.foreign.title')}
      actions={
        <Button size="sm" variant="primary" disabled={working} onClick={() => void accept()}>
          {working ? t('memory.foreign.accepting') : t('memory.foreign.accept')}
        </Button>
      }
    >
      <div className="memory-foreign">
        {status.commits.length > 0 && (
          <ul className="memory-foreign-list" aria-label={t('memory.foreign.commits')}>
            {status.commits.map((c) => (
              <li key={c.commit}>
                <span className="mono">{c.commit.slice(0, 7)}</span> {c.subject} <span className="faint">· {c.author}</span>
              </li>
            ))}
            {status.moreCommits > 0 && <li className="faint">{t('memory.foreign.more', { count: status.moreCommits })}</li>}
          </ul>
        )}
        {status.dirty.length > 0 && (
          <ul className="memory-foreign-list" aria-label={t('memory.foreign.dirty')}>
            {status.dirty.map((file) => (
              <li key={file}>
                <span className="mono">{file}</span> <span className="faint">· {t('memory.foreign.uncommitted')}</span>
              </li>
            ))}
          </ul>
        )}
        {!status.commits.length && !status.dirty.length && <p>{t('memory.foreign.moved')}</p>}
        <p>
          {t('memory.foreign.body')}
          {status.dirty.length > 0 && ` ${t('memory.foreign.dirtyNote')}`}
        </p>
      </div>
    </Callout>
  )
}

function MemoryTreeList({ entries, expanded, onExpanded, selected, onOpen }: { entries: MemoryEntry[]; expanded: ReadonlySet<string>; onExpanded: (next: ReadonlySet<string>) => void; selected: string | null; onOpen: (file: string) => void }) {
  const t = useT()
  const rows = useMemo(() => memoryRows(entries, expanded), [entries, expanded])
  const toggle = (folder: string) => {
    const next = new Set(expanded)
    if (!next.delete(folder)) next.add(folder)
    onExpanded(next)
  }
  if (!rows.length) return <div className="files-line">{t('memory.tree.empty')}</div>
  return (
    <Tree className="files-tree" label={t('memory.tree.label')} rows={rows.map((r) => ({ path: r.path, dir: r.dir, depth: r.depth, expanded: r.expanded, label: r.name }))} onToggle={toggle} onOpen={onOpen}>
      {rows.map((r) => (
        <TreeItem key={r.path} path={r.path} selected={selected === r.path} title={r.path} className="file-node">
          {r.dir ? r.expanded ? <ChevronDown size={12} className="file-node-chev" aria-hidden /> : <ChevronRight size={12} className="file-node-chev" aria-hidden /> : <span className="file-node-chev" />}
          {r.dir ? r.expanded ? <FolderOpen size={14} className="file-node-icon" aria-hidden /> : <Folder size={14} className="file-node-icon" aria-hidden /> : <FileText size={14} className="file-node-icon" aria-hidden />}
          <span className="file-node-name">{r.name}</span>
        </TreeItem>
      ))}
    </Tree>
  )
}

/** The matched words of a snippet marked. */
function Snippet({ text }: { text: string }) {
  return <span>{snippetParts(text).map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}</span>
}

/** Search the index: results in place of the tree while there is a query; choosing one opens it. */
function MemorySearch({ organizationId, onOpen }: { organizationId: string; onOpen: (file: string) => void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemorySearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const latest = useRef(0)
  useEffect(() => {
    if (!query.trim()) {
      setHits([])
      return
    }
    const id = ++latest.current
    const timer = setTimeout(async () => {
      setSearching(true)
      const found = await attempt(() => api.memorySearch(organizationId, query))
      if (id !== latest.current) return
      setHits(found ?? [])
      setSearching(false)
    }, 150)
    return () => clearTimeout(timer)
  }, [query, organizationId])
  const searched = query.trim() !== ''
  return (
    <div className="memory-search">
      <Combobox
        label={t('memory.search.label')}
        placeholder={t('memory.search.placeholder')}
        inline
        open={searched}
        leading={<Search size={14} aria-hidden />}
        query={query}
        onQueryChange={setQuery}
        empty={searched && !hits.length ? (searching ? t('memory.search.searching') : t('memory.search.none')) : undefined}
        options={hits.map((hit) => ({ value: hit.path, label: hit.path, description: <Snippet text={hit.snippet} /> }))}
        onChange={(file) => {
          setQuery('')
          onOpen(file)
        }}
      />
    </div>
  )
}

function Lines({ text }: { text: string }) {
  return (
    <div className="file-lines">
      {text.split('\n').map((line, n) => (
        <div key={n} className="file-line">
          <span className="ln">{n + 1}</span>
          <span className="code">{line || ' '}</span>
        </div>
      ))}
    </div>
  )
}

/** One file: read, edit with compare-and-set, and its history. */
function MemoryFilePane({ organizationId, path, head, writable }: { organizationId: string; path: string; head: string | null; writable: boolean }) {
  const t = useT()
  const [file, setFile] = useState<MemoryFile | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<{ blob: string | null; text: string | null } | null>(null)
  const [source, setSource] = useState(false)
  const [tab, setTab] = useState('file')
  const [history, setHistory] = useState<MemoryCommit[] | null>(null)
  const markdown = isMarkdown(path)
  const dirty = editing && file?.text !== undefined && draft !== file.text

  // Read again when the head moves, unless an edit is open (its draft stays; Save compares against what was opened).
  useEffect(() => {
    if (editing) return
    let live = true
    api.memoryReadFile(organizationId, path).then(
      (next) => {
        if (!live) return
        setFile(next)
        setError('')
      },
      (err: unknown) => live && setError(message(err))
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, path, head])

  useEffect(() => {
    if (tab !== 'history') return
    let live = true
    setHistory(null)
    api.memoryFileHistory(organizationId, path).then(
      (commits) => live && setHistory(commits),
      (err: unknown) => live && setError(message(err))
    )
    return () => {
      live = false
    }
  }, [organizationId, path, tab, head])

  const startEdit = () => {
    if (file?.text === undefined) return
    setDraft(file.text)
    setConflict(null)
    setError('')
    setEditing(true)
  }

  const save = async (expected: string | null) => {
    setSaving(true)
    setError('')
    try {
      const result = await api.memoryWriteFile(organizationId, path, draft, expected)
      if (result.ok) {
        setFile((f) => f && { ...f, text: draft, blob: result.blob, size: draft.length })
        setEditing(false)
        setConflict(null)
      } else setConflict(result.conflict)
    } catch (err) {
      setError(message(err))
    } finally {
      setSaving(false)
    }
  }

  const takeTheirs = () => {
    if (!conflict) return
    setFile((f) => f && { ...f, blob: conflict.blob, ...(conflict.text !== null ? { text: conflict.text } : {}) })
    setConflict(null)
    setEditing(false)
  }

  return (
    <div className="file-viewer">
      <div className="file-diff-head memory-file-head">
        <span className="mono">{path}</span>
        {dirty && <Status tone="warn" compact title={t('files.viewer.unsaved')} label={t('files.viewer.unsaved')} />}
        <span className="spacer" />
        {markdown && !editing && file?.text !== undefined && tab === 'file' && (
          <Segmented
            small
            label={t('memory.view.label')}
            value={source ? 'source' : 'rendered'}
            onChange={(v) => setSource(v === 'source')}
            options={[
              { value: 'rendered', label: t('memory.view.rendered') },
              { value: 'source', label: t('files.preview.source') }
            ]}
          />
        )}
        {file?.text !== undefined && !editing && (
          <Button size="sm" variant="ghost" icon={<Pencil size={12} />} disabled={!writable} title={writable ? undefined : t('memory.edit.blocked')} onClick={startEdit}>
            {t('common.edit')}
          </Button>
        )}
        {editing && (
          <>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" icon={<Save size={12} />} disabled={!dirty || saving || conflict !== null} onClick={() => void save(file?.blob ?? null)}>
              {saving ? t('common.saving') : t('common.save')}
            </Button>
          </>
        )}
      </div>
      {error && (
        <Callout tone="error" role="alert" banner>
          {error}
        </Callout>
      )}
      {conflict && (
        <div className="memory-conflict">
          <Callout
            tone="warn"
            role="alert"
            title={t('memory.conflict.title')}
            actions={
              <>
                <Button size="sm" disabled={saving} onClick={takeTheirs}>
                  {t('memory.conflict.takeTheirs')}
                </Button>
                <Button size="sm" variant="primary" disabled={saving} onClick={() => void save(conflict.blob)}>
                  {t('memory.conflict.keepMine')}
                </Button>
              </>
            }
          >
            {t('memory.conflict.body')}
          </Callout>
          <div className="memory-conflict-sides">
            <section aria-label={t('memory.conflict.theirs')}>
              <h3 className="memory-side-heading">{t('memory.conflict.theirs')}</h3>
              {conflict.text === null ? <p className="faint">{t('memory.conflict.deleted')}</p> : <Lines text={conflict.text} />}
            </section>
            <section aria-label={t('memory.conflict.yours')}>
              <h3 className="memory-side-heading">{t('memory.conflict.yours')}</h3>
              <Lines text={draft} />
            </section>
          </div>
        </div>
      )}
      {!conflict && (
        <Tabs value={tab} onChange={setTab} className="memory-tabs">
          <TabList label={t('memory.tabs', { path })}>
            <Tab value="file">{t('memory.tab.file')}</Tab>
            <Tab value="history">{t('memory.tab.history')}</Tab>
          </TabList>
          <TabPanel value="file" className="memory-panel">
            {!file && !error ? (
              <div className="files-line" role="status">
                <Spinner size={13} /> <span>{t('common.loading')}</span>
              </div>
            ) : file && file.blob === null && !editing ? (
              <div className="panel-empty faint">{t('memory.file.missing')}</div>
            ) : file?.binary ? (
              <div className="panel-empty faint">{t('files.viewer.binary')}</div>
            ) : file?.tooLarge ? (
              <div className="panel-empty faint">{t('files.viewer.tooLarge')}</div>
            ) : editing ? (
              <div className="file-editor-box">
                <TextArea bare mono className="file-editor" aria-label={t('memory.edit.label', { path })} value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} autoFocus />
              </div>
            ) : file?.text !== undefined && markdown && !source ? (
              <div className="file-preview">
                <Markdown text={file.text} />
              </div>
            ) : (
              file?.text !== undefined && <Lines text={file.text} />
            )}
          </TabPanel>
          <TabPanel value="history" className="memory-panel">
            <FileHistory commits={history} path={path} />
          </TabPanel>
        </Tabs>
      )}
    </div>
  )
}

function FileHistory({ commits, path }: { commits: MemoryCommit[] | null; path: string }) {
  const t = useT()
  if (!commits) {
    return (
      <div className="files-line" role="status">
        <Spinner size={13} /> <span>{t('common.loading')}</span>
      </div>
    )
  }
  if (!commits.length) return <div className="panel-empty faint">{t('memory.history.none')}</div>
  return (
    <ol className="memory-history" aria-label={t('memory.history.label', { path })}>
      {commits.map((c) => (
        <li key={c.commit} className="memory-commit">
          <span className="memory-commit-subject">{c.subject}</span>
          <span className="faint small">
            <span className="mono">{c.commit.slice(0, 7)}</span> · {t('memory.history.by', { author: c.author, date: formatDateTime(c.date, t.locale, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) })}
          </span>
          {c.trailers.length > 0 && (
            <span className="memory-trailers">
              {c.trailers.map((tr, i) => (
                <Tag key={i} tone="outline">
                  {tr.key}: {tr.value}
                </Tag>
              ))}
            </span>
          )}
        </li>
      ))}
    </ol>
  )
}
