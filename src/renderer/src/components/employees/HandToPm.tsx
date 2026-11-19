// "Hand to Priya…" (docs/ai-employees.md §15): a workspace that grew becomes a project. The organization's program
// manager starts one from it, with its chat as her first input. The project works in a new workspace branched from this
// one's HEAD; this one stays the person's, never worked in or archived by the project. When it has uncommitted changes
// the dialog says so, and the person chooses whether the project's workspace gets them too. Offered in a local
// workspace's header while its repository is in an organization with a program manager, and it isn't an employee's run,
// a project's workspace, or handed to a project still open.
import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { api, attempt, openEmployees, openHandToPm, showToast, useStore } from '../../store'
import { Button, Dialog, Field, RadioList, TextArea } from '../../ui'

/** The program manager a workspace could be handed to, or undefined. */
export function useHandToPm(workspaceId: string): { orgId: string; name: string } | undefined {
  const ws = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId))
  const org = useStore((s) => {
    const repo = ws ? s.snapshot!.repos.find((r) => r.id === ws.repoId) : undefined
    return repo?.spaceId ? s.snapshot!.organizations?.find((o) => o.id === repo.spaceId) : undefined
  })
  const pm = useStore((s) => (org?.programManagerId ? s.snapshot!.employees?.[org.id]?.employees.find((e) => e.id === org.programManagerId) : undefined))
  const taken = useStore((s) => (org ? (s.snapshot!.projects?.[org.id] ?? []).some((p) => (p.workspaceId === workspaceId || p.fromWorkspaceId === workspaceId) && p.phase !== 'closed') : false))
  if (!ws || !org || !pm || taken || ws.startedBy?.via === 'employee' || ws.repoId === org.memoryRepoId) return undefined
  return { orgId: org.id, name: pm.name || pm.id }
}

type Changes = 'include' | 'leave'

export function HandToPmDialog({ workspaceId }: { workspaceId: string }) {
  const t = useT()
  const target = useHandToPm(workspaceId)
  const ws = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId))
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  // Files with uncommitted changes in it (null until git has said), and whether they go to the project too.
  const [uncommitted, setUncommitted] = useState<number | null>(null)
  const [changes, setChanges] = useState<Changes | undefined>(undefined)
  useEffect(() => {
    let live = true
    void api
      .gitStatus(workspaceId)
      .then((s) => live && setUncommitted(s.uncommitted))
      .catch(() => live && setUncommitted(0))
    return () => {
      live = false
    }
  }, [workspaceId])
  const close = () => !busy && openHandToPm(null)
  if (!target || !ws) return null
  const choose = Boolean(uncommitted)
  const ready = Boolean(text.trim()) && uncommitted !== null && (!choose || changes !== undefined)
  const hand = () => {
    if (!ready || busy) return
    setBusy(true)
    void attempt(async () => {
      const project = await api.startProject(target.orgId, { requirement: text, fromWorkspaceId: workspaceId, ...(choose ? { includeChanges: changes === 'include' } : {}) })
      openHandToPm(null)
      showToast(t('projects.started', { title: project.title, name: target.name }))
      openEmployees({ orgId: target.orgId, page: 'project', id: project.id })
    }).finally(() => setBusy(false))
  }
  return (
    <Dialog
      title={t('projects.hand.title', { name: target.name })}
      description={t('projects.hand.description', { name: target.name, workspace: ws.name })}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!ready || busy} onClick={hand}>
            {t('projects.hand.go', { name: target.name })}
          </Button>
        </>
      }
    >
      <ul className="channel-hand-list">
        <li>{t('projects.hand.chat')}</li>
        <li>{t('projects.hand.newBranch', { branch: ws.branch })}</li>
        <li>{t('projects.hand.yours', { workspace: ws.name })}</li>
      </ul>
      {choose && (
        <RadioList<Changes>
          legend={t('projects.hand.changes', { count: uncommitted ?? 0 })}
          value={changes}
          onChange={setChanges}
          options={[
            { value: 'include', label: t('projects.hand.include'), description: t('projects.hand.includeHint') },
            { value: 'leave', label: t('projects.hand.leave'), description: t('projects.hand.leaveHint') }
          ]}
        />
      )}
      <Field label={t('projects.hand.label', { name: target.name })}>
        {(control) => (
          <TextArea
            {...control}
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return
              e.preventDefault()
              hand()
            }}
          />
        )}
      </Field>
    </Dialog>
  )
}
