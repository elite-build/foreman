// #14 Open in detected apps: the Open menu's app list (workspace header and file viewer),
// the file viewer's "Open at line N in Cursor" button, and the ⌘O switcher.
import { Code2, Folder, Search, Settings2, SquareTerminal } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { openInAppInfo, foundApps, joinWorkspace, openInShortcut, type OpenInApp, type OpenInChoice, type OpenInTarget, type ResolvedDefault } from '../../../shared/openIn'
import { wsPath } from '../../../shared/workspacePath'
import { useT, type RendererT } from '../i18n'
import {
  appLabel,
  defaultApp,
  missingLabel,
  useDefaultApp,
  openInAppsNow,
  openWith,
  refreshOpenInApps,
  setDefaultApp,
  setViewedFile,
  useAppIconUrl,
  useOpenInApps,
  viewedFile
} from '../openIn'
import { openOverlay, openSettingsPage, useStore } from '../store'
import { Callout, ContextMenu, Dialog, Kbd, Listbox, MenuGroup, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator, SplitButton, Tag, TextInput, type ListboxOption } from '../ui'
import './openIn.css'

const baseName = (file: string) => file.split(/[\\/]/).pop() ?? file

/** A small icon: the app's own icon (G4), else its monogram for editors, a terminal or folder glyph for the rest. */
export function AppIcon({ id }: { id: OpenInApp['id'] | 'custom' }) {
  const url = useAppIconUrl(id)
  if (id === 'custom') return <Code2 size={14} className="app-icon-glyph" aria-hidden />
  if (url) return <img className="app-icon-img" src={url} width={16} height={16} alt="" aria-hidden draggable={false} />
  const info = openInAppInfo(id)
  if (info.kind === 'files') return <Folder size={14} className="app-icon-glyph files" aria-hidden />
  if (info.kind === 'terminal') return <SquareTerminal size={14} className="app-icon-glyph" aria-hidden />
  return (
    <span className="app-icon" data-app={id} aria-hidden>
      {info.monogram}
    </span>
  )
}

function openSettings() {
  openOverlay(null)
  openSettingsPage({ section: 'general', scrollTo: 'open-in-apps' })
}

/** Why the default can't run, or null when it can. */
function missingNote(resolved: ResolvedDefault, t: RendererT, platform: string): string | null {
  if (resolved.kind !== 'missing') return null
  return resolved.choice === 'custom' ? t('openIn.missingCustom') : t('openIn.missingDefault', { app: missingLabel(resolved.choice, platform, t) })
}

/**
 * The apps in an Open menu: editors, then terminals and the file manager, then Custom command….
 * `target` is what they open: the workspace folder, or a file at a line (terminals still get the folder).
 * Render it inside a `Menu` (the Open button's `SplitButton`, the file viewer's): its items are `MenuItem`s.
 */
