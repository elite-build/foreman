import { Check, ChevronDown, Cloud, ExternalLink, History, Minimize2, Play, Plus, Radar, Square, SquareTerminal, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PROBE_EVERY_MS, probeNote, probeText, type PreviewProbe } from '../../../shared/previewProbe'
import { shellName, type ShellChoice } from '../../../shared/shells'
import { normalizeTabName, restoredWhen, type SavedTerminalTab, type TerminalTabSave } from '../../../shared/terminalTabs'
import type { PreviewUrl, RunScript, Workspace } from '../../../shared/types'
import { useT } from '../i18n'
import { api, attempt, bridge, getState, modKey, onUiCommand, openSettingsPage, showBottomPanel, showError, toggleTerminalFullscreen, useStore } from '../store'
import { SetupLog } from './SetupLog'
import { NewTerminalMenu } from './NewTerminalMenu'
import { CommandsMenu, useSavedCommandRunner } from './SavedCommands'
import type { SavedCommand } from '../../../shared/savedCommands'
import { lucideIcon } from './Sidebar'
import { TerminalMenu } from './TerminalMenu'
import { TerminalView, type RestoredOutput, type TerminalReading } from './TerminalView'
import { Button, ChipButton, IconButton, Kbd, LinkButton, MenuButton, MenuItem, SplitButton, Status, Tab, TabList, TabPanel, Tabs, TextInput } from '../ui'

type PanelTab = 'run' | 'setup' | `term-${number}`

const NO_SCRIPTS: RunScript[] = []
const NO_URLS: PreviewUrl[] = []
// Selections sent to chat from the Run tab say "From Run".
const RUN_SOURCE = { kind: 'run' } as const
// While output keeps arriving, terminal tabs are saved for restore at most this often (O3).
const SAVE_EVERY_MS = 3000

/** A terminal tab (O3): its number, optional name, zoom, and output restored from before a restart. */
interface TermTab {
  n: number
  name?: string
  zoom: number
  // A shell picked for this tab only from the new-terminal menu (O4, Windows); unset follows Settings → Shell.
  shell?: ShellChoice
  // O9: a saved command's id; the tab's shell types it in. Not saved: after a restart the tab is a plain one.
  saved?: string
  // G4 O9: the last command's exit status in this tab, as the shell reported it (OSC 133 or Foreman's marker).
  exit?: number
  // Shown dimmed; `started` once Start shell opened a new shell below it.
  restored?: RestoredOutput & { started: boolean }
}

/** A saved tab comes back dimmed under "the process was not kept"; one that never printed anything (never opened) comes back as a plain tab. */
function fromSaved(saved: SavedTerminalTab): TermTab {
  const tab: TermTab = { n: saved.n, name: saved.name, zoom: saved.zoom ?? 1, ...(saved.shell ? { shell: saved.shell } : {}) }
  // G3: with its colours (O3) and, after a clean quit, when Foreman quit (O10).
  return saved.scrollback
    ? { ...tab, restored: { at: saved.savedAt, text: saved.scrollback, cwd: saved.cwd, started: false, ...(saved.styled ? { styled: true } : {}), ...(saved.quitAt ? { quitAt: saved.quitAt } : {}) } }
    : tab
}

