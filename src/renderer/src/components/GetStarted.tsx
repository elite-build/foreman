// The Get started row on Home, under the work: things worth trying, each with a "Show me" that opens the real place.
// Folded it is one row (a meter, the next step and its Show me); opened, the whole list in place. Some items are
// milestones (recorded once, never undone); the agent is live and can go back to "Needs attention" (see
// shared/onboarding.ts). "Hide checklist" puts it away; ⌘K → Get started checklist brings it back.
import { useEffect, useId, useState } from 'react'
import { useAgentReadiness } from '../agentReadiness'
import type { AgentKind } from '../../../shared/agents'
import type { PlainKey } from '../../../shared/i18n'
import { useT } from '../i18n'
import { CHECKLIST_MORE, checklistShown, deriveChecklist, type ChecklistItemId, type ChecklistMoreId, type ChecklistStatus } from '../../../shared/onboarding'
import { newWorkspaceTarget } from '../../../shared/organizations'
import { shortcutHint } from '../shortcuts'
import {
  addRepository,
  api,
  attempt,
  loadAssistant,
  openAssistant,
  openAutomations,
  openNewWorkspace,
  openOverlay,
  openPhoneSetup,
  openSettingsPage,
  recordMilestone,
  setChecklistHidden,
  setChecklistOpen,
  setSidebarFilter,
  showToast,
  useStore,
  getState
} from '../store'
import { Button, Card, Disclosure, LinkButton, Meter, Status, type StatusTone } from '../ui'
import './getStarted.css'

const COPY: Record<ChecklistItemId, { title: PlainKey; body: PlainKey }> = {
  comfortable: { title: 'getStarted.item.comfortable.title', body: 'getStarted.item.comfortable.body' },
  agent: { title: 'getStarted.item.agent.title', body: 'getStarted.item.agent.body' },
  project: { title: 'getStarted.item.project.title', body: 'getStarted.item.project.body' },
  workspace: { title: 'getStarted.item.workspace.title', body: 'getStarted.item.workspace.body' },
  needsYou: { title: 'getStarted.item.needsYou.title', body: 'getStarted.item.needsYou.body' },
  tiles: { title: 'getStarted.item.tiles.title', body: 'getStarted.item.tiles.body' },
  template: { title: 'getStarted.item.template.title', body: 'getStarted.item.template.body' },
  automation: { title: 'getStarted.item.automation.title', body: 'getStarted.item.automation.body' },
  assistant: { title: 'getStarted.item.assistant.title', body: 'getStarted.item.assistant.body' },
  mcp: { title: 'getStarted.item.mcp.title', body: 'getStarted.item.mcp.body' }
}

// The state in words as well as a shape: Status draws both.
const STATUS: Record<ChecklistStatus, { tone: StatusTone; label: PlainKey }> = {
  done: { tone: 'ok', label: 'getStarted.status.done' },
  todo: { tone: 'off', label: 'getStarted.status.todo' },
  attention: { tone: 'warn', label: 'getStarted.status.attention' },
  'needs-claude': { tone: 'info', label: 'getStarted.status.needsClaude' }
}

const MORE: Record<ChecklistMoreId, PlainKey> = {
  cloud: 'getStarted.more.cloud',
  phone: 'getStarted.more.phone',
  backup: 'getStarted.more.backup',
  shortcuts: 'getStarted.more.shortcuts'
}

/** The repository "Show me" works in: the one New workspace opens on (the one Home is scoped to, else the space's first). */
function targetRepo(): string | undefined {
  const { snapshot, sidebarView, space } = getState()
  if (!snapshot) return undefined
  return newWorkspaceTarget(snapshot, { space, picked: sidebarView.repo, selectedWorkspaceId: null })
}

/** A "Show me" that needs a project, with none: the way to add one opens instead. */
function withRepo(open: (repoId: string) => void): void {
  const repoId = targetRepo()
  if (repoId) open(repoId)
  else void addRepository()
}

/** What each item's "Show me" does. It opens the place; the milestone is recorded by the thing the person then does there. */
export function showMe(id: ChecklistItemId, t: ReturnType<typeof useT>): void {
  const { snapshot, selectedWorkspaceId } = getState()
  const palette = shortcutHint('palette.toggle', snapshot?.platform) ?? ''
  switch (id) {
    case 'comfortable':
      return openSettingsPage({ section: 'accessibility' })
    case 'agent':
      return openSettingsPage({ section: 'agents' })
    case 'project':
      return void addRepository()
    case 'workspace':
      return withRepo((repoId) => openNewWorkspace(repoId))
    case 'needsYou':
      setSidebarFilter('needs-you')
      return showToast(t('getStarted.needsYou.shown'))
    case 'tiles': {
      if (snapshot?.settings.windowLayout === 'tiles') {
        // Already there: that counts, and the way back is worth knowing.
        recordMilestone('tiles')
        return showToast(t('getStarted.tiles.already', { key: palette }))
      }
      // Main records the milestone when the layout changes (from here, ⌘K or Settings).
      void attempt(() => api.updateSettings({ windowLayout: 'tiles' })).then((saved) => saved && showToast(t('getStarted.tiles.done', { key: palette })))
      return
    }
    case 'template':
      // ⌘J needs an open workspace; with none open, New workspace has the template button.
      if (selectedWorkspaceId) return openAutomations()
      return withRepo((repoId) => openNewWorkspace(repoId))
    case 'automation':
      return openAutomations()
    case 'assistant':
      return openAssistant()
    case 'mcp':
      return withRepo((repoId) => openSettingsPage({ section: 'repo', repoId, tab: 'actions' }))
  }
}

