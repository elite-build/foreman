// "Hand to Priya…" (docs/ai-employees.md §15): a workspace that grew becomes a project. The organization's program
// manager starts one from it, with its chat as her first input, and the workspace becomes the project's (its branch and
// files carry on). Offered in a local workspace's header while its repository is in an organization with a program
// manager, and it isn't an employee's run or a project's already.
import { useState } from 'react'
import { useT } from '../../i18n'
import { api, attempt, openEmployees, openHandToPm, showToast, useStore } from '../../store'
import { Button, Dialog, Field, TextArea } from '../../ui'

/** The program manager a workspace could be handed to, or undefined. */
export function useHandToPm(workspaceId: string): { orgId: string; name: string } | undefined {
  const ws = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId))
  const org = useStore((s) => {
    const repo = ws ? s.snapshot!.repos.find((r) => r.id === ws.repoId) : undefined
    return repo?.spaceId ? s.snapshot!.organizations?.find((o) => o.id === repo.spaceId) : undefined
  })
  const pm = useStore((s) => (org?.programManagerId ? s.snapshot!.employees?.[org.id]?.employees.find((e) => e.id === org.programManagerId) : undefined))
  const taken = useStore((s) => (org ? (s.snapshot!.projects?.[org.id] ?? []).some((p) => p.workspaceId === workspaceId && p.phase !== 'closed') : false))
  if (!ws || !org || !pm || taken || ws.startedBy?.via === 'employee' || ws.repoId === org.memoryRepoId) return undefined
  return { orgId: org.id, name: pm.name || pm.id }
}

export function HandToPmDialog({ workspaceId }: { workspaceId: string }) {
  const t = useT()
  const target = useHandToPm(workspaceId)
  const ws = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId))
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const close = () => !busy && openHandToPm(null)
  if (!target || !ws) return null
  const hand = () => {
    if (!text.trim() || busy) return
    setBusy(true)
    void attempt(async () => {
      const project = await api.startProject(target.orgId, { requirement: text, fromWorkspaceId: workspaceId })
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
          <Button variant="primary" disabled={!text.trim() || busy} onClick={hand}>
            {t('projects.hand.go', { name: target.name })}
          </Button>
        </>
      }
    >
      <ul className="channel-hand-list">
        <li>{t('projects.hand.chat')}</li>
        <li>{t('projects.hand.branch', { branch: ws.branch })}</li>
      </ul>
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
