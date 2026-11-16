// What a project's employees are doing right now (docs/ai-employees.md §15), from the runs in the snapshot: a channel's
// stage ("Working", "Planning") says where the project is, not whether anyone is at it. A line at the foot of the channel
// per step being done (who, on what, for how long, a link to watch the chat), a word beside the channel's state (who is
// working, or Nothing running when its stage says it should be), and a turning ring on a channel's row while someone works.
import { useMemo } from 'react'
import { projectLive, type LiveRunInput, type Project, type ProjectLive } from '../../../../shared/projects'
import { useClock } from '../../clock'
import { useT } from '../../i18n'
import { selectSession, selectWorkspace, useStore } from '../../store'
import { LinkButton, Status } from '../../ui'
import { formatDuration } from '../turnResult'
import { partTitle } from './projectWords'

type T = ReturnType<typeof useT>

const NO_RUNS: readonly LiveRunInput[] = []

/** An organization's runs that haven't ended. */
export function useOrgRuns(orgId: string): readonly LiveRunInput[] {
  return useStore((s) => s.snapshot!.employeeWork?.[orgId]?.runs ?? NO_RUNS)
}

/** The project's steps being done now, working first. */
export function useProjectLive(project: Project): ProjectLive[] {
  const runs = useOrgRuns(project.orgId)
  return useMemo(() => projectLive(project, runs), [project, runs])
}

/** What the step's employee is doing, in a sentence: "Ravi is working on “Build the export”". */
export function liveWhat(project: Pick<Project, 'plan' | 'plans'>, live: ProjectLive, who: string, t: T): string {
  const { step } = live
  if (step.kind === 'plan') return t('projects.live.plan', { name: who })
  if (step.kind === 'accept') return t('projects.live.accept', { name: who })
  if (step.kind === 'follow-up') return t('projects.live.followUp', { name: who })
  return t('projects.live.part', { name: who, part: partTitle(project, step.partId) })
}

/** Opens the chat the run works in. */
function watch(live: ProjectLive) {
  if (!live.workspaceId) return
  selectWorkspace(live.workspaceId)
  if (live.sessionId) selectSession(live.workspaceId, live.sessionId)
}

/** How long, ticking once a second. Not a live region: a screen reader reads it when it reaches it, not every second. */
function Elapsed({ since }: { since: string }) {
  const now = useClock(1000)
  return <span className="mono">{formatDuration(Math.floor(Math.max(0, now - Date.parse(since)) / 1000) * 1000)}</span>
}

/** The lines at the foot of a channel's timeline, one per step being done: who, on what, for how long, and Watch. */
export function LiveLines({ project, live, who }: { project: Project; live: readonly ProjectLive[]; who: (employeeId: string) => string }) {
  const t = useT()
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  return (
    <>
      {live.map((l) => {
        const name = who(l.step.employeeId)
        return (
          <li key={l.runId} className="channel-live">
            <Status tone={l.state === 'queued' ? 'off' : 'info'} busy={l.state !== 'queued'} label={liveWhat(project, l, name, t)} />
            <span className="employee-faint">{l.state === 'working' ? <Elapsed since={l.since} /> : l.state === 'starting' ? t('projects.live.starting') : (l.reason ?? t('projects.live.queued'))}</span>
            {l.workspaceId && workspaces.some((w) => w.id === l.workspaceId) && (
              <LinkButton size="sm" underline onClick={() => watch(l)}>
                {t('projects.live.watch', { name })}
              </LinkButton>
            )}
          </li>
        )
      })}
    </>
  )
}

/** Whether anyone is at work on the project now (its turn with the agent). */
export const isWorking = (live: readonly ProjectLive[]): boolean => live.some((l) => l.state === 'working')

/**
 * Beside a channel's state: who is working ("Ravi working 2m 5s"), or that it is starting or queued, or Nothing running
 * when its stage (planning, working, checking) says someone should be and no one is. Nothing for a stage that waits on you.
 */
export function LiveTag({ live, busyStage, who }: { live: readonly ProjectLive[]; busyStage: boolean; who: (employeeId: string) => string }) {
  const t = useT()
  const working = live.filter((l) => l.state === 'working')
  if (working.length === 1)
    return (
      <Status tone="info" busy label={t('projects.live.tagOne', { name: who(working[0].step.employeeId) })}>
        <Elapsed since={working[0].since} />
      </Status>
    )
  if (working.length > 1) return <Status tone="info" busy label={t('projects.live.tagMany', { count: working.length })} />
  if (live.length) return <Status tone={live[0].state === 'starting' ? 'info' : 'off'} busy={live[0].state === 'starting'} label={t(live[0].state === 'starting' ? 'projects.live.tagStarting' : 'projects.live.tagQueued')} />
  return busyStage ? <Status tone="off" label={t('projects.live.idle')} /> : null
}
