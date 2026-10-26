// The side panel's Files tab (#19): the worktree as a tree, loaded one folder
// at a time from main, or with "Changed only" just the changed files and the
// folders that hold them. Counts on folders come from the diff the Changes
// tab already has. Clicking a file opens it in the file viewer.
import { ChevronDown, ChevronRight, File, FileCode, FileImage, FileText, Folder, FolderOpen } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { changedTree, folderStats, type ChangedFile, type ChangedNode, type ChangeStat, type DirListing } from '../../../shared/fileTree'
import { previewFormat } from '../../../shared/imageInfo'
import type { DiffFile, WorkspaceDiff } from '../../../shared/types'
import { useT } from '../i18n'
import { api } from '../store'
import { StatusIcon } from './Changes'
import { Button, Spinner, Switch, Tree, TreeItem } from '../ui'
import { DiffBadge } from './Sidebar'
import './files.css'

// ---- "Changed only", remembered per workspace (kept in localStorage like the panel widths) ----

const PREF_KEY = 'switchyard:filesChangedOnly'
const prefListeners = new Set<() => void>()

function loadChangedOnly(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

let changedOnlyPrefs = loadChangedOnly()

function setChangedOnly(workspaceId: string, on: boolean): void {
  changedOnlyPrefs = { ...changedOnlyPrefs, [workspaceId]: on }
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(changedOnlyPrefs))
  } catch {
    // Not persisted; fine.
  }
  for (const listener of prefListeners) listener()
}

/** The workspace's choice, or undefined before the user has made one. */
function useChangedOnly(workspaceId: string): boolean | undefined {
  return useSyncExternalStore(
    (listener) => {
      prefListeners.add(listener)
      return () => prefListeners.delete(listener)
    },
    () => changedOnlyPrefs[workspaceId]
  )
}

// ---- rows ----

type Folder = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; listing: DirListing }

type Entry = { path: string; name: string; dir: boolean; depth: number; expanded?: boolean; stat?: ChangeStat; file?: ChangedFile }

// What isn't a row of the tree (a folder still loading, an empty or cut-off folder, a folder that couldn't be read):
// listed under the tree, naming its folder.
type Line = { kind: 'loading'; key: string; dir: string } | { kind: 'note'; key: string; dir: string; text: string } | { kind: 'error'; key: string; dir: string; error: string }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '\w+': (Error: )?/, '')

function FileKindIcon({ name }: { name: string }) {
  const props = { size: 14, className: 'file-node-icon' }
  if (previewFormat(name)) return <FileImage {...props} />
  if (/\.(md|mdx|markdown|txt|rst)$/i.test(name)) return <FileText {...props} />
  if (/\.([cm]?[jt]sx?|json|ya?ml|toml|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|sh|ps1|css|scss|html?|vue|svelte|sql|xml)$/i.test(name)) return <FileCode {...props} />
  return <File {...props} />
}

function ChangeBadge({ stat }: { stat: ChangeStat }) {
  const t = useT()
  if (stat.additions || stat.deletions) return <DiffBadge additions={stat.additions} deletions={stat.deletions} />
  if (stat.binary) {
    return (
      <span className="diff-badge bin" title={t('files.binaryTitle')}>
        {t('files.binary')}
      </span>
    )
  }
  return null
}