function openMore(id: ChecklistMoreId): void {
  if (id === 'cloud') openSettingsPage({ section: 'cloud' })
  else if (id === 'phone') openPhoneSetup(true)
  else if (id === 'backup') openSettingsPage({ section: 'data', scrollTo: 'git-backup-destination' })
  else openOverlay('shortcuts')
}

/** The checklist as it stands now, and whether Home shows it. */
export function useGetStarted() {
  const onboarding = useStore((s) => s.snapshot!.settings.onboarding)
  const repoCount = useStore((s) => s.snapshot!.repos.length)
  const workspaceCount = useStore((s) => s.snapshot!.workspaces.length)
  const agent = (useStore((s) => s.snapshot!.settings.loadouts[0]?.agent) ?? 'claude') as AgentKind
  const readiness = useAgentReadiness(agent)
  const assistantGate = useStore((s) => s.assistant?.gate)
  const assistantLoaded = useStore((s) => Boolean(s.assistant))
  // Whether the assistant can run isn't known until asked (it says "needs Claude" when it can't).
  useEffect(() => {
    if (!assistantLoaded) void loadAssistant()
  }, [assistantLoaded])
  const checklist = deriveChecklist({ onboarding: onboarding ?? { milestones: {}, checklistHidden: true }, repoCount, workspaceCount, agent: readiness, assistantGate })
  return { checklist, shown: Boolean(onboarding) && checklistShown(onboarding, checklist) }
}

/**
 * Get started, folded to one row under the work: its name (a disclosure that opens the full list in place, remembered),
 * a meter of how many are done, the next step with its Show me, and Hide checklist. `expanded`: open to begin with,
 * for a first run with nothing else on Home.
 */
export function GetStarted({ expanded = false }: { expanded?: boolean }) {
  const t = useT()
  const { checklist, shown } = useGetStarted()
  const platform = useStore((s) => s.snapshot?.platform)
  const remembered = useStore((s) => Boolean(s.checklistOpen))
  const [folded, setFolded] = useState(false)
  const titleId = useId()
  if (!shown) return null
  const open = expanded ? !folded : remembered
  const toggle = (next: boolean) => (expanded ? setFolded(!next) : setChecklistOpen(next))

  const hide = () => {
    void setChecklistHidden(true)
    const key = shortcutHint('palette.toggle', platform) ?? ''
    // The card is gone, so the way back is said (the toast is a live region).
    showToast(t('getStarted.hidden', { key }))
  }
  const progress = t('getStarted.progress', { done: checklist.done, total: checklist.total })
  // To-dos first, done ones after them; the next step is the first not done.
  const items = [...checklist.items.filter((i) => i.status !== 'done'), ...checklist.items.filter((i) => i.status === 'done')]
  const next = items.find((i) => i.status !== 'done')
  const nextTitle = next ? t(COPY[next.id].title) : undefined

  return (
    <Card as="section" className="get-started" aria-labelledby={titleId}>
      <h2 id={titleId} className="sr-only">
        {t('getStarted.title')}
      </h2>
      <Disclosure className="get-started-fold" open={open} onOpenChange={toggle} label={<span className="get-started-title">{t('getStarted.title')}</span>}>
        <ul className="get-started-list" aria-label={t('getStarted.list')}>
          {items.map((item) => {
            const title = t(COPY[item.id].title)
            const status = STATUS[item.status]
            const body = item.id === 'assistant' && item.status === 'needs-claude' ? t('getStarted.item.assistant.needsClaude') : t(COPY[item.id].body)
            return (
              <li key={item.id} className="get-started-item" data-status={item.status}>
                <Status className="get-started-status" tone={status.tone} label={t(status.label)} />
                <span className="get-started-text">
                  <span className="get-started-name">{title}</span> <span className="get-started-body">{body}</span>
                </span>
                {item.status !== 'done' && (
                  <Button size="sm" aria-label={t('getStarted.showMeItem', { item: title })} onClick={() => showMe(item.id, t)}>
                    {t('getStarted.showMe')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
        <Disclosure className="get-started-more" label={t('getStarted.more')}>
          <ul className="get-started-more-list">
            {CHECKLIST_MORE.map((id) => (
              <li key={id}>
                <LinkButton onClick={() => openMore(id)}>{t(MORE[id])}</LinkButton>
              </li>
            ))}
          </ul>
        </Disclosure>
      </Disclosure>
      <Meter className="get-started-meter" value={checklist.done} max={Math.max(1, checklist.total)} label={t('getStarted.meter')} valueText={progress} />
      <span className="get-started-progress" aria-hidden>
        {progress}
      </span>
      {/* The next step, with its Show me, while the list is folded (open, every step has its own). */}
      {next && nextTitle && !open && (
        <span className="get-started-next">
          <span className="get-started-next-text">{t('getStarted.next', { item: nextTitle })}</span>
          <Button size="sm" aria-label={t('getStarted.showMeItem', { item: nextTitle })} onClick={() => showMe(next.id, t)}>
            {t('getStarted.showMe')}
          </Button>
        </span>
      )}
      <Button size="sm" variant="ghost" className="get-started-hide" onClick={hide}>
        {t('getStarted.hide')}
      </Button>
    </Card>
  )
}