export function OpenInMenuItems({ heading, target, onDone, shortcut }: { heading: string; target: OpenInTarget; onDone: () => void; shortcut?: boolean }) {
  const t = useT()
  const detection = useOpenInApps()
  const platform = useStore((s) => s.snapshot!.platform)
  const custom = useStore((s) => s.snapshot!.settings.editorCommand.trim())
  const resolved = useDefaultApp(detection)
  const defaultId: OpenInChoice | null = resolved.kind === 'app' ? resolved.app.id : resolved.kind === 'custom' ? 'custom' : null
  const note = missingNote(resolved, t, platform)
  const apps = foundApps(detection)
  const editors = apps.filter((a) => a.kind === 'editor')
  const others = apps.filter((a) => a.kind !== 'editor')
  // The list is mounted each time the menu opens: look again, so an app installed a moment ago shows up.
  useEffect(() => {
    void refreshOpenInApps(true)
  }, [])
  const run = (choice: OpenInChoice) => {
    onDone()
    void openWith(choice, target)
  }
  const item = (app: OpenInApp) => {
    const isDefault = app.id === defaultId
    const showKbd = shortcut && isDefault
    return (
      <MenuItem
        key={app.id}
        icon={<AppIcon id={app.id} />}
        title={app.path ?? undefined}
        description={app.kind === 'files' && target.file ? t('openIn.revealNote', { file: baseName(target.file) }) : undefined}
        hint={
          isDefault || showKbd ? (
            <span className="open-in-hint">
              {isDefault && <Tag>{t('openIn.default')}</Tag>}
              {showKbd && <Kbd>{openInShortcut(platform)}</Kbd>}
            </span>
          ) : undefined
        }
        onSelect={() => run(app.id)}
      >
        {appLabel(app, platform, t)}
      </MenuItem>
    )
  }

  return (
    <>
      <MenuLabel>{heading}</MenuLabel>
      {note && (
        <Callout className="open-in-missing" role="status">
          {note}
        </Callout>
      )}
      {!detection && <MenuLabel>{t('openIn.looking')}</MenuLabel>}
      {editors.map(item)}
      {editors.length > 0 && others.length > 0 && <MenuSeparator />}
      {others.map(item)}
      <MenuSeparator />
      <MenuItem
        icon={<AppIcon id="custom" />}
        description={<span className="mono">{custom || t('openIn.customNotSet')}</span>}
        hint={defaultId === 'custom' ? <Tag>{t('openIn.default')}</Tag> : undefined}
        onSelect={() => {
          if (!custom) {
            onDone()
            openSettingsPage({ section: 'general', scrollTo: 'editor-command' })
          } else run('custom')
        }}
      >
        {t('openIn.custom')}
      </MenuItem>
      {note && (
        <MenuItem
          icon={<Settings2 size={14} aria-hidden />}
          onSelect={() => {
            onDone()
            openSettings()
          }}
        >
          {t('openIn.settingsLink')}
        </MenuItem>
      )}
    </>
  )
}

/**
 * G4 #14: right-click on an Open button: pick the default app there and then (the same setting as
 * Settings → General → Open in apps). A `ContextMenu`: drawn in <body> at the pointer and kept on screen.
 */
export function DefaultAppMenu({ x, y, dismiss }: { x: number; y: number; dismiss: () => void }) {
  const t = useT()
  const detection = useOpenInApps()
  const platform = useStore((s) => s.snapshot!.platform)
  const choice = useStore((s) => s.snapshot!.settings.openInDefault)
  const custom = useStore((s) => s.snapshot!.settings.editorCommand.trim())
  const resolved = useDefaultApp(detection)

  // Look again, so an app installed a moment ago can be picked.
  useEffect(() => void refreshOpenInApps(true), [])

  const pick = (next: OpenInChoice) => {
    if (next !== choice) void setDefaultApp(next)
  }
  const row = (value: OpenInChoice, icon: ReactNode, label: string, disabled = false) => (
    <MenuRadioItem key={value || 'auto'} checked={choice === value} disabled={disabled} icon={icon} onSelect={() => pick(value)}>
      {label}
    </MenuRadioItem>
  )
  const autoName = choice === '' && resolved.kind === 'app' ? t('settings.openIn.default.auto', { app: appLabel(resolved.app, platform, t) }) : t('settings.openIn.default.autoNone')

  return (
    <ContextMenu x={x} y={y} label={t('openIn.setDefault.title')} className="open-in-menu" onClose={dismiss}>
      <MenuLabel>{t('openIn.setDefault.title')}</MenuLabel>
      <MenuGroup label={t('openIn.setDefault.title')}>
        {row('', <Code2 size={14} className="app-icon-glyph" aria-hidden />, autoName)}
        {foundApps(detection).map((app) => row(app.id, <AppIcon id={app.id} />, appLabel(app, platform, t)))}
        {row('custom', <AppIcon id="custom" />, t('openIn.custom'), !custom)}
      </MenuGroup>
      {!detection && <MenuLabel>{t('openIn.looking')}</MenuLabel>}
      <MenuSeparator />
      <MenuItem icon={<Settings2 size={14} aria-hidden />} onSelect={openSettings}>
        {t('openIn.settingsLink')}
      </MenuItem>
    </ContextMenu>
  )
}