export function FilesTree({
  workspaceId,
  diff,
  selected,
  reloadKey,
  onOpen
}: {
  workspaceId: string
  diff: WorkspaceDiff | null
  // The file open in the viewer (or diff), highlighted.
  selected: string | null
  // Bumped by the panel's Refresh button.
  reloadKey: number
  onOpen: (path: string, file?: DiffFile) => void
}) {
  const t = useT()
  const chosen = useChangedOnly(workspaceId)
  // Until the user picks, Changed only is on when the workspace has changes (undefined while the diff loads).
  const changedOnly = chosen ?? (diff ? diff.files.length > 0 : undefined)
  const [folders, setFolders] = useState<Record<string, Folder>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [total, setTotal] = useState<number | null>(null)
  const foldersRef = useRef(folders)
  foldersRef.current = folders

  const load = useCallback(
    async (dir: string) => {
      // A folder being refreshed keeps its rows until the new listing arrives.
      setFolders((f) => (f[dir]?.state === 'ok' ? f : { ...f, [dir]: { state: 'loading' } }))
      try {
        const listing = await api.listDir(workspaceId, dir)
        setFolders((f) => ({ ...f, [dir]: { state: 'ok', listing } }))
      } catch (err) {
        setFolders((f) => ({ ...f, [dir]: { state: 'error', error: message(err) } }))
      }
    },
    [workspaceId]
  )

  const loadTotal = useCallback(() => {
    // The same list quick open uses; at its cap the count would be a guess, so none is shown.
    void api
      .listFiles(workspaceId)
      .then((files) => setTotal(files.length >= 20_000 ? null : files.length))
      .catch(() => setTotal(null))
  }, [workspaceId])

  useEffect(loadTotal, [loadTotal])

  // The whole tree loads the top folder, and each open folder, when first needed.
  useEffect(() => {
    if (changedOnly !== false) return
    for (const dir of ['', ...expanded]) if (!foldersRef.current[dir]) void load(dir)
  }, [changedOnly, expanded, load])

  // When files are added or removed (the diff's file list changes), or on Refresh, listed folders are read again.
  // (The diff arriving for the first time isn't a change.)
  const changeKey = diff ? diff.files.map((f) => f.path).join('\n') : null
  const seen = useRef({ changeKey, reloadKey })
  useEffect(() => {
    const before = seen.current
    seen.current = { changeKey, reloadKey }
    if (before.reloadKey === reloadKey && (before.changeKey === changeKey || before.changeKey === null)) return
    for (const dir of Object.keys(foldersRef.current)) void load(dir)
    loadTotal()
  }, [changeKey, reloadKey, load, loadTotal])

  const files = useMemo(() => diff?.files ?? [], [diff])
  const stats = useMemo(() => folderStats(files), [files])
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files])
  const tree = useMemo(() => changedTree(files), [files])

  const entries: Entry[] = []
  const lines: Line[] = []
  if (changedOnly) {
    const walk = (nodes: ChangedNode[], depth: number) => {
      for (const n of nodes) {
        const open = n.dir && !collapsed.has(n.path)
        entries.push({ path: n.path, name: n.name, dir: n.dir, depth, expanded: n.dir ? open : undefined, stat: n.stat, file: n.file })
        if (open) walk(n.children, depth + 1)
      }
    }
    walk(tree, 0)
  } else if (changedOnly === false) {
    const walk = (dir: string, depth: number) => {
      const folder = folders[dir]
      if (!folder || folder.state === 'loading') return void lines.push({ kind: 'loading', key: `${dir}/…`, dir })
      if (folder.state === 'error') return void lines.push({ kind: 'error', key: `${dir}/!`, dir, error: folder.error })
      if (dir && !folder.listing.entries.length) lines.push({ kind: 'note', key: `${dir}/0`, dir, text: t('files.emptyFolder') })
      for (const e of folder.listing.entries) {
        const file = byPath.get(e.path)
        const stat = e.dir ? stats.get(e.path) : file && { files: 1, additions: file.additions, deletions: file.deletions, binary: file.binary ? 1 : 0 }
        const open = e.dir && expanded.has(e.path)
        entries.push({ path: e.path, name: e.name, dir: e.dir, depth, expanded: e.dir ? open : undefined, stat, file })
        if (open) walk(e.path, depth + 1)
      }
      if (folder.listing.truncated) lines.push({ kind: 'note', key: `${dir}/+`, dir, text: t('files.truncated', { count: folder.listing.entries.length }) })
    }
    walk('', 0)
  }
  const treeRows = entries.map((r) => ({ path: r.path, dir: r.dir, depth: r.depth, expanded: r.expanded, label: r.name }))
  // A line names its folder, except the top one.
  const named = (dir: string, text: string) => (dir ? t('files.folderLine', { folder: dir, text }) : text)

  const toggle = (path: string) => {
    const flip = (set: ReadonlySet<string>) => {
      const next = new Set(set)
      if (!next.delete(path)) next.add(path)
      return next
    }
    if (changedOnly) setCollapsed(flip)
    else setExpanded(flip)
  }
  const open = (path: string) => onOpen(path, byPath.get(path))

  const count = total === null ? null : changedOnly ? t('files.shownOf', { shown: files.length, total }) : t('files.total', { count: total })

  return (
    <div className="files-tab">
      <div className="tree-tools">
        <label className="tree-toggle" title={t('files.changedOnlyTitle')}>
          <Switch checked={Boolean(changedOnly)} disabled={changedOnly === undefined} onChange={(on) => setChangedOnly(workspaceId, on)} label={t('files.changedOnly')} />
          {t('files.changedOnly')}
        </label>
        <span className="spacer" />
        {count && <span className="faint small">{count}</span>}
      </div>
      {changedOnly === undefined && (
        <div className="panel-empty faint">
          <Spinner size={12} /> {t('files.loadingChanges')}
        </div>
      )}
      {changedOnly && !files.length && (
        <div className="panel-empty faint">{diff?.scope === 'uncommitted' ? t('files.noChangesUncommitted') : t('files.noChanges')}</div>
      )}
      {entries.length > 0 && (
        <Tree className="files-tree" label={t('files.treeLabel')} rows={treeRows} onToggle={toggle} onOpen={open}>
          {entries.map((r) => (
            <TreeItem key={r.path} path={r.path} selected={selected === r.path} title={r.path} className={`file-node ${r.file ? 'changed' : ''}`}>
              {r.dir ? r.expanded ? <ChevronDown size={12} className="file-node-chev" /> : <ChevronRight size={12} className="file-node-chev" /> : <span className="file-node-chev" />}
              {r.file ? <StatusIcon status={r.file.status} /> : r.dir ? r.expanded ? <FolderOpen size={14} className="file-node-icon" /> : <Folder size={14} className="file-node-icon" /> : <FileKindIcon name={r.name} />}
              <span className="file-node-name">{r.name}</span>
              <span className="file-node-end">
                {r.dir && r.stat && (
                  <span className="file-node-count" title={t('files.folderCount', { count: r.stat.files })}>
                    {r.stat.files}
                  </span>
                )}
                {r.stat && <ChangeBadge stat={r.stat} />}
              </span>
            </TreeItem>
          ))}
        </Tree>
      )}
      {lines.map((line) =>
        line.kind === 'loading' ? (
          <div key={line.key} className="files-line" role="status">
            <Spinner size={13} /> <span>{named(line.dir, t('files.loading'))}</span>
          </div>
        ) : line.kind === 'note' ? (
          <div key={line.key} className="files-line">
            <span>{named(line.dir, line.text)}</span>
          </div>
        ) : (
          <div key={line.key} className="files-line" role="alert">
            <span className="error-text" title={line.error}>
              {named(line.dir, t('files.loadError', { error: line.error }))}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void load(line.dir)}>
              {t('files.retry')}
            </Button>
          </div>
        )
      )}
      {changedOnly && diff?.truncated && <div className="panel-empty faint">{t('files.diffTruncated')}</div>}
      <div className="tree-foot faint small">
        {changedOnly
          ? diff?.scope === 'uncommitted'
            ? t('files.base.uncommitted')
            : diff && t.rich('files.base.all', { base: <span className="mono">{diff.baseRef}</span> })
          : changedOnly === false && t('files.ignoredNote')}
      </div>
    </div>
  )
}
