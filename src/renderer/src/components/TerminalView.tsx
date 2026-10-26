import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/xterm'
import { History, SquareTerminal } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isSendShortcut, type SnippetSource } from '../../../shared/terminalSnippet'
import {
  bufferTail,
  dimHistory,
  historyDivider,
  isFindShortcut,
  isFullscreenShortcut,
  osc7Folder,
  osc99Folder,
  RESTORE_SERIALIZE_ROWS,
  restoredLabel,
  shortPath,
  styledFromSerialized,
  trimStyled,
  stepZoom,
  zoomedFontSize,
  zoomShortcut
} from '../../../shared/terminalTabs'
import type { PtyKind } from '../../../shared/types'
import { CommandStatusScanner } from '../../../shared/savedCommands'
import { t, useT } from '../i18n'
import { api, bridge, getState, listenPty, sendSelectionToChat, sendUiCommand, showError, toggleTerminalFullscreen, useStore } from '../store'
import { onAppearanceChange, terminalOptions, terminalTheme } from '../theme'
import { Button } from '../ui'
import { CloudTerminalBand } from './cloud/CloudBits'
import { TerminalFind } from './TerminalFind'
import { TerminalMenu } from './TerminalMenu'
import { terminalDropText } from './dropPlan'

/** Output saved before the last restart (O3), shown dimmed until Start shell. */
export interface RestoredOutput {
  at: number
  text: string
  cwd: string
  // G3 · O3: the text keeps its colours (SGR only).
  styled?: boolean
  // G3 · O10: Foreman quit at this time, which ended the shell.
  quitAt?: number
}

/** G3 · O3: what a save reads from a tab: the end of its output (with colours when the serializer could) and its shell's folder. */
export interface TerminalReading {
  text: string
  styled: boolean
  // Where the shell last said it was (OSC 7 or OSC 9;9), if it said.
  cwd?: string
}

interface Props {
  workspaceId: string
  kind: PtyKind
  // For kind 'command': which allowlisted command to run (e.g. 'claude-login').
  command?: string
  visible: boolean
  onSpawn?: (ptyId: string) => void
  onExit?: (code: number) => void
  // Set for the bottom panel's terminals: a right-click menu, find (⌘F), zoom, and ⌘L sends the selection to chat (#10).
  chatSource?: SnippetSource
  // O3, bottom panel only. This tab's zoom (1 is 100%) and how to change it.
  zoom?: number
  onZoom?: (zoom: number) => void
  // A restored tab: its old output is written in dimmed when the terminal is made. While `waiting`, no process
  // runs and the band with Start shell shows; clearing `waiting` starts the shell below the old output.
  restored?: RestoredOutput
  waiting?: boolean
  onStartShell?: () => void
  // Bumped to open the find bar (the tab's menu → Find…).
  findRequest?: number
  // The tab menu's own entries; the menu adds Fullscreen, Copy on select, Zoom and Find itself.
  onRename?: () => void
  onClose?: () => void
  // Output arrived (the panel saves tabs a little later), and a way to read the end of the output.
  onOutput?: () => void
  onReader?: (read: (() => TerminalReading) | null) => void
  // G4 #10: views without a chatSource (MCP sign-in, login terminals, shell snippets) still get Copy, Paste, Select all
  // and Clear on right-click; naming the output here adds Send selection to chat (the workspace's chat).
  sendAs?: string
  // G4 O9: a command finished in this terminal with this exit status (OSC 133;D or Foreman's marker).
  onCommandStatus?: (code: number) => void
}

