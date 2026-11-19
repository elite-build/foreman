// What the person typed or chose in a project's decision cards (answers to the program manager's questions, a note at a
// gate, a pick), kept by project and wait while they look elsewhere: the channel's page unmounts on every route change,
// and its cards with it. A draft goes once it is sent or what it answers is gone. Kept for this window's run only.
import { useState } from 'react'

const drafts = new Map<string, unknown>()
const prefix = (projectId: string, waitId: string) => `${projectId}\u0000${waitId}\u0000`

/** A card's field, as useState, kept between visits: `field` names it within the wait (answers, note, pick…). */
export function useWaitDraft<T>(projectId: string, waitId: string, field: string, initial: T): [T, (next: T) => void] {
  const key = `${prefix(projectId, waitId)}${field}`
  const [value, setValue] = useState<T>(() => (drafts.has(key) ? (drafts.get(key) as T) : initial))
  const set = (next: T) => {
    drafts.set(key, next)
    setValue(next)
  }
  return [value, set]
}

/** A wait's drafts go: it was answered. */
export function clearWaitDrafts(projectId: string, waitId: string): void {
  const start = prefix(projectId, waitId)
  for (const key of [...drafts.keys()]) if (key.startsWith(start)) drafts.delete(key)
}

/** The drafts of a project's waits that are gone (decided elsewhere, replaced, the project closed) go. */
export function keepWaitDrafts(projectId: string, waitIds: readonly string[]): void {
  const keep = waitIds.map((id) => prefix(projectId, id))
  const mine = `${projectId}\u0000`
  for (const key of [...drafts.keys()]) if (key.startsWith(mine) && !keep.some((k) => key.startsWith(k))) drafts.delete(key)
}
