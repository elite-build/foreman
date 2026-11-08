import { Check, ChevronDown, Cloud, ExternalLink, History, Maximize2, MessageSquarePlus, Minimize2, Play, Radar, SlidersHorizontal, Square, SquareTerminal, Wrench, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { PROBE_EVERY_MS, probeNote, probeText, type PreviewProbe } from '../../../shared/previewProbe'
import { DEFAULT_PROMPT_TEMPLATES, SETUP_REPO_TEMPLATE_ID } from '../../../shared/promptTemplates'
import { shellName, type ShellChoice } from '../../../shared/shells'
import { normalizeTabName, restoredWhen, type SavedTerminalTab, type TerminalTabSave } from '../../../shared/terminalTabs'
import type { PreviewUrl, RunScript, Workspace } from '../../../shared/types'
import { useT } from '../i18n'
import { activeSessionId, api, attempt, bridge, fillComposer, getState, modKey, onUiCommand, openSettingsPage, showBottomPanel, toggleTerminalFullscreen, useStore } from '../store'
import { SetupLog } from './SetupLog'
import { NewMenu } from './NewTerminalMenu'
import { useSavedCommandRunner } from './SavedCommands'
import type { SavedCommand } from '../../../shared/savedCommands'
import { lucideIcon } from './Sidebar'
import { TerminalView, type RestoredOutput, type TerminalReading } from './TerminalView'
import { Button, CardButton, IconButton, Kbd, LinkButton, MenuButton, MenuItem, Spinner, Status, Tab, TabList, TabPanel, Tabs, TextInput } from '../ui'

// 'run' stands for the Run entry while the repository has no run script; each script is `run:<name>`.
type PanelTab = 'run' | 'setup' | `run:${string}` | `term-${number}`

const runTab = (name: string): PanelTab => `run:${name}`

const NO_SCRIPTS: RunScript[] = []
const NO_URLS: PreviewUrl[] = []
// Selections sent to chat from a run script say "From Run".
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

/** One run script's run. Several scripts can run at once, each in its own terminal; a new `key` mounts a fresh one. */
interface ScriptRun {
  key: number
  pty: string | null
  running: boolean
  // How a run that ended by itself ended; unset while it runs and after Stop.
  exit?: number
}

/** A saved tab comes back dimmed under "the process was not kept"; one that never printed anything (never opened) comes back as a plain tab. */
function fromSaved(saved: SavedTerminalTab): TermTab {
  const tab: TermTab = { n: saved.n, name: saved.name, zoom: saved.zoom ?? 1, ...(saved.shell ? { shell: saved.shell } : {}) }
  // G3: with its colours (O3) and, after a clean quit, when Foreman quit (O10).
  return saved.scrollback
    ? { ...tab, restored: { at: saved.savedAt, text: saved.scrollback, cwd: saved.cwd, started: false, ...(saved.styled ? { styled: true } : {}), ...(saved.quitAt ? { quitAt: saved.quitAt } : {}) } }
    : tab
}

/** One way on from the Run tab's launcher: a card whose name is its title, described by the line under it. */
function LaunchCard({ icon, title, children, disabled, onClick }: { icon: ReactNode; title: string; children: ReactNode; disabled?: boolean; onClick: () => void }) {
  const id = useId()
  return (
    <CardButton size="sm" className="run-launch-card" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} disabled={disabled} onClick={onClick}>
      <strong id={`${id}-title`} className="run-launch-title">
        {icon}
        {title}
      </strong>
      <span id={`${id}-body`} className="faint small">
        {children}
      </span>
    </CardButton>
  )
}

/** Inline rename of a terminal, in its tab: Enter keeps the name, Esc cancels, and an empty name goes back to "Terminal {n}". */
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

/** Scripts the Run list offers: hidden ones left out, the default one first. */
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