export function TerminalView({
  workspaceId,
  kind,
  command,
  visible,
  onSpawn,
  onExit,
  chatSource,
  zoom = 1,
  onZoom,
  restored,
  waiting = false,
  onStartShell,
  findRequest = 0,
  onRename,
  onClose,
  onOutput,
  onReader,
  onCommandStatus,
  sendAs
}: Props) {
  const tr = useT()
  const trRef = useRef(tr)
  trRef.current = tr
  // The divider under restored output is written once, when Start shell runs.
  const divided = useRef(false)
  const host = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const ptyRef = useRef<string | null>(null)
  const [search, setSearch] = useState<SearchAddon | null>(null)
  // The find bar: closed, or open with a nonce that refocuses its input.
  const [find, setFind] = useState<number | null>(null)
  // Keep the latest callbacks without restarting the terminal.
  const callbacks = useRef({ onSpawn, onExit, onZoom, onOutput, onReader, onCommandStatus, zoom })
  callbacks.current = { onSpawn, onExit, onZoom, onOutput, onReader, onCommandStatus, zoom }
  const source = useRef(chatSource)
  source.current = chatSource
  const restoredRef = useRef(restored)
  restoredRef.current = restored
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null)
  // A cloud terminal whose sandbox is asleep or unreachable: read-only, with Wake (PLAN §8).
  const [asleep, setAsleep] = useState<{ reason?: string } | null>(null)
  const terminalFont = useStore((s) => s.snapshot?.settings.terminalFont ?? '')
  const terminalFontSize = useStore((s) => s.snapshot?.settings.terminalFontSize ?? 12)
  const contentFontSize = useStore((s) => s.snapshot?.settings.contentFontSize)
  const terminalScrollbackMb = useStore((s) => s.snapshot?.settings.terminalScrollbackMb ?? 10)
  const terminalScreenReader = useStore((s) => s.snapshot?.settings.terminalScreenReader)
  const osScreenReader = useStore((s) => s.snapshot?.screenReader)
  const copyOnSelect = useStore((s) => s.snapshot?.settings.terminalCopyOnSelect ?? false)
  const fullscreen = useStore((s) => s.terminalFullscreen === workspaceId)
  const homeDir = useStore((s) => s.snapshot?.homeDir)
  const copyOnSelectRef = useRef(copyOnSelect)
  copyOnSelectRef.current = copyOnSelect
  const base = terminalOptions({ terminalFont, terminalFontSize, contentFontSize, terminalScrollbackMb, terminalScreenReader }, osScreenReader)
  const options = { ...base, fontSize: zoomedFontSize(base.fontSize, zoom) }
  // The terminal is created with the latest options; later changes are applied in place.
  const optionsRef = useRef(options)
  optionsRef.current = options

  const openFind = useCallback(() => setFind(Date.now()), [])

  useEffect(() => {
    const term = new Terminal({
      ...optionsRef.current,
      lineHeight: 1.25,
      // O9: a saved command's tab is a shell too.
      cursorBlink: kind === 'shell' || kind === 'saved',
      allowProposedApi: true,
      theme: terminalTheme()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const finder = new SearchAddon()
    term.loadAddon(finder)
    // G3 · O3: the serializer keeps colours in saved output; the folder comes from the shell's own reports.
    const serializer = new SerializeAddon()
    term.loadAddon(serializer)
    let cwd: string | undefined
    const osc7 = term.parser.registerOscHandler(7, (data) => {
      cwd = osc7Folder(data) ?? cwd
      return true
    })
    const osc9 = term.parser.registerOscHandler(9, (data) => {
      const folder = osc99Folder(data)
      if (folder) cwd = folder
      // Not a folder report (OSC 9 is also a notification): leave it for anything else.
      return Boolean(folder)
    })
    term.open(host.current!)
    termRef.current = term
    fitRef.current = fit
    setSearch(finder)
    try {
      fit.fit()
    } catch {
      // Hidden containers have no size yet; the resize observer fits later.
    }
    // A restored tab starts with its old output, dimmed, so it reads as history.
    if (restoredRef.current) term.write(dimHistory(restoredRef.current.text, restoredRef.current.styled))
    callbacks.current.onReader?.(() => {
      // Until this tab's shell reports a folder, a restored tab's folder is the one it was restored with.
      const folder = cwd ?? restoredRef.current?.cwd
      try {
        // Only the normal buffer: a full-screen program's alternate screen isn't history.
        const serialized = serializer.serialize({ scrollback: RESTORE_SERIALIZE_ROWS, excludeModes: true, excludeAltBuffer: true })
        return { text: trimStyled(styledFromSerialized(serialized)), styled: true, cwd: folder }
      } catch {
        const buffer = term.buffer.normal
        const text = bufferTail(buffer.length, (i) => {
          const line = buffer.getLine(i)
          return line ? { text: line.translateToString(true), wrapped: line.isWrapped } : undefined
        })
        return { text, styled: false, cwd: folder }
      }
    })

    // ⌘L / Ctrl+L with a selection puts it in the composer. Without one the key goes on as before:
    // ⌘L focuses the composer, and Ctrl+L reaches the shell (clear screen).
    // In the bottom panel: ⌘F finds, ⌘= ⌘− ⌘0 zoom this tab, and ⌘⇧J is left to the app (fullscreen) rather than reaching the shell.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !source.current) return true
      const platform = getState().snapshot?.platform
      const handled = () => {
        e.preventDefault()
        e.stopPropagation()
        return false
      }
      if (isFindShortcut(e, platform)) {
        setFind(Date.now())
        return handled()
      }
      const zoomStep = zoomShortcut(e, platform)
      if (zoomStep !== null && callbacks.current.onZoom) {
        callbacks.current.onZoom(stepZoom(callbacks.current.zoom, zoomStep))
        return handled()
      }
      if (isFullscreenShortcut(e, platform)) return false
      if (!term.hasSelection() || !isSendShortcut(e, platform)) return true
      e.preventDefault()
      e.stopPropagation()
      if (!sendSelectionToChat(workspaceId, term.getSelection(), source.current)) sendUiCommand('focus-composer', workspaceId)
      return false
    })
    // Copy on select (a preference): copy once the selection settles.
    let copyTimer: ReturnType<typeof setTimeout> | undefined
    const selection = term.onSelectionChange(() => {
      if (!copyOnSelectRef.current || !source.current) return
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => {
        const text = term.getSelection()
        if (text) navigator.clipboard.writeText(text).catch(() => showError(t('terminalChat.copyFailed')))
      }, 150)
    })
    const input = term.onData((data) => ptyRef.current && bridge.send.ptyWrite(ptyRef.current, data))
    const resize = term.onResize(({ cols, rows }) => ptyRef.current && bridge.send.ptyResize(ptyRef.current, cols, rows))
    const observer = new ResizeObserver(() => {
      if (host.current && host.current.offsetWidth > 0) {
        try {
          fit.fit()
        } catch {
          // Ignore transient layout states.
        }
      }
    })
    observer.observe(host.current!)
    const stopAppearance = onAppearanceChange(() => {
      term.options.theme = terminalTheme()
    })

    return () => {
      clearTimeout(copyTimer)
      osc7.dispose()
      osc9.dispose()
      stopAppearance()
      observer.disconnect()
      selection.dispose()
      input.dispose()
      resize.dispose()
      callbacks.current.onReader?.(null)
      termRef.current = null
      setSearch(null)
      term.dispose()
    }
  }, [workspaceId, kind, command])

  // The process: started with the terminal, or, for a restored tab, when Start shell clears `waiting`.
  useEffect(() => {
    const term = termRef.current
    if (!term || waiting) return
    let disposed = false
    let stopListening = () => {}
    // Started from a restored tab: a line under the old output says where the new shell begins.
    const old = restoredRef.current
    if (old && !divided.current) {
      divided.current = true
      term.write(historyDivider(restoredLabel(old.at, Date.now(), trRef.current, trRef.current.locale, old.quitAt)))
    }
    // StrictMode replays mount effects in development. Wait until that replay
    // finishes so clicking Run never launches a shell snippet twice.
    // G3 · O3: a restored tab's new shell starts in the folder the old one was last in (main checks it exists).
    void Promise.resolve().then(() => disposed ? null : api.ptySpawn(workspaceId, Math.max(term.cols, 20), Math.max(term.rows, 5), kind, command, old ? { cwd: old.cwd } : undefined))
      .then((id) => {
        if (!id) return
        if (disposed) {
          bridge.send.ptyKill(id)
          return
        }
        ptyRef.current = id
        callbacks.current.onSpawn?.(id)
        const statuses = new CommandStatusScanner()
        stopListening = listenPty(id, {
          data: (data) => {
            term.write(data)
            callbacks.current.onOutput?.()
            if (callbacks.current.onCommandStatus) for (const code of statuses.feed(data)) callbacks.current.onCommandStatus(code)
          },
          exit: (code) => {
            setAsleep(null)
            term.options.disableStdin = false
            term.write(`\r\n\x1b[2m${trRef.current('terminalView.processExited', { code })}\x1b[0m\r\n`)
            callbacks.current.onOutput?.()
            callbacks.current.onExit?.(code)
          },
          // Cloud terminals only: read-only while the sandbox sleeps, live again when a new shell starts.
          state: (isAsleep, reason) => {
            setAsleep(isAsleep ? { reason } : null)
            term.options.disableStdin = isAsleep
          }
        })
      })
      .catch((err) => {
        showError(err)
        callbacks.current.onExit?.(-1)
      })
    return () => {
      disposed = true
      stopListening()
      if (ptyRef.current) bridge.send.ptyKill(ptyRef.current)
      ptyRef.current = null
      setAsleep(null)
    }
  }, [workspaceId, kind, command, waiting])

  // Font, zoom, scrollback and screen reader settings take effect without restarting the shell.
  const { fontFamily, fontSize, scrollback, screenReaderMode } = options
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (term.options.fontFamily === fontFamily && term.options.fontSize === fontSize && term.options.scrollback === scrollback && Boolean(term.options.screenReaderMode) === screenReaderMode) return
    term.options.fontFamily = fontFamily
    term.options.fontSize = fontSize
    term.options.scrollback = scrollback
    term.options.screenReaderMode = screenReaderMode
    if (!host.current || host.current.offsetWidth === 0) return // hidden; fitted when shown
    try {
      fitRef.current?.fit()
    } catch {
      // Ignore transient layout states.
    }
  }, [fontFamily, fontSize, scrollback, screenReaderMode])

  useEffect(() => {
    if (!visible) return
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // Not laid out yet.
      }
      if (kind === 'shell' || kind === 'saved') termRef.current?.focus()
    })
  }, [visible, kind])

  // The tab's menu asked for Find…; also shows the tab, so this runs once it is mounted.
  useEffect(() => {
    if (findRequest) setFind(Date.now())
  }, [findRequest])

  const closeMenu = useCallback(() => setMenu(null), [])
  const refocus = useCallback(() => termRef.current?.focus(), [])
  const closeFind = useCallback(() => {
    setFind(null)
    termRef.current?.focus()
  }, [])
  const selection = () => termRef.current?.getSelection() ?? ''

  return (
    <>
      <div
        className={`terminal ${waiting && restored ? 'restored' : ''} ${asleep ? 'asleep' : ''}`}
        ref={host}
        // G3 · O21: a file or folder dropped here is typed into the shell as its path (never the add-repo overlay).
        onDragOver={(e) => {
          if (![...e.dataTransfer.items].some((i) => i.kind === 'file')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={(e) => {
          const paths = [...e.dataTransfer.files].map((f) => bridge.pathForFile(f)).filter(Boolean)
          if (!paths.length) return
          e.preventDefault()
          if (ptyRef.current) termRef.current?.paste(terminalDropText(paths))
          termRef.current?.focus()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          // xterm has already handled the click (on macOS a right-click selects the word under it).
          setMenu({ x: e.clientX, y: e.clientY, hasSelection: Boolean(termRef.current?.hasSelection()) })
        }}
      />
      {chatSource && find !== null && search && <TerminalFind search={search} focusRequest={find} onClose={closeFind} />}
      {asleep && <CloudTerminalBand workspaceId={workspaceId} reason={asleep.reason} />}
      {waiting && restored && (
        <div className="term-restored">
          <div className="term-restored-band">
            <History size={13} />
            {restoredLabel(restored.at, Date.now(), tr, tr.locale, restored.quitAt)}
          </div>
          <div className="term-restored-actions">
            <Button variant="primary" size="sm" icon={<SquareTerminal size={13} />} onClick={onStartShell} title={tr('terminal.startShellTitle')}>
              {tr('terminal.startShell')}
            </Button>
            <span className="faint">{tr.rich('terminal.startShellIn', { path: <span key="path" className="mono">{shortPath(restored.cwd, homeDir)}</span> })}</span>
          </div>
        </div>
      )}
      {menu && !chatSource && (
        // G4 #10: the other terminal views' menu: the output entries only, Send when the view names its output.
        <TerminalMenu
          x={menu.x}
          y={menu.y}
          dismiss={closeMenu}
          onEscape={refocus}
          actions={{
            hasSelection: menu.hasSelection,
            onCopy: () => {
              navigator.clipboard.writeText(selection()).catch(() => showError(t('terminalChat.copyFailed')))
              refocus()
            },
            onSend: sendAs && workspaceId ? () => void sendSelectionToChat(workspaceId, selection(), { kind: 'view', name: sendAs }) : undefined,
            onPaste: () => {
              refocus()
              navigator.clipboard
                .readText()
                .then((text) => text && termRef.current?.paste(text))
                .catch(() => showError(t('terminalChat.pasteFailed')))
            },
            onSelectAll: () => {
              termRef.current?.selectAll()
              refocus()
            },
            onClear: () => {
              termRef.current?.clear()
              refocus()
            }
          }}
        />
      )}
      {menu && chatSource && (
        <TerminalMenu
          x={menu.x}
          y={menu.y}
          dismiss={closeMenu}
          onEscape={refocus}
          actions={{
            hasSelection: menu.hasSelection,
            onCopy: () => {
              navigator.clipboard.writeText(selection()).catch(() => showError(t('terminalChat.copyFailed')))
              refocus()
            },
            onSend: () => {
              if (!sendSelectionToChat(workspaceId, selection(), chatSource)) sendUiCommand('focus-composer', workspaceId)
            },
            workspaceId,
            onSendTo: (sessionId) => void sendSelectionToChat(workspaceId, selection(), chatSource, sessionId),
            onPaste: () => {
              refocus()
              navigator.clipboard
                .readText()
                .then((text) => text && termRef.current?.paste(text))
                .catch(() => showError(t('terminalChat.pasteFailed')))
            },
            onSelectAll: () => {
              termRef.current?.selectAll()
              refocus()
            },
            onClear: () => {
              termRef.current?.clear()
              refocus()
            }
          }}
          tab={{
            onRename,
            fullscreen,
            onFullscreen: () => toggleTerminalFullscreen(workspaceId),
            copyOnSelect,
            onCopyOnSelect: (on) => void api.updateSettings({ terminalCopyOnSelect: on }).catch(showError),
            zoom,
            onZoom: (next) => onZoom?.(next),
            onFind: openFind,
            onClose
          }}
        />
      )}
    </>
  )
}