/** Inline rename in a tab: Enter keeps the name, Esc cancels, and an empty name goes back to "Terminal {n}". */
function TabRename({ value, label, onDone }: { value: string; label: string; onDone: (name: string | null) => void }) {
  const done = useRef(false)
  const finish = (name: string | null) => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  return (
    <TextInput
      compact
      className="tab-rename"
      aria-label={label}
      defaultValue={value}
      spellCheck={false}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(e.currentTarget.value)
        else if (e.key === 'Escape') {
          e.stopPropagation()
          finish(null)
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  )
}

/** Scripts the Run button offers: hidden ones left out, the default one first. */
function visibleScripts(all: RunScript[]): RunScript[] {
  const shown = all.filter((s) => !s.hidden && s.command.trim())
  return [...shown.filter((s) => s.default), ...shown.filter((s) => !s.default)]
}

// Mirrors the main process's substitution, for display only.
function expandPorts(template: string, port: number): string {
  return template
    .replace(/\$\(\(\s*(?:FOREMAN|SWITCHYARD)_PORT\s*\+\s*(\d+)\s*\)\)/g, (_, n: string) => String(port + Number(n)))
    .replace(/\$\{?(?:FOREMAN|SWITCHYARD)_PORT\}?|%(?:FOREMAN|SWITCHYARD)_PORT%/g, String(port))
}

function ScriptIcon({ script, size }: { script: RunScript; size: number }) {
  const Icon = lucideIcon(script.icon) ?? Play
  return <Icon size={size} />
}

/**
 * Whether a run script's preview URL answers. It looks while the script runs (and when you press Check), never
 * otherwise, and says nothing until the first look. An answer only means something is listening.
 */
function PreviewCheck({ workspaceId, script, running }: { workspaceId: string; script: string; running: boolean }) {
  const t = useT()
  const [probe, setProbe] = useState<PreviewProbe | undefined>()
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const check = async () => {
    setBusy(true)
    const result = await attempt(() => api.probePreview(workspaceId, script))
    setBusy(false)
    if (result) setProbe(result)
  }
  // A different script has a different URL: forget the old answer.
  useEffect(() => setProbe(undefined), [script])
  const latest = useRef(check)
  latest.current = check
  useEffect(() => {
    if (!running) return
    const first = setTimeout(() => void latest.current(), 2000)
    const every = setInterval(() => void latest.current(), PROBE_EVERY_MS)
    return () => {
      clearTimeout(first)
      clearInterval(every)
    }
  }, [running, script, workspaceId])
  useEffect(() => {
    if (!probe) return
    const tick = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(tick)
  }, [probe])
  const text = probeText(probe, now, t)
  return (
    <div className="run-probe">
      {probe && probe.state !== 'skipped' && <Status compact tone={probe.state === 'responding' ? 'ok' : 'error'} label={t(probe.state === 'responding' ? 'bottomPanel.probe.responding' : 'bottomPanel.probe.notResponding')} />}
      {probe && <code className="mono small">{probe.url.replace(/^https?:\/\//, '')}</code>}
      {text && (
        <span className="faint small" title={probe?.reason}>
          {text}
          {probe?.state === 'responding' && probe.status ? ` (HTTP ${probe.status})` : ''}
        </span>
      )}
      <span className="spacer" />
      <LinkButton disabled={busy} onClick={() => void check()}>
        {busy ? t('bottomPanel.checking') : t('bottomPanel.check')}
      </LinkButton>
      {probe && <span className="faint small run-probe-note">{probeNote(t)}</span>}
    </div>
  )
}

export function BottomPanel({ workspace, visible }: { workspace: Workspace; visible: boolean }) {
  const values = useStore((s) => s.snapshot!.repoSettings[workspace.repoId]?.values)
  const spotlightOn = useStore((s) => s.snapshot!.spotlight[workspace.repoId] === workspace.id)
  const platform = useStore((s) => s.snapshot!.platform)
  const autoRun = useStore((s) => s.autoRun[workspace.id])
  const scripts = visibleScripts(values?.runScripts ?? NO_SCRIPTS)
  const previewUrls = values?.previewUrls ?? NO_URLS
  // Phase 4: a cloud workspace's terminals and run scripts are in its sandbox; previews, spotlight and this
  // computer's shells don't apply there.
  const cloud = Boolean(workspace.cloud)
  // A direct workspace already is the repository folder; there's nothing to mirror.
  const spotlightMode = Boolean(values?.spotlightTesting) && !workspace.direct && !cloud
  const t = useT()
  const [tab, setTab] = useState<PanelTab>(workspace.state === 'ready' ? 'run' : 'setup')
  const [terminals, setTerminals] = useState<TermTab[]>([{ n: 1, zoom: 1 }])
  const [runZoom, setRunZoom] = useState(1)
  const [renaming, setRenaming] = useState<number | null>(null)
  const [tabMenu, setTabMenu] = useState<{ n: number; x: number; y: number } | null>(null)
  // The tab menu's Find… for terminal n: a nonce the terminal opens its find bar on.
  const [findRequest, setFindRequest] = useState<{ n: number; nonce: number } | null>(null)
  const fullscreen = useStore((s) => s.terminalFullscreen === workspace.id)
  const copyOnSelect = useStore((s) => s.snapshot!.settings.terminalCopyOnSelect ?? false)
  // Each run mounts a fresh terminal; null when nothing has run yet.
  const [run, setRun] = useState<{ key: number; script: string } | null>(null)
  // Terminal tabs start their shell the first time they are shown.
  const [visited, setVisited] = useState<Set<PanelTab>>(new Set())
  if (!visited.has(tab)) setVisited(new Set(visited).add(tab))
  const visitedRef = useRef(visited)
  visitedRef.current = visited
  const [runPty, setRunPty] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const mod = modKey(platform)
  const ready = workspace.state !== 'creating' && workspace.state !== 'error' && workspace.state !== 'history'

  // Show setup output while the workspace is being prepared.
  useEffect(() => {
    if (workspace.state === 'creating' || workspace.state === 'setting-up' || workspace.state === 'error') setTab('setup')
  }, [workspace.state])

  const openScriptSettings = () => openSettingsPage({ section: 'repo', repoId: workspace.repoId, tab: 'scripts' })

  const launch = (script: RunScript) => {
    // Hidden by the user: a run brings it back so its output is on screen.
    if (!getState().bottomPanelOpen) showBottomPanel()
    setRun({ key: Date.now(), script: script.name })
    setRunning(true)
    setTab('run')
  }

  const start = async (script: RunScript | undefined = scripts[0]) => {
    if (spotlightMode) {
      // Spotlight: mirror this workspace into the repo root, then run from there.
      const ok = await attempt(async () => (await api.setSpotlight(workspace.id, true), true))
      if (!ok) return
      if (!script) {
        setTab('setup')
        return
      }
    } else if (!script) {
      openScriptSettings()
      return
    }
    launch(script)
  }
  const stop = () => {
    if (runPty) bridge.send.ptyKill(runPty)
    setRunning(false)
    if (spotlightOn) void attempt(() => api.setSpotlight(workspace.id, false))
  }

  // Shortcut and auto-run handlers read the latest render's state.
  const latest = useRef({ start, stop, launch, running, spotlightOn, scripts, ready })
  latest.current = { start, stop, launch, running, spotlightOn, scripts, ready }

  useEffect(
    () =>
      onUiCommand((command, workspaceId) => {
        if (workspaceId !== workspace.id) return
        if (command === 'show-setup-log') return setTab('setup')
        if (command !== 'run') return
        const now = latest.current
        if (now.running || now.spotlightOn) now.stop()
        else void now.start()
      }),
    [workspace.id]
  )

  // Setup finished and the repository runs its default script afterwards.
  const handledAutoRun = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (autoRun === undefined || autoRun === handledAutoRun.current) return
    handledAutoRun.current = autoRun
    const now = latest.current
    if (now.ready && now.scripts[0]) now.launch(now.scripts[0])
  }, [autoRun])

  // ---- terminal tabs saved for after a restart (O3) ----
  // Reads the end of each mounted terminal's output.
  const readers = useRef(new Map<number, () => TerminalReading>())
  // Output arrived since the last save.
  const dirty = useRef(false)
  // Nothing is saved until the saved tabs have been read, so a fresh launch never overwrites them.
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let live = true
    api
      .savedTerminals(workspace.id)
      .then((saved) => {
        // A terminal the user already opened in the meantime wins.
        if (!live || !saved || [...visitedRef.current].some((v) => v.startsWith('term-'))) return
        setTerminals(saved.map(fromSaved))
      })
      .catch(() => undefined)
      .finally(() => live && setLoaded(true))
    return () => {
      live = false
    }
  }, [workspace.id])

  const save = useRef(() => {})
  save.current = () => {
    // A workspace without a worktree shows no terminals; leave what was saved for it alone.
    if (!loaded || !ready) return
    dirty.current = false
    const now = Date.now()
    const tabs: TerminalTabSave[] = terminals.map((term) => {
      const waiting = term.restored && !term.restored.started
      // G3 · O3: the output with its colours, and the folder the shell last reported (main checks it exists).
      const read = waiting ? undefined : readers.current.get(term.n)?.()
      const styled = waiting ? Boolean(term.restored!.styled) : read ? read.styled : Boolean(term.restored?.styled)
      const cwd = waiting ? term.restored!.cwd : read?.cwd
      return {
        n: term.n,
        ...(term.name ? { name: term.name } : {}),
        ...(term.zoom !== 1 ? { zoom: term.zoom } : {}),
        ...(term.shell ? { shell: term.shell } : {}),
        ...(cwd ? { cwd } : {}),
        ...(styled ? { styled: true } : {}),
        // G3 · O10: a restored tab nobody started still ended at that quit.
        ...(waiting && term.restored!.quitAt ? { quitAt: term.restored!.quitAt } : {}),
        // A restored tab nobody started keeps its old output and time.
        savedAt: waiting ? term.restored!.at : now,
        scrollback: waiting ? term.restored!.text : (read?.text ?? term.restored?.text ?? '')
      }
    })
    bridge.send.saveTerminals(workspace.id, tabs)
  }
  // Tabs added, closed, renamed, zoomed or started: save now. Closing a tab deletes its saved output.
  useEffect(() => {
    save.current()
  }, [terminals, loaded])
  // Output: save every few seconds while it keeps coming.
  useEffect(() => {
    const timer = setInterval(() => dirty.current && save.current(), SAVE_EVERY_MS)
    return () => clearInterval(timer)
  }, [])
  const markDirty = useCallback(() => {
    dirty.current = true
  }, [])

  const updateTerminal = (n: number, patch: Partial<TermTab>) => setTerminals((all) => all.map((term) => (term.n === n ? { ...term, ...patch } : term)))
  const addTerminal = (shell?: ShellChoice) => {
    const n = Math.max(0, ...terminals.map((term) => term.n)) + 1
    setTerminals([...terminals, { n, zoom: 1, ...(shell ? { shell } : {}) }])
    setTab(`term-${n}`)
  }
  // O9: a saved command always opens a new tab named after it, and brings the panel back if it was hidden.
  const termsRef = useRef(terminals)
  termsRef.current = terminals
  const addCommandTab = (command: SavedCommand) => {
    if (!getState().bottomPanelOpen) showBottomPanel()
    const n = Math.max(0, ...termsRef.current.map((term) => term.n)) + 1
    setTerminals((all) => [...all, { n, zoom: 1, name: normalizeTabName(command.name), saved: command.id }])
    setTab(`term-${n}`)
  }
  const commands = useSavedCommandRunner(workspace.id, workspace.repoId, addCommandTab)
  const repoName = useStore((s) => s.snapshot!.repos.find((r) => r.id === workspace.repoId)?.name ?? '')
  const closeTerminal = (n: number) => {
    const rest = terminals.filter((term) => term.n !== n)
    setTerminals(rest)
    readers.current.delete(n)
    if (tab === `term-${n}`) setTab(rest.length ? `term-${rest[rest.length - 1].n}` : 'run')
  }
  const renameTerminal = (n: number, name: string | null) => {
    setRenaming(null)
    if (name !== null) updateTerminal(n, { name: normalizeTabName(name) })
  }
  // A tab opened in another shell is named after it ("Git Bash") until renamed.
  const shellLabel = (term: TermTab) => (term.shell ? shellName(term.shell, t) : undefined)
  const tabName = (term: TermTab) => term.name ?? shellLabel(term) ?? t('terminalChat.source.terminal', { n: term.n })
  const startShell = (term: TermTab) => {
    if (term.restored) updateTerminal(term.n, { restored: { ...term.restored, started: true } })
  }
  const menuTerm = tabMenu ? terminals.find((term) => term.n === tabMenu.n) : undefined
  const findIn = (n: number) => {
    setTab(`term-${n}`)
    setFindRequest({ n, nonce: Date.now() })
  }
  const toggleFullscreen = (show: PanelTab) => {
    setTab(show)
    toggleTerminalFullscreen(workspace.id)
  }

  // Esc leaves fullscreen, unless a terminal, its find bar, a rename or a menu has it (Esc matters to programs in a shell).
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if ((e.target as Element | null)?.closest?.('.terminal, .term-find, .tab-rename') || document.querySelector('.terminal-menu')) return
      toggleTerminalFullscreen(workspace.id, false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, workspace.id])

  const openPreview = (index: number) => {
    void attempt(() => api.openPreview(workspace.id, index))
  }

  // The script the Run tab is about: the one last run, else the default one.
  const previewScript = scripts.find((s) => s.name === run?.script) ?? scripts[0]
  const runLabel = spotlightMode ? t('bottomPanel.startSpotlight') : t('bottomPanel.run')
  const runIcon = spotlightMode ? <Radar size={11} /> : <Play size={11} />
  const runTitle = spotlightMode
    ? t('bottomPanel.spotlightTitle')
    : scripts[0]
      ? t('bottomPanel.runTitle', { name: scripts[0].name, command: scripts[0].command })
      : t('bottomPanel.noRunScriptTitle')

  const previewTitle = previewUrls[0]?.name ? t('bottomPanel.openPreview', { name: previewUrls[0].name, key: `${mod}⇧B` }) : t('bottomPanel.openPreviewDefault', { key: `${mod}⇧B` })
  const runButtonLabel = (
    <>
      <span className="btn-label">{runLabel}</span> <Kbd>{mod}R</Kbd>
    </>
  )

  return (
    <Tabs value={tab} onChange={(next) => setTab(next as PanelTab)} variant="chat" className="bottom-panel" role="region" aria-label={t('bottomPanel.label')}>
      <div className="bottom-tabs">
        <TabList label={t('bottomPanel.tabs')} className="bottom-tablist">
          <Tab value="run" title={run ? t('bottomPanel.lastRun', { script: run.script }) : undefined}>
            {t('bottomPanel.tab.run')}
          </Tab>
          <Tab value="setup">{t('bottomPanel.tab.setup')}</Tab>
          {terminals.map((term) => {
            const { n } = term
            const name = tabName(term)
            const waiting = term.restored && !term.restored.started
            return (
              <Tab
                key={n}
                value={`term-${n}`}
                className="bottom-tab"
                title={name}
                onDoubleClick={() => setRenaming(n)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setTabMenu({ n, x: e.clientX, y: e.clientY })
                }}
                editor={renaming === n ? <TabRename value={term.name ?? ''} label={t('terminal.rename')} onDone={(value) => renameTerminal(n, value)} /> : undefined}
                actions={
                  <IconButton label={t('terminal.closeTab', { name })} onClick={() => closeTerminal(n)}>
                    <X size={11} />
                  </IconButton>
                }
              >
                <SquareTerminal size={12} className="term-icon" />
                {cloud && (
                  <span className="term-cloud" title={t('cloud.terminal.tabTitle')} aria-label={t('cloud.terminal.tabTitle')}>
                    <Cloud size={11} />
                  </span>
                )}
                {term.name || term.shell ? (
                  <span className="term-name">{name}</span>
                ) : (
                  <>
                    <span className="term-word">{t('bottomPanel.tab.terminalWord')} </span>
                    {n}
                  </>
                )}
                {waiting && (
                  <span className="term-restored-icon" title={t('terminal.restoredTitle', { time: restoredWhen(term.restored!.at, Date.now(), t.locale) })}>
                    <History size={11} />
                  </span>
                )}
                {term.saved && term.exit !== undefined && (
                  <span
                    className={`term-exit ${term.exit === 0 ? 'ok' : 'fail'}`}
                    title={term.exit === 0 ? t('commands.exit.ok') : t('commands.exit.fail', { code: term.exit })}
                    aria-label={term.exit === 0 ? t('commands.exit.ok') : t('commands.exit.fail', { code: term.exit })}
                  >
                    {term.exit === 0 ? <Check size={11} /> : <X size={11} />}
                  </span>
                )}
              </Tab>
            )
          })}
        </TabList>
        <IconButton label={t('bottomPanel.newTerminal')} onClick={() => addTerminal()} disabled={!ready}>
          <Plus size={14} />
        </IconButton>
        {platform === 'win32' && !cloud && <NewTerminalMenu disabled={!ready} onPick={addTerminal} />}
        <span className="spacer" />
        <CommandsMenu repoId={workspace.repoId} repoName={repoName} disabled={!ready} onPick={commands.run} />
        {fullscreen && (
          <IconButton label={t('terminal.exitFullscreen', { key: `${mod}⇧J` })} onClick={() => toggleTerminalFullscreen(workspace.id, false)}>
            <Minimize2 size={13} />
          </IconButton>
        )}
        {!cloud && (
          <span className="preview-btns">
            <IconButton label={previewTitle} onClick={() => openPreview(0)} disabled={!ready}>
              <ExternalLink size={13} />
            </IconButton>
            {previewUrls.length > 1 && (
              <MenuButton className="preview-more" menuClassName="bottom-menu" look="icon" label={t('bottomPanel.choosePreview')} trigger={<ChevronDown size={11} />} disabled={!ready}>
                {previewUrls.map((preview, i) => (
                  <MenuItem
                    key={`${preview.name}-${i}`}
                    icon={<ExternalLink size={14} />}
                    description={<span className="mono">{expandPorts(preview.url, workspace.portBase)}</span>}
                    hint={i === 0 ? `${mod}⇧B` : undefined}
                    onSelect={() => openPreview(i)}
                  >
                    {preview.name || t('bottomPanel.previewN', { n: i + 1 })}
                  </MenuItem>
                ))}
              </MenuButton>
            )}
          </span>
        )}
        {running || spotlightOn ? (
          <Button size="sm" icon={<Square size={11} />} onClick={stop} title={`${spotlightOn ? t('bottomPanel.stopSpotlight') : t('common.stop')} (${mod}R)`}>
            <span className="btn-label">{spotlightOn ? t('bottomPanel.stopSpotlight') : t('common.stop')}</span> <Kbd>{mod}R</Kbd>
          </Button>
        ) : scripts.length > 1 ? (
          <SplitButton
            size="sm"
            label={
              <>
                {runIcon} {runButtonLabel}
              </>
            }
            menuLabel={t('bottomPanel.chooseRunScript')}
            onClick={() => void start()}
            disabled={!ready}
            title={runTitle}
          >
            {scripts.map((script, i) => (
              <MenuItem
                key={script.name}
                icon={<ScriptIcon script={script} size={14} />}
                description={<span className="mono">{script.command}</span>}
                hint={i === 0 ? `${mod}R` : undefined}
                onSelect={() => void start(script)}
              >
                {script.name}
              </MenuItem>
            ))}
          </SplitButton>
        ) : (
          <Button size="sm" icon={runIcon} onClick={() => void start()} disabled={!ready} title={runTitle}>
            {runButtonLabel}
          </Button>
        )}
      </div>
      <div className="bottom-body">
        <TabPanel value="run" keepMounted className="fill">
          {!cloud && previewScript?.previewUrl?.trim() && <PreviewCheck workspaceId={workspace.id} script={previewScript.name} running={running} />}
          {run !== null ? (
            <TerminalView
              key={run.key}
              workspaceId={workspace.id}
              kind="run"
              command={run.script}
              chatSource={RUN_SOURCE}
              zoom={runZoom}
              onZoom={setRunZoom}
              visible={visible && tab === 'run'}
              onSpawn={setRunPty}
              onExit={() => setRunning(false)}
            />
          ) : (
            <div className="panel-empty run-empty">
              <IconButton className="run-big" label={runLabel} onClick={() => void start()} disabled={!ready}>
                <Play size={22} />
              </IconButton>
              {scripts[0] ? (
                <>
                  <span className="faint">
                    {t.rich('bottomPanel.readyToRun', { command: <span key="command" className="mono">{scripts[0].command}</span>, key: `${mod}R` })}
                  </span>
                  {scripts.length > 1 && (
                    <div className="run-others">
                      {scripts.slice(1).map((script) => (
                        <ChipButton key={script.name} onClick={() => void start(script)} disabled={!ready} title={script.command}>
                          <ScriptIcon script={script} size={11} /> {script.name}
                        </ChipButton>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <span className="faint">{t('bottomPanel.noRunScript')}</span>
                  <Button size="sm" onClick={openScriptSettings}>
                    {t('bottomPanel.openScriptsSettings')}
                  </Button>
                </>
              )}
            </div>
          )}
        </TabPanel>
        <TabPanel value="setup" keepMounted className="fill">
          <SetupLog workspace={workspace} />
        </TabPanel>
        {ready &&
          terminals
            .filter((term) => visited.has(`term-${term.n}`))
            .map((term) => {
              const { n } = term
              return (
                <TabPanel key={n} value={`term-${n}`} keepMounted className="fill">
                  <TerminalView
                    workspaceId={workspace.id}
                    kind={term.saved ? 'saved' : 'shell'}
                    command={term.saved ?? term.shell}
                    onCommandStatus={term.saved ? (exit) => updateTerminal(n, { exit }) : undefined}
                    visible={visible && tab === `term-${n}`}
                    chatSource={{ kind: 'terminal', n, ...(term.name || term.shell ? { name: tabName(term) } : {}) }}
                    zoom={term.zoom}
                    onZoom={(zoom) => updateTerminal(n, { zoom })}
                    restored={term.restored}
                    waiting={Boolean(term.restored && !term.restored.started)}
                    onStartShell={() => startShell(term)}
                    findRequest={findRequest?.n === n ? findRequest.nonce : 0}
                    onRename={() => setRenaming(n)}
                    onClose={() => closeTerminal(n)}
                    onOutput={markDirty}
                    onReader={(read) => (read ? readers.current.set(n, read) : readers.current.delete(n))}
                  />
                </TabPanel>
              )
            })}
      </div>
      {commands.dialog}
      {menuTerm && tabMenu && (
        // The tab's own right-click menu: the tab entries of the terminal menu (O3).
        <TerminalMenu
          x={tabMenu.x}
          y={tabMenu.y}
          label={tabName(menuTerm)}
          dismiss={() => setTabMenu(null)}
          tab={{
            onRename: () => setRenaming(menuTerm.n),
            fullscreen,
            onFullscreen: () => toggleFullscreen(`term-${menuTerm.n}`),
            copyOnSelect,
            onCopyOnSelect: (on) => void api.updateSettings({ terminalCopyOnSelect: on }).catch(showError),
            zoom: menuTerm.zoom,
            onZoom: (zoom) => updateTerminal(menuTerm.n, { zoom }),
            onFind: () => findIn(menuTerm.n),
            onClose: () => closeTerminal(menuTerm.n)
          }}
        />
      )}
    </Tabs>
  )
}
