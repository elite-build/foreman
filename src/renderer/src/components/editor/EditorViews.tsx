// The Editor layout's activity bar: the views the sidebar can show, at the top of the repository rail. Workspaces is the
// usual list; Changes, Commits, Files and Checks are the workspace's side panel, moved beside the bar.
import { FileCode, GitCommitHorizontal, GitCompare, Layers, ListChecks, type LucideIcon } from 'lucide-react'
import type { PlainKey } from '../../../../shared/i18n'
import { EDITOR_VIEWS, type EditorView } from '../../editorLayout'
import { useT } from '../../i18n'
import { pickEditorSidebar } from '../../store'
import { IconButton } from '../../ui'
import './editor.css'

const VIEW: Record<EditorView, { icon: LucideIcon; label: PlainKey }> = {
  workspaces: { icon: Layers, label: 'editorLayout.activity.workspaces' },
  changes: { icon: GitCompare, label: 'workspaceView.panel.changes' },
  commits: { icon: GitCommitHorizontal, label: 'commits.tab' },
  files: { icon: FileCode, label: 'files.tab' },
  checks: { icon: ListChecks, label: 'workspaceView.panel.checks' }
}

/**
 * `shown` is the view the sidebar is showing (null while it is hidden); a view with nothing to show for the workspace on
 * screen (Files in a cloud workspace, any of them on Home) is unavailable.
 */
export function EditorViews({ shown, available }: { shown: EditorView | null; available: ReadonlySet<EditorView> }) {
  const t = useT()
  return (
    <nav className="editor-views" aria-label={t('editorLayout.activity.label')}>
      {EDITOR_VIEWS.map((id) => {
        const { icon: Icon, label } = VIEW[id]
        return (
          <IconButton key={id} className="editor-view-button" label={t(label)} pressed={shown === id} disabled={!available.has(id)} onClick={() => pickEditorSidebar(id)}>
            <Icon size={18} />
          </IconButton>
        )
      })}
    </nav>
  )
}
