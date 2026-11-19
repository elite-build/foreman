// The jobs a flow does (docs/loops-and-graphs.md, "Finding a flow"): Automations asks "I want to…" and shows the flows
// that do the job picked. A flow names its jobs in its file (`jobs = ["fix", "build"]`), the built-in starters too, so a
// copy keeps them; a flow with none is listed only under All flows. A job may point at the prompt template that does it
// in one turn, for when a whole flow is more than the job needs.

export const FLOW_JOBS = ['build', 'fix', 'review', 'ship', 'maintain', 'decide'] as const
export type FlowJob = (typeof FLOW_JOBS)[number]

export const isFlowJob = (value: unknown): value is FlowJob => typeof value === 'string' && (FLOW_JOBS as readonly string[]).includes(value)

/** The prompt template (promptTemplates.ts) that does a job in one turn, where there is one. */
export const JOB_TEMPLATE: Partial<Record<FlowJob, string>> = {
  fix: 'default-fix-bug',
  review: 'default-review',
  ship: 'default-fix-issue'
}

/** The flows that do `job`, in the order given; with no job, all of them. */
export function flowsForJob<T extends { jobs?: readonly FlowJob[] }>(flows: readonly T[], job: FlowJob | null): T[] {
  return job ? flows.filter((f) => f.jobs?.includes(job)) : [...flows]
}
