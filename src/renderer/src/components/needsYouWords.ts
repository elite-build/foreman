// The words for what needs the person (src/shared/needsYou.ts), shared by the sidebar's rows and Home's block: each
// item's kind as a tag, its title, the line under it, and where opening it goes. Text only; the views lay it out.
import type { EmployeeActionPayload } from '../../../shared/employeeActions'
import type { NeedsYouItem } from '../../../shared/needsYou'
import { partTitle, WAIT_KIND_KEY } from './employees/projectWords'
import type { AppSnapshot } from '../../../shared/types'
import type { RendererT } from '../i18n'
import { openEmployees } from '../store'
import type { TagTone } from '../ui'

/** The employee an item is from: its name (its id while its file can't be read) and hat colour. */
export function employeeOf(snapshot: AppSnapshot, item: Pick<NeedsYouItem, 'orgId' | 'employeeId'>): { name: string; colour: string } | undefined {
  if (!item.orgId || !item.employeeId) return undefined
  const e = snapshot.employees?.[item.orgId]?.employees.find((x) => x.id === item.employeeId)
  return { name: e?.name || item.employeeId, colour: e?.colour ?? 'slate' }
}

/** A question's first line, the way it is shown in one line. */
const firstLine = (text: string | undefined): string => text?.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''

/** The space's name: an organization's, or Personal. */
export function spaceLabel(snapshot: AppSnapshot, space: string | null, t: RendererT): string {
  return (space && snapshot.organizations?.find((o) => o.id === space)?.name) || t('spaces.personal')
}

/** An item that is the employee's own (a question its workspace says counts as the question, not the workspace). */
export const isEmployeeItem = (item: NeedsYouItem): boolean => item.kind !== 'workspace' || Boolean(item.task?.question)

/** The item's kind as a tag, in words and a state shape; undefined for a workspace, whose triage label is its tag. */
export function kindTag(item: NeedsYouItem, t: RendererT): { label: string; tone: TagTone } | undefined {
  if (item.kind === 'workspace') return item.task?.question ? { label: t('needsYou.kind.question'), tone: 'warn' } : undefined
  switch (item.kind) {
    case 'question':
      return { label: t('needsYou.kind.question'), tone: 'warn' }
    case 'task':
      return { label: t('needsYou.kind.task'), tone: 'warn' }
    case 'action':
      if (item.action?.state === 'failed') return { label: t('needsYou.kind.actionFailed'), tone: 'error' }
      return { label: t(item.action?.state === 'uncertain' ? 'needsYou.kind.actionUncertain' : 'needsYou.kind.action'), tone: 'warn' }
    case 'proposal':
      return { label: t('needsYou.kind.proposal'), tone: 'warn' }
    case 'paused':
      return { label: t('needsYou.kind.paused'), tone: 'warn' }
    case 'project':
      return { label: t(item.wait?.kind === 'stuck' ? 'needsYou.kind.projectStuck' : 'needsYou.kind.project'), tone: 'warn' }
  }
}

/** "Max wants to push max/launch-2.4": what an outward action would do, said as the employee's. */
function actionTitle(name: string, p: EmployeeActionPayload, t: RendererT): string {
  switch (p.kind) {
    case 'push':
      return t('needsYou.title.push', { name, branch: p.branch })
    case 'pull-request':
      return t('needsYou.title.pullRequest', { name, title: p.title })
    case 'slack-post':
      return t('needsYou.title.slack', { name, channel: p.channelName ? `#${p.channelName}` : p.channel })
    case 'linear':
      return t('needsYou.title.linear', { name, tool: p.issue ? `${p.tool} ${p.issue}` : p.tool })
  }
}