/**
 * The run scripts, setup and terminals: a header of tabs, + for a new terminal or saved command, and the selected
 * one's actions, over its output. Several run scripts can run at once. With no run script and nothing open, the Run
 * tab is a launcher and is the only tab; Setup's tab is an icon, named when it's selected.
 */
export function BottomPanel({ workspace, visible }: { workspace: Workspace; visible: boolean }) {
  const values = useStore((s) => s.snapshot!.repoSettings[workspace.repoId]?.values)
  const spotlightOn = useStore((s) => s.snapshot!.spotlight[workspace.repoId] === workspace.id)
  const platform = useStore((s) => s.snapshot!.platform)
  const autoRun = useStore((s) => s.autoRun[workspace.id])
  const sessionId = useStore((s) => activeSessionId(s, workspace.id))
  const setupTemplate =
    useStore((s) => s.snapshot!.settings.promptTemplates.find((p) => p.id === SETUP_REPO_TEMPLATE_ID)) ?? DEFAULT_PROMPT_TEMPLATES.find((p) => p.id === SETUP_REPO_TEMPLATE_ID)!
  const scripts = visibleScripts(values?.runScripts ?? NO_SCRIPTS)
  const previewUrls = values?.previewUrls ?? NO_URLS
  // Phase 4: a cloud workspace's terminals and run scripts are in its sandbox; previews, spotlight and this
  // computer's shells don't apply there.
  const cloud = Boolean(workspace.cloud)
  // A direct workspace already is the repository folder; there's nothing to mirror.
  const spotlightMode = Boolean(values?.spotlightTesting) && !workspace.direct && !cloud
  const t = useT()
  const [tab, setTab] = useState<PanelTab>(workspace.state === 'ready' ? 'run' : 'setup')
  // None until one is opened: an empty panel is the Run tab's launcher.
  const [terminals, setTerminals] = useState<TermTab[]>([])
  const [runZoom, setRunZoom] = useState(1)
  const [renaming, setRenaming] = useState<number | null>(null)
  const fullscreen = useStore((s) => s.workspaceFocus[workspace.id] === 'terminal')
  const [runs, setRuns] = useState<Record<string, ScriptRun>>({})
  const mod = modKey(platform)
  const ready = workspace.state !== 'creating' && workspace.state !== 'error' && workspace.state !== 'history'

  // The scripts in the list: the repository's, then any still running whose script has left the settings (its
  // terminal stays until it stops; unmounting it would end the process).
  const listed = [...scripts, ...Object.keys(runs).filter((name) => runs[name].running && !scripts.some((s) => s.name === name)).map((name): RunScript => ({ name, command: '', icon: '' }))]
  const runValues: PanelTab[] = listed.length ? listed.map((s) => runTab(s.name)) : ['run']
  // What the header and body show: the chosen entry while it exists, else the first run script (or Run).
  const selected: PanelTab = tab === 'setup' || runValues.includes(tab) || terminals.some((term) => tab === `term-${term.n}`) ? tab : runValues[0]
  const selectedScript = listed.find((s) => runTab(s.name) === selected)
  const anyRunning = Object.values(runs).some((run) => run.running)
  // Nothing to switch between: the launcher offers Setup's log itself, so its tab waits.
  const launcher = !listed.length && !terminals.length && selected === 'run'

  // Terminal tabs start their shell the first time they are shown.
  const [visited, setVisited] = useState<Set<PanelTab>>(new Set())
  if (!visited.has(selected)) setVisited(new Set(visited).add(selected))
  const visitedRef = useRef(visited)
  visitedRef.current = visited

  // Show setup output while the workspace is being prepared.
  useEffect(() => {
    if (workspace.state === 'creating' || workspace.state === 'setting-up' || workspace.state === 'error') setTab('setup')
  }, [workspace.state])

  const openScriptSettings = () => openSettingsPage({ section: 'repo', repoId: workspace.repoId, tab: 'scripts' })

  const launch = (script: RunScript) => {
    // Hidden by the user: a run brings it back so its output is on screen.
    if (!getState().bottomPanelOpen) showBottomPanel()
    setRuns((all) => ({ ...all, [script.name]: { key: Date.now(), pty: null, running: true } }))
    setTab(runTab(script.name))
  }

  const start = async (script: RunScript | undefined) => {
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
  const stopSpotlight = () => void attempt(() => api.setSpotlight(workspace.id, false))
  const stop = (name: string) => {
    const run = runs[name]
    if (run?.pty) bridge.send.ptyKill(run.pty)
    setRuns((all) => (all[name] ? { ...all, [name]: { ...all[name], running: false, exit: undefined } } : all))
    // Spotlight ends with the last script running from it.
    if (spotlightOn && !Object.entries(runs).some(([other, r]) => other !== name && r.running)) stopSpotlight()
  }
  // A run that ended by itself keeps how it ended; one stopped by Stop already says it isn't running.
  const ended = (name: string, key: number, code: number) =>
    setRuns((all) => {
      const run = all[name]
      if (run?.key !== key) return all
      return { ...all, [name]: { ...run, running: false, exit: run.running ? code : undefined } }
    })
  // ⌘R: the selected script (else the default one) starts or stops.
  const toggle = () => {
    const script = selectedScript ?? scripts[0]
    if (script && runs[script.name]?.running) stop(script.name)
    else if (spotlightOn && !anyRunning) stopSpotlight()
    else void start(script)
  }

  // Shortcut and auto-run handlers read the latest render's state.
  const latest = useRef({ toggle, launch, scripts, ready })
  latest.current = { toggle, launch, scripts, ready }

  useEffect(
    () =>
      onUiCommand((command, workspaceId) => {
        if (workspaceId !== workspace.id) return
        if (command === 'show-setup-log') return setTab('setup')
        if (command === 'run') latest.current.toggle()
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
    if (selected === `term-${n}`) setTab(rest.length ? `term-${rest[rest.length - 1].n}` : 'run')
  }
  const renameTerminal = (n: number, name: string | null) => {
    setRenaming(null)
    if (name !== null) updateTerminal(n, { name: normalizeTabName(name) })
  }
  const openTerminal = () => (terminals.length ? setTab(`term-${terminals[0].n}`) : addTerminal())
  // A tab opened in another shell is named after it ("Git Bash") until renamed.
  const shellLabel = (term: TermTab) => (term.shell ? shellName(term.shell, t) : undefined)
  const tabName = (term: TermTab) => term.name ?? shellLabel(term) ?? t('terminalChat.source.terminal', { n: term.n })
  const startShell = (term: TermTab) => {
    if (term.restored) updateTerminal(term.n, { restored: { ...term.restored, started: true } })
  }

  const openPreview = (index: number) => {
    void attempt(() => api.openPreview(workspace.id, index))
  }

  const runLabel = spotlightMode ? t('bottomPanel.startSpotlight') : t('bottomPanel.run')
  const runIcon = spotlightMode ? <Radar size={11} /> : <Play size={11} />
  const runTitle = (script: RunScript) => (spotlightMode ? t('bottomPanel.spotlightTitle') : t('bottomPanel.runTitle', { name: script.name, command: script.command }))
  const previewTitle = previewUrls[0]?.name ? t('bottomPanel.openPreview', { name: previewUrls[0].name, key: `${mod}⇧B` }) : t('bottomPanel.openPreviewDefault', { key: `${mod}⇧B` })

  // A script's state in words: shown beside its name in the header, as a shape in the rail with the word in its tooltip.
  const runWord = (name: string): { tone: 'ok' | 'error'; label: string } | undefined => {
    const run = runs[name]
    if (run?.running) return { tone: 'ok', label: t('bottomPanel.running') }
    if (run?.exit !== undefined && run.exit !== 0) return { tone: 'error', label: t('bottomPanel.exited', { code: run.exit }) }
    return undefined
  }
  const setupBusy = workspace.state === 'creating' || workspace.state === 'setting-up'
  const setupWord = setupBusy
    ? t('workspaceView.state.settingUp')
    : workspace.state === 'setup-failed'
      ? t('workspaceView.state.setupFailed')
      : workspace.state === 'error'
        ? t('workspaceView.state.error')
        : undefined
  const tooltip = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ')

  // ---- the header: the tabs, +, then the selected one's actions ----
  let action: ReactNode = null
  if (selectedScript && runs[selectedScript.name]?.running) {
    const name = selectedScript.name
    action = (
      <Button size="sm" icon={<Square size={11} />} onClick={() => stop(name)} title={`${t('common.stop')} (${mod}R)`}>
        {t('common.stop')} <Kbd>{mod}R</Kbd>
      </Button>
    )
  }
  if (!action && spotlightOn && !anyRunning)
    action = (
      <Button size="sm" icon={<Square size={11} />} onClick={stopSpotlight} title={`${t('bottomPanel.stopSpotlight')} (${mod}R)`}>
        {t('bottomPanel.stopSpotlight')} <Kbd>{mod}R</Kbd>
      </Button>
    )
  // Without a run script, Run only does something in spotlight mode; otherwise the empty state offers the way on.
  else if (!action && (selectedScript || (selected === 'run' && spotlightMode)))
    action = (
      <Button size="sm" icon={runIcon} onClick={() => void start(selectedScript)} disabled={!ready} title={selectedScript ? runTitle(selectedScript) : t('bottomPanel.spotlightTitle')}>
        {runLabel} <Kbd>{mod}R</Kbd>
      </Button>
    )

  return (
    <Tabs value={selected} onChange={(next) => setTab(next as PanelTab)} variant="chat" className="bottom-panel" role="region" aria-label={t('bottomPanel.label')}>
      <div className="bottom-head">
        <TabList label={t('bottomPanel.tabs')} className="bottom-tabs">
          {listed.length ? (
            listed.map((script) => {
              const word = runWord(script.name)
              return (
                <Tab key={script.name} value={runTab(script.name)} title={tooltip(script.name, word?.label)}>
                  <ScriptIcon script={script} size={12} />
                  <span className="bottom-tab-label">{script.name}</span>
                  {word && <Status compact tone={word.tone} label={word.label} />}
                </Tab>
              )
            })
          ) : (
            <Tab value="run" title={t('bottomPanel.noRunScriptHeading')}>
              <Play size={12} />
              <span className="bottom-tab-label">{t('bottomPanel.tab.run')}</span>
            </Tab>
          )}
          {!launcher && (
            <Tab value="setup" title={tooltip(t('bottomPanel.tab.setup'), setupWord)}>
              <Wrench size={12} />
              <span className={selected === 'setup' ? 'bottom-tab-label' : 'sr-only'}>{t('bottomPanel.tab.setup')}</span>
              {setupBusy ? (
                <>
                  <Spinner size={11} />
                  <span className="sr-only">{setupWord}</span>
                </>
              ) : (
                setupWord && <Status compact tone="error" label={setupWord} />
              )}
            </Tab>
          )}
          {terminals.map((term) => {
            const { n } = term
            const name = tabName(term)
            const waiting = term.restored && !term.restored.started
            return (
              <Tab
                key={n}
                value={`term-${n}`}
                title={name}
                editor={renaming === n ? <TabRename value={term.name ?? ''} label={t('terminal.rename')} onDone={(value) => renameTerminal(n, value)} /> : undefined}
              >
                <SquareTerminal size={12} />
                {cloud && (
                  <span className="term-cloud" title={t('cloud.terminal.tabTitle')} aria-label={t('cloud.terminal.tabTitle')}>
                    <Cloud size={11} />
                  </span>
                )}
                <span className="bottom-tab-label">{name}</span>
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
        <NewMenu repoId={workspace.repoId} repoName={repoName} shells={platform === 'win32' && !cloud} disabled={!ready} onTerminal={addTerminal} onCommand={commands.run} />
        <span className="spacer" />
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
        <IconButton label={fullscreen ? t('terminal.exitFullscreen', { key: `${mod}⇧J` }) : t('terminal.fullscreen', { key: `${mod}⇧J` })} onClick={() => toggleTerminalFullscreen(workspace.id)}>
          {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </IconButton>
        {action}
      </div>
      <div className="bottom-main">
        <div className="bottom-body">
          {listed.map((script) => {
            const run = runs[script.name]
            const value = runTab(script.name)
            return (
              <TabPanel key={script.name} value={value} keepMounted className="fill">
                {!cloud && script.previewUrl?.trim() && <PreviewCheck workspaceId={workspace.id} script={script.name} running={Boolean(run?.running)} />}
                {run ? (
                  <TerminalView
                    key={run.key}
                    workspaceId={workspace.id}
                    kind="run"
                    command={script.name}
                    chatSource={RUN_SOURCE}
                    zoom={runZoom}
                    onZoom={setRunZoom}
                    visible={visible && selected === value}
                    onSpawn={(pty) => setRuns((all) => (all[script.name]?.key === run.key ? { ...all, [script.name]: { ...all[script.name], pty } } : all))}
                    onExit={(code) => ended(script.name, run.key, code)}
                  />
                ) : (
                  <div className="panel-empty run-empty">
                    <IconButton className="run-big" label={runTitle(script)} onClick={() => void start(script)} disabled={!ready}>
                      <Play size={22} />
                    </IconButton>
                    <span className="faint">{t.rich('bottomPanel.readyToRun', { command: <span key="command" className="mono">{script.command}</span>, key: `${mod}R` })}</span>
                  </div>
                )}
              </TabPanel>
            )
          })}
          {!listed.length && (
            <TabPanel value="run" className="fill">
              <div className="panel-empty run-launch">
                <strong>{t('bottomPanel.launch.heading')}</strong>
                <div className="run-launch-grid">
                  <LaunchCard icon={<SlidersHorizontal size={13} />} title={t('bottomPanel.setUpRunScript')} onClick={openScriptSettings}>
                    {t('bottomPanel.launch.runBody')}
                  </LaunchCard>
                  <LaunchCard
                    icon={<MessageSquarePlus size={13} />}
                    title={t('bottomPanel.suggestRunScript')}
                    disabled={!sessionId}
                    onClick={() => sessionId && fillComposer(workspace.id, sessionId, setupTemplate.body, setupTemplate.id)}
                  >
                    {t('bottomPanel.suggestRunScriptTitle')}
                  </LaunchCard>
                  <LaunchCard icon={<SquareTerminal size={13} />} title={t('bottomPanel.openTerminal')} disabled={!ready} onClick={openTerminal}>
                    {t('bottomPanel.launch.terminalBody')}
                  </LaunchCard>
                  <LaunchCard icon={<Wrench size={13} />} title={t('bottomPanel.launch.setup')} onClick={() => setTab('setup')}>
                    {setupWord ?? t('bottomPanel.launch.setupBody')}
                  </LaunchCard>
                </div>
              </div>
            </TabPanel>
          )}
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
                      visible={visible && selected === `term-${n}`}
                      chatSource={{ kind: 'terminal', n, ...(term.name || term.shell ? { name: tabName(term) } : {}) }}
                      zoom={term.zoom}
                      onZoom={(zoom) => updateTerminal(n, { zoom })}
                      restored={term.restored}
                      waiting={Boolean(term.restored && !term.restored.started)}
                      onStartShell={() => startShell(term)}
                      onRename={() => setRenaming(n)}
                      onClose={() => closeTerminal(n)}
                      onOutput={markDirty}
                      onReader={(read) => (read ? readers.current.set(n, read) : readers.current.delete(n))}
                    />
                  </TabPanel>
                )
              })}
        </div>
      </div>
      {commands.dialog}
    </Tabs>
  )
}
