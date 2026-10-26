import { CornerDownRight, Maximize2, MessageSquarePlus, Minimize2, Minus, Pencil, Plus, Search, TextSelect, X, ZoomIn } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { stepZoom, ZOOM_MAX, ZOOM_MIN, zoomPercent } from '../../../shared/terminalTabs'
import { useT } from '../i18n'
import { getState, modKey, openSessions, snippetTargetId, useStore } from '../store'
import { ContextMenu, MenuCheckboxItem, MenuControlRow, MenuGroup, MenuItem, MenuRadioItem, MenuSeparator } from '../ui'

export interface TerminalMenuActions {
  // Whether something was selected when the menu opened; Copy and Send need it.
  hasSelection: boolean
  onCopy: () => void
  // Absent where the output has no chat to go to (a login terminal in Settings).
  onSend?: () => void
  // Only where the output takes input (terminals, not the Setup log).
  onPaste?: () => void
  onSelectAll: () => void
  onClear?: () => void
  // G4: with several chats open in this workspace, Send lists them; picking one sends there and is remembered.
  workspaceId?: string
  onSendTo?: (sessionId: string) => void
}

/**
 * G4 #10: the chat chooser. With two or more chats open, one row per chat under Send; the check marks where
 * Send and ⌘L go (the chat picked last, else the active one). Picking a row sends there and remembers it.
 */
function SendTargets({ workspaceId, disabled, onSendTo }: { workspaceId: string; disabled: boolean; onSendTo: (sessionId: string) => void }) {
  const t = useT()
  const snapshot = getState().snapshot
  const chats = snapshot ? openSessions(snapshot, workspaceId) : []
  if (chats.length < 2) return null
  const target = snippetTargetId(workspaceId)
  return (
    <MenuGroup label={t('terminalChat.sendTo')}>
      {chats.map((chat, n) => (
        <MenuRadioItem
          key={chat.id}
          checked={chat.id === target}
          indent
          icon={<CornerDownRight size={12} />}
          disabled={disabled}
          title={t('terminalChat.sendToTitle', { key: `${modKey(getState().snapshot?.platform)}L` })}
          onSelect={() => onSendTo(chat.id)}
        >
          <span className="terminal-menu-chat">{chat.title || t('terminalChat.chatN', { n: n + 1 })}</span>
        </MenuRadioItem>
      ))}
    </MenuGroup>
  )
}

/** The tab's own entries (O3): the same whether you right-click its tab or its output. */
export interface TerminalTabActions {
  // Terminal tabs only (not Run).
  onRename?: () => void
  fullscreen: boolean
  onFullscreen: () => void
  // A preference for every terminal.
  copyOnSelect: boolean
  onCopyOnSelect: (on: boolean) => void
  // This tab only; 1 is 100%.
  zoom: number
  onZoom: (zoom: number) => void
  onFind: () => void
  onClose?: () => void
}

/**
 * The right-click menu for terminal output (#10): Copy, Send selection to chat, Paste, Select all, Clear,
 * then the tab's entries (O3): Rename, Fullscreen, Copy on select, Zoom, Find…, Close terminal. A tab's own
 * right-click shows just the tab's entries. A `ContextMenu`: drawn in <body> at the pointer and kept on
 * screen, since the bottom panel clips and isolates its contents.
 */
