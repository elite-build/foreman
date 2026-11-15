// The store's view of what needs the person (src/shared/needsYou.ts): one list over every space, and its counts, for the
// sidebar, the rail, the Team rows, the space switcher and Home alike.
import { needsYouCounts, needsYouItems, type NeedsYouCounts, type NeedsYouItem } from '../../shared/needsYou'
import { triageAll, type Triage, type TriageInput } from '../../shared/triage'
import { useT } from './i18n'
import { useStore } from './store'

const NONE: Record<string, true> = {}

/** Everything triage needs, read from the store. */
export function useTriageInput(): TriageInput {
  const snapshot = useStore((s) => s.snapshot)!
  const approvals = useStore((s) => s.approvals)
  const unread = useStore((s) => s.unread) ?? NONE
  const unreadSessions = useStore((s) => s.unreadSessions) ?? NONE
  // Labels and facts in the UI language.
  const t = useT()
  return { snapshot, approvals: approvals ?? [], unread, unreadSessions, t }
}

export interface NeedsYou {
  // Every space's, oldest first.
  items: NeedsYouItem[]
  counts: NeedsYouCounts
  // Every live workspace, triaged (every space).
  triaged: Triage[]
}

/** What needs the person in every space, from `input` (the store's, unless a caller has its own, with its clock). */
export function needsYouOf(input: TriageInput): NeedsYou {
  const triaged = triageAll(input, null)
  const items = needsYouItems(input, triaged)
  return { items, counts: needsYouCounts(items), triaged }
}

export function useNeedsYou(): NeedsYou {
  return needsYouOf(useTriageInput())
}