/** The Open button's label and title for the default app (its icon and name). */
export function useDefaultLabel(): { id: OpenInApp['id'] | 'custom' | null; name: string } {
  const t = useT()
  const detection = useOpenInApps()
  const platform = useStore((s) => s.snapshot!.platform)
  const resolved = useDefaultApp(detection)
  if (resolved.kind === 'app') return { id: resolved.app.id, name: appLabel(resolved.app, platform, t) }
  if (resolved.kind === 'custom') return { id: 'custom', name: resolved.command }
  return { id: null, name: '' }
}

/** Run the default app on a target; false when there isn't one (the caller shows the menu). */
export function openDefault(target: OpenInTarget): boolean {
  const found = openInAppsNow()
  // Not looked up yet: main knows, and says so if it can't.
  const resolved = found ? defaultApp(found) : null
  if (resolved && (resolved.kind === 'missing' || resolved.kind === 'none')) return false
  void openWith(null, target)
  return true
}

/**
 * The file viewer's button: "Open at line 267 in Cursor", with the other apps in its menu.
 * It also tells ⌘O which file this workspace is showing.
 */
export function OpenInViewerButton({ workspaceId, workspacePath, path, line }: { workspaceId: string; workspacePath: string; path: string; line?: number }) {
  const t = useT()
  const [defaultMenu, setDefaultMenu] = useState<{ x: number; y: number } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const detection = useOpenInApps()
  const platform = useStore((s) => s.snapshot!.platform)
  const resolved = useDefaultApp(detection)
  const target: OpenInTarget = { folder: workspacePath, file: joinWorkspace(workspacePath, path), ...(line ? { line } : {}) }

  useEffect(() => {
    setViewedFile(workspaceId, { path, line })
    return () => setViewedFile(workspaceId, null)
  }, [workspaceId, path, line])

  const label =
    resolved.kind === 'app'
      ? line && resolved.app.atLine
        ? t('openIn.viewer.atLine', { line, app: appLabel(resolved.app, platform, t) })
        : t('openIn.viewer.inApp', { app: appLabel(resolved.app, platform, t) })
      : t('openIn.viewer.inEditor')

  return (
    <>
      <SplitButton
        variant="ghost"
        size="sm"
        label={
          <>
            {resolved.kind === 'app' ? <AppIcon id={resolved.app.id} /> : <Code2 size={12} aria-hidden />} {label}
          </>
        }
        menuLabel={t('openIn.viewer.more')}
        menuOpen={menuOpen}
        onMenuOpenChange={setMenuOpen}
        // With no default app to run, the button shows the menu instead.
        onClick={() => !openDefault(target) && setMenuOpen(true)}
        onContextMenu={(e) => {
          e.preventDefault()
          setDefaultMenu({ x: e.clientX, y: e.clientY })
        }}
        title={`${openInShortcut(platform)} · ${t('openIn.setDefault.hint')}`}
      >
        <OpenInMenuItems heading={line ? t('openIn.switcher.fileAtLine', { file: path, line }) : path} target={target} onDone={() => undefined} />
      </SplitButton>
      {defaultMenu && <DefaultAppMenu {...defaultMenu} dismiss={() => setDefaultMenu(null)} />}
    </>
  )
}

interface Row {
  key: string
  choice: OpenInChoice
  app?: OpenInApp
  name: string
  group: 'file' | 'folder'
  note?: string
}

/**
 * ⌘O: the same apps as the Open menu, keyboard first. With a file open, editors open it at
 * its line and the rest get the folder; Enter opens the selected app, ⇧Enter the folder instead.
 */
