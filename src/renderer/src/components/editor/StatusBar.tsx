// The Editor layout's status bar: the workspace on screen at a glance (its branch, what it changed, whether its agent is
// working or needs you, its pull request) along the bottom of the window. Empty, but still there, on Home.
import { GitBranch } from 'lucide-react'
import type { Workspace } from '../../../../shared/types'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import { triageAll } from '../../triage'
import { Spinner, Status } from '../../ui'
import { DiffBadge, DOT_TONE, useTriageInput } from '../Sidebar'
import './editor.css'

const PR_LABEL = {
  OPEN: 'home.board.prOpen',
  MERGED: 'home.board.prMerged',
  CLOSED: 'home.board.prClosed'
} as const satisfies Record<NonNullable<Workspace['prInfo']>['state'], string>

export function StatusBar({ workspaceId }: { workspaceId: string | null }) {
  const t = useT()
  const input = useTriageInput()
  const ws = input.snapshot.workspaces.find((w) => w.id === workspaceId)
  const repo = useStore((s) => s.snapshot!.repos.find((r) => r.id === ws?.repoId))
  const running = useStore((s) => s.snapshot!.sessions.some((x) => x.workspaceId === workspaceId && x.status === 'running'))
  const triage = ws ? triageAll(input, null).find((item) => item.ws.id === ws.id) : undefined
  const attention = triage?.bucket === 'attention' && triage.label ? triage : null

  return (
    <footer className="status-bar" aria-label={t('editorLayout.status.label')}>
      {ws && (
        <>
          <span className="status-bar-item">
            <GitBranch size={12} aria-hidden />
            <code className="status-bar-branch">{ws.branch}</code>
          </span>
          {ws.diffStat && <DiffBadge additions={ws.diffStat.additions} deletions={ws.diffStat.deletions} />}
          {attention ? (
            <Status tone={DOT_TONE[attention.tone ?? ''] ?? 'warn'} label={attention.label!} />
          ) : (
            running && (
              <span className="status-bar-item">
                <Spinner size={11} />
                {t('workspaceView.panel.working')}
              </span>
            )
          )}
          {ws.prInfo && <span className="status-bar-item">{t(PR_LABEL[ws.prInfo.state], { number: ws.prInfo.number })}</span>}
          <span className="spacer" />
          {repo && <span className="status-bar-item faint">{repo.name}</span>}
        </>
      )}
    </footer>
  )
}