export function TerminalMenu({ x, y, actions, tab, label, dismiss, onEscape }: {
  x: number
  y: number
  actions?: TerminalMenuActions
  tab?: TerminalTabActions
  // The menu's accessible name (the tab's name for a tab's menu).
  label?: string
  dismiss: () => void
  // Escape closes the menu and gives focus back to where it was.
  onEscape?: () => void
}) {
  const t = useT()
  const platform = useStore((s) => s.snapshot?.platform)
  const mac = platform === 'darwin'
  const mod = modKey(platform)

  // The menu returns focus to whatever had it when it opened; `onEscape` says where else it may go (the terminal).
  // Capture phase: the menu stops Escape itself, so a bubbling listener would never see it.
  useEffect(() => {
    if (!onEscape) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onEscape()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onEscape])

  const item = (text: string, action: () => void, options: { hint?: string; disabled?: boolean; title?: string; icon?: ReactNode } = {}) => (
    <MenuItem hint={options.hint} disabled={options.disabled} title={options.title} icon={options.icon} onSelect={action}>
      {text}
    </MenuItem>
  )

  return (
    <ContextMenu x={x} y={y} label={label ?? t('terminalChat.menuLabel')} className="terminal-menu" onClose={dismiss}>
      {actions && (
        <>
          {/* Copy and Paste hints only where those keys do that in a terminal (on Windows, Ctrl+C interrupts). */}
          {item(t('terminalChat.copy'), actions.onCopy, { hint: mac ? '⌘C' : undefined, disabled: !actions.hasSelection })}
          {actions.onSend &&
            item(t('terminalChat.send'), actions.onSend, {
              hint: `${mod}L`,
              disabled: !actions.hasSelection,
              title: actions.hasSelection ? t('terminalChat.sendTitle') : t('terminalChat.nothingSelected'),
              icon: <MessageSquarePlus size={14} />
            })}
          {actions.workspaceId && actions.onSendTo && <SendTargets workspaceId={actions.workspaceId} disabled={!actions.hasSelection} onSendTo={actions.onSendTo} />}
          {actions.onPaste && item(t('terminalChat.paste'), actions.onPaste, { hint: mac ? '⌘V' : undefined })}
          <MenuSeparator />
          {item(t('terminalChat.selectAll'), actions.onSelectAll, { hint: mac ? '⌘A' : undefined })}
          {actions.onClear && item(t('terminalChat.clear'), actions.onClear)}
        </>
      )}
      {actions && tab && <MenuSeparator />}
      {tab && (
        <>
          {tab.onRename && item(t('terminal.menu.rename'), tab.onRename, { hint: t('terminal.menu.renameHint'), icon: <Pencil size={14} /> })}
          {item(tab.fullscreen ? t('terminal.menu.exitFullscreen') : t('terminal.menu.fullscreen'), tab.onFullscreen, {
            hint: `${mod}⇧J`,
            icon: tab.fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />
          })}
          <MenuCheckboxItem checked={tab.copyOnSelect} icon={<TextSelect size={14} />} onCheckedChange={tab.onCopyOnSelect}>
            {t('terminal.menu.copyOnSelect')}
          </MenuCheckboxItem>
          {/* Zoom steps keep the menu open, so you can watch the text change. */}
          <MenuControlRow label={t('terminal.menu.zoom')} icon={<ZoomIn size={14} />}>
            <MenuItem aria-label={t('terminal.menu.zoomOut')} title={`${t('terminal.menu.zoomOut')} (${mod}−)`} disabled={tab.zoom <= ZOOM_MIN} onSelect={() => tab.onZoom(stepZoom(tab.zoom, -1))}>
              <Minus size={12} aria-hidden />
            </MenuItem>
            <MenuItem variant="value" aria-label={t('terminal.menu.zoomReset')} title={`${t('terminal.menu.zoomReset')} (${mod}0)`} onSelect={() => tab.onZoom(1)}>
              {zoomPercent(tab.zoom)}
            </MenuItem>
            <MenuItem aria-label={t('terminal.menu.zoomIn')} title={`${t('terminal.menu.zoomIn')} (${mod}=)`} disabled={tab.zoom >= ZOOM_MAX} onSelect={() => tab.onZoom(stepZoom(tab.zoom, 1))}>
              <Plus size={12} aria-hidden />
            </MenuItem>
          </MenuControlRow>
          <MenuSeparator />
          {item(t('terminal.menu.find'), tab.onFind, { hint: `${mod}F`, icon: <Search size={14} /> })}
          {tab.onClose && item(t('terminal.menu.close'), tab.onClose, { icon: <X size={14} /> })}
        </>
      )}
    </ContextMenu>
  )
}
