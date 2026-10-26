// New workspace from a Linear issue: a link or id (ENG-123) in the first message is read with the
// repository's Linear connection, and "My issues" lists what's assigned to you there. The issue's
// text goes to the agent as an untrusted attachment, like a GitHub issue's, and a new branch with no
// name takes Linear's branch name so Linear's own GitHub integration links the pull request.
import { CircleDot } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { resolveIntegration } from '../../../shared/integrations'
import { findLinearLink, type LinearIssueSummary } from '../../../shared/linearLink'
import type { LinearLinkInfo, Repo } from '../../../shared/types'
import { useT } from '../i18n'
import { api, useStore } from '../store'
import { MenuButton, MenuItem, MenuLabel, Spinner } from '../ui'
import { ServiceMark } from './settings/integrations/ServiceMark'
import './settings/integrations/integrations.css'

/** Whether the repository has a Linear connection to read issues with (working or not). */
export function useHasLinear(repo: Repo | undefined): boolean {
  return useStore((s) => {
    if (!repo) return false
    const view = s.snapshot!.integrations
    const defaults = Object.fromEntries(view.connections.filter((c) => c.isDefault).map((c) => [c.service, c.id]))
    const r = resolveIntegration({ connections: view.connections, defaults, rules: [], people: [] }, repo, 'linear')
    return r.state === 'ready' || r.state === 'broken'
  })
}

/** The Linear issue the first message names, read once it settles. Null without one. */
export function useLinearIntake(repoId: string | undefined, prompt: string, enabled: boolean): { ref: string; info?: LinearLinkInfo } | null {
  const link = useMemo(() => (enabled ? findLinearLink(prompt, { bareIds: true }) : null), [enabled, prompt])
  const ref = link ? (link.url ?? link.identifier) : null
  const [info, setInfo] = useState<{ repoId: string; ref: string; info: LinearLinkInfo } | null>(null)
  useEffect(() => {
    if (!ref || !repoId) return
    let stale = false
    const timer = setTimeout(() => {
      api.resolveLinearLink(repoId, ref).then(
        (result) => !stale && setInfo({ repoId, ref, info: result }),
        (err: Error) => !stale && setInfo({ repoId, ref, info: { problem: err.message } })
      )
    }, 350)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [ref, repoId])
  if (!ref) return null
  return { ref, info: info?.ref === ref && info.repoId === repoId ? info.info : undefined }
}

export function LinearLine({ intake }: { intake: { ref: string; info?: LinearLinkInfo } }) {
  const t = useT()
  const { info } = intake
  return (
    <>
      <div className="intake-line">
        <CircleDot size={12} aria-hidden />
        <span>
          {!info
            ? t('linearIntake.reading', { ref: intake.ref })
            : info.problem
              ? info.problem
              : t('linearIntake.line', { id: info.issue!.identifier, title: info.issue!.title, state: info.issue!.state.name, connection: info.connection ?? '' })}
        </span>
      </div>
      {info?.issue && <p className="nw-note">{t('linearIntake.note', { branch: info.branch ?? '' })}</p>}
    </>
  )
}

/** "Linear issues": what's assigned to you in the repository's Linear workspace. */
export function LinearIssuesButton({ repoId, onPick }: { repoId: string; onPick: (issue: LinearIssueSummary) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<{ issues: LinearIssueSummary[]; connection: string } | { error: string } | null>(null)
  useEffect(() => {
    if (!open) return
    setResult(null)
    void api.linearMyIssues(repoId).then(setResult, (err: Error) => setResult({ error: err.message }))
  }, [open, repoId])
  return (
    <MenuButton
      label={t('linearIntake.myIssues')}
      look="ghost"
      small
      portal
      open={open}
      onOpenChange={setOpen}
      menuClassName="nw-issues-menu"
      trigger={
        <>
          <ServiceMark service="linear" size={14} /> {t('linearIntake.myIssues')}
        </>
      }
    >
      {result === null ? (
        <MenuLabel>
          <Spinner size={12} label={t('linearIntake.loading')} />
        </MenuLabel>
      ) : 'error' in result ? (
        <MenuLabel>{result.error}</MenuLabel>
      ) : (
        <>
          <MenuLabel>{t('linearIntake.assigned', { connection: result.connection })}</MenuLabel>
          {result.issues.map((issue) => (
            <MenuItem key={issue.identifier} onSelect={() => onPick(issue)}>
              <span className="linear-issue-row">
                <span className="linear-issue-id mono">{issue.identifier}</span>
                <span className="linear-issue-title">{issue.title}</span>
                <span className="linear-issue-state">{issue.state.name}</span>
              </span>
            </MenuItem>
          ))}
          {!result.issues.length && <MenuLabel>{t('linearIntake.none')}</MenuLabel>}
        </>
      )}
    </MenuButton>
  )
}