export function OpenInSwitcher() {
  const t = useT()
  const detection = useOpenInApps()
  const snapshot = useStore((s) => s.snapshot!)
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  // A cloud workspace has no folder here to open.
  const ws = snapshot.workspaces.find((w) => w.id === selectedId && w.state !== 'archived' && w.state !== 'history' && !w.cloud)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listId = useId()
  const platform = snapshot.platform
  const custom = snapshot.settings.editorCommand.trim()
  const resolved = useDefaultApp(detection)
  const defaultId: OpenInChoice | null = resolved.kind === 'app' ? resolved.app.id : resolved.kind === 'custom' ? 'custom' : null
  const root = ws ? wsPath(ws) : ''
  const file = ws ? viewedFile(ws.id) : undefined

  useEffect(() => {
    void refreshOpenInApps(true)
  }, [])

  const rows = useMemo(() => {
    const list: Row[] = []
    for (const app of foundApps(detection)) {
      const group = file && app.kind === 'editor' ? 'file' : 'folder'
      list.push({ key: app.id, choice: app.id, app, name: appLabel(app, platform, t), group, note: app.kind === 'files' && file ? t('openIn.revealNote', { file: baseName(file.path) }) : undefined })
    }
    if (custom) list.push({ key: 'custom', choice: 'custom', name: t('openIn.custom'), group: 'folder', note: custom })
    // Editors (the file group) first; the default first within the list once filtered.
    list.sort((a, b) => (a.group === b.group ? 0 : a.group === 'file' ? -1 : 1))
    const q = query.trim().toLowerCase()
    return q ? list.filter((row) => row.name.toLowerCase().includes(q)) : list
  }, [detection, file, custom, platform, query, t])

  // Start on the default app.
  useEffect(() => {
    const at = rows.findIndex((row) => row.choice === defaultId)
    setIndex(at >= 0 ? at : 0)
  }, [rows, defaultId])

  const pick = (row: Row | undefined, folderOnly = false) => {
    if (!row || !ws) return
    openOverlay(null)
    const target: OpenInTarget = folderOnly || !file ? { folder: root } : { folder: root, file: joinWorkspace(root, file.path), ...(file.line ? { line: file.line } : {}) }
    void openWith(row.choice, target)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(i + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(rows[index], e.shiftKey)
    }
  }

  const heading = (group: Row['group']) =>
    group === 'file' && file ? (file.line ? t('openIn.switcher.fileAtLine', { file: file.path, line: file.line }) : file.path) : t('openIn.switcher.folder', { name: ws?.name ?? '' })

  const options: ListboxOption[] = rows.map((row, n) => ({
    value: row.key,
    label: row.name,
    group: heading(row.group),
    leading: <AppIcon id={row.choice === 'custom' ? 'custom' : row.choice || 'files'} />,
    description: row.note ? <span className={row.choice === 'custom' ? 'mono' : undefined}>{row.note}</span> : undefined,
    trailing:
      row.choice === defaultId || n === index ? (
        <span className="open-in-hint">
          {row.choice === defaultId && <Tag>{t('openIn.default')}</Tag>}
          {n === index && <Kbd>↵</Kbd>}
        </span>
      ) : undefined
  }))
  const showList = ws && detection && rows.length > 0

  return (
    <Dialog
      title={t('openIn.switcher.label')}
      hideTitle
      onClose={() => openOverlay(null)}
      className="open-in-switcher"
      toolbar={
        <div className="open-in-search">
          <Search size={15} aria-hidden />
          <TextInput
            autoFocus
            className="open-in-query"
            role="combobox"
            aria-expanded={Boolean(showList)}
            aria-controls={showList ? listId : undefined}
            aria-activedescendant={showList ? `${listId}-${index}` : undefined}
            aria-autocomplete="list"
            aria-label={t('openIn.switcher.placeholder')}
            placeholder={t('openIn.switcher.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <Kbd>{openInShortcut(platform)}</Kbd>
        </div>
      }
      footer={
        ws ? (
          <div className="open-in-foot faint small">
            <span>↑↓ {t('openIn.switcher.choose')}</span>
            <span>↵ {t('openIn.switcher.open')}</span>
            {file && <span>⇧↵ {t('openIn.switcher.folderInstead')}</span>}
          </div>
        ) : undefined
      }
    >
      {!ws && <div className="faint pad">{t('openIn.switcher.noWorkspace')}</div>}
      {ws && !detection && <div className="faint pad">{t('openIn.looking')}</div>}
      {ws && detection && rows.length === 0 && <div className="faint pad">{t('openIn.switcher.noMatches')}</div>}
      {showList && (
        <Listbox
          id={listId}
          label={t('openIn.switcher.label')}
          focusable={false}
          options={options}
          activeIndex={index}
          onActiveChange={setIndex}
          onChange={(key) => pick(rows.find((row) => row.key === key))}
        />
      )}
    </Dialog>
  )
}