/** Home's title for an employee's item ("Ada: Which day does 2.4 launch?"); undefined for a plain workspace. */
export function itemTitle(item: NeedsYouItem, snapshot: AppSnapshot, t: RendererT): string | undefined {
  const name = employeeOf(snapshot, item)?.name ?? ''
  if (item.task?.question) return t('needsYou.title.question', { name, question: firstLine(item.task.question.question) })
  if (item.kind === 'task' && item.task) return t('needsYou.title.task', { name, title: item.task.title })
  if (item.kind === 'action' && item.action) return actionTitle(name, item.action.payload, t)
  if (item.kind === 'proposal' && item.proposal) return t('needsYou.title.proposal', { name, path: item.proposal.path })
  if (item.kind === 'paused') return t('needsYou.title.paused', { name })
  if (item.kind === 'project' && item.project && item.wait) {
    const title = item.project.title
    switch (item.wait.kind) {
      case 'plan':
        return t('needsYou.title.projectPlan', { title })
      case 'gate':
        return t('needsYou.title.projectGate', { title, part: partTitle(item.project, item.wait.partId) })
      case 'stuck':
        return t('needsYou.title.projectStuck', { title })
      case 'final':
        return t('needsYou.title.projectFinal', { title })
    }
  }
  return undefined
}

/** The line under an employee's item: how to answer, that it leaves the computer, what it proposes, how it stopped. */
export function itemSub(item: NeedsYouItem, t: RendererT): string[] {
  const where = item.triage ? t('needsYou.inWorkspace', { name: item.triage.ws.name }) : undefined
  if (item.task?.question) {
    const options = item.task.question.options.length
    return [options ? t('needsYou.choices', { count: options }) : t('needsYou.ownWords'), where].filter((x): x is string => Boolean(x))
  }
  if (item.kind === 'task') return [item.task?.reason].filter((x): x is string => Boolean(x))
  if (item.kind === 'action') return [t('needsYou.leaves')]
  if (item.kind === 'proposal' && item.proposal) {
    const text = firstLine(item.proposal.text).replace(/^[-*]\s+/, '')
    return text ? [t('triage.quote', { text })] : []
  }
  if (item.kind === 'paused') return [item.detail].filter((x): x is string => Boolean(x))
  if (item.kind === 'project' && item.wait) return [item.wait.kind === 'stuck' ? item.wait.reason : t(item.wait.kind === 'plan' ? 'needsYou.projectPlanSub' : 'needsYou.projectGateSub')].filter((x): x is string => Boolean(x))
  return []
}

/** The sidebar's row for an employee's item with no workspace of its own: its title and the amber line under it. */
export function rowWords(item: NeedsYouItem, snapshot: AppSnapshot, t: RendererT, noun: (p: EmployeeActionPayload) => string): { title: string; label: string } {
  const tag = kindTag(item, t)?.label ?? ''
  const name = employeeOf(snapshot, item)?.name ?? ''
  if (item.task?.question) return { title: firstLine(item.task.question.question), label: t('triage.employee.asks', { name }) }
  if (item.kind === 'task' && item.task) return { title: item.task.title, label: [tag, item.task.reason].filter(Boolean).join(' · ') }
  if (item.kind === 'action' && item.action) return { title: noun(item.action.payload), label: `${tag} · ${t('needsYou.leavesShort')}` }
  if (item.kind === 'proposal' && item.proposal) return { title: t('needsYou.proposalRow'), label: `${tag} · ${item.proposal.path.split('/').at(-1)}` }
  if (item.kind === 'project' && item.project && item.wait) return { title: item.project.title, label: `${tag} · ${item.wait.kind === 'gate' ? partTitle(item.project, item.wait.partId) : t(WAIT_KIND_KEY[item.wait.kind])}` }
  return { title: name, label: [tag, item.detail].filter(Boolean).join(' · ') }
}

/**
 * Where an employee's item is decided: the Team page, where its question, held action and proposal cards are; a pause,
 * on the employee's page. (A workspace item opens its workspace, which the caller does.)
 */
export function openEmployeeItem(item: NeedsYouItem): void {
  if (!item.orgId) return
  if (item.kind === 'project' && item.project) return openEmployees({ orgId: item.orgId, page: 'project', id: item.project.id })
  if (item.kind === 'paused' && item.employeeId) return openEmployees({ orgId: item.orgId, page: 'employee', id: item.employeeId })
  openEmployees({ orgId: item.orgId, page: 'team' })
}
