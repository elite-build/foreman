import { RotateCw } from 'lucide-react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { Workspace } from '../../../shared/types'
import { useT } from '../i18n'
import { api, attempt, sendSelectionToChat, showError, useStore } from '../store'
import { Button, Callout } from '../ui'
import { useSetupSteps } from './SetupSteps'
import { TerminalMenu } from './TerminalMenu'

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

/** The page's text selection when it lies wholly inside `el`, else ''. */
function selectionIn(el: Element | null): string {
  const selection = window.getSelection()
  if (!el || !selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return ''
  return el.contains(selection.anchorNode) && el.contains(selection.focusNode) ? selection.toString() : ''
}

/**
 * ⌘L with text selected in a Setup log: send it to that workspace's chat (#10). False when there is no
 * such selection, so the shortcut focuses the composer as before.
 */
export function sendSetupSelectionToChat(): boolean {
  const node = window.getSelection()?.anchorNode
  const log = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-chat-source="setup"]')
  const text = selectionIn(log ?? null)
  return Boolean(log?.dataset.workspaceId && text && sendSelectionToChat(log.dataset.workspaceId, text, { kind: 'setup' }))
}

export function SetupLog({ workspace }: { workspace: Workspace }) {
  const t = useT()
  const log = useStore((s) => s.setupLogs[workspace.id]) ?? ''
  const hasSetupScript = useStore((s) => Boolean(s.snapshot!.repoSettings[workspace.repoId]?.values.setupScript.trim()))
  const pre = useRef<HTMLPreElement>(null)
  // The right-click menu, with the selection as it was when it opened.
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  // O19: the step panel, and the chosen step's own log in place of the full one.
  const steps = useSetupSteps(workspace, log)
  const shown = steps.text ?? log

  useLayoutEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [shown])

  const canRerun = hasSetupScript && !['setting-up', 'creating', 'error'].includes(workspace.state)
  return (
    <div className="setup-log">
      <div className="setup-head faint small">
        <span>
          {t('setupLog.ports', { from: workspace.portBase, to: workspace.portBase + 9 })}
        </span>
        <span className="setup-head-actions">
          {steps.actions}
          {canRerun && (
            <Button size="sm" icon={<RotateCw size={11} />} onClick={() => void attempt(() => api.rerunSetup(workspace.id))}>
              {t('setupLog.rerun')}
            </Button>
          )}
        </span>
      </div>
      {workspace.error && (
        <Callout tone="error" role="alert">
          {workspace.error}
        </Callout>
      )}
      {steps.panel}
      <pre
        ref={pre}
        data-chat-source="setup"
        data-workspace-id={workspace.id}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, text: selectionIn(pre.current) })
        }}
      >
        {shown.replace(ANSI, '') || t('setupLog.empty')}
      </pre>
      {menu && (
        <TerminalMenu
          x={menu.x}
          y={menu.y}
          dismiss={closeMenu}
          actions={{
            hasSelection: Boolean(menu.text.trim()),
            onCopy: () => void navigator.clipboard.writeText(menu.text).catch(() => showError(t('terminalChat.copyFailed'))),
            onSend: () => void sendSelectionToChat(workspace.id, menu.text, { kind: 'setup' }),
            workspaceId: workspace.id,
            onSendTo: (sessionId) => void sendSelectionToChat(workspace.id, menu.text, { kind: 'setup' }, sessionId),
            onSelectAll: () => {
              if (pre.current) window.getSelection()?.selectAllChildren(pre.current)
            }
          }}
        />
      )}
    </div>
  )
}
