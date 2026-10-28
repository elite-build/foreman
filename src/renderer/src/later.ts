// Save for later in the window: the actions the sidebar's menu and Home's rows share, and a wake-up for the moment
// something comes back (the rules are in src/shared/later.ts).
import { useEffect, useReducer } from 'react'
import { laterUntil, nextLaterDue, type LaterChoice } from '../../shared/later'
import type { Workspace } from '../../shared/types'
import type { RendererT } from './i18n'
import { api, attempt, showToast, useStore } from './store'

const CHOICE_LABEL = {
  tomorrow: 'later.choice.tomorrow',
  'in-3-days': 'later.choice.in3Days',
  'next-week': 'later.choice.nextWeek',
  'no-date': 'later.choice.noDate'
} as const

/** "Tomorrow · Thu", "Next week · Mon", "No date". */
export function laterChoiceLabel(choice: LaterChoice, t: RendererT, now = Date.now()): string {
  const until = laterUntil(choice, now)
  const label = t(CHOICE_LABEL[choice])
  return until ? t('later.choice.withDay', { choice: label, day: new Date(until).toLocaleDateString(t.locale, { weekday: 'short' }) }) : label
}

/** When a saved workspace comes back: "Back Thu 30 Oct", or "No date". */
export function laterWhen(ws: Workspace, t: RendererT): string {
  const until = ws.later?.until
  return until ? t('later.backOn', { day: new Date(until).toLocaleDateString(t.locale, { weekday: 'short', day: 'numeric', month: 'short' }) }) : t('later.choice.noDate')
}

/** Put the workspace back as it was before a change, for Undo. */
function restore(ws: Workspace): Promise<void> {
  return api.updateWorkspace(ws.id, { later: ws.later ? { until: ws.later.until } : null })
}

export async function saveForLater(ws: Workspace, choice: LaterChoice, t: RendererT): Promise<void> {
  const until = laterUntil(choice, Date.now())
  const saved = await attempt(async () => (await api.updateWorkspace(ws.id, { later: until ? { until } : {} }), true))
  if (!saved) return
  const day = until ? new Date(until).toLocaleDateString(t.locale, { weekday: 'long' }) : null
  showToast(day ? t('later.toast.savedUntil', { name: ws.name, day }) : t('later.toast.saved', { name: ws.name }), 'info', {
    action: { label: t('home.board.undo'), run: () => restore(ws) }
  })
}

/** Out of Later, wherever it was: it goes back to where its facts put it. */
export async function takeOutOfLater(ws: Workspace, t: RendererT): Promise<void> {
  const done = await attempt(async () => (await api.updateWorkspace(ws.id, { later: null }), true))
  if (done) showToast(t('later.toast.removed', { name: ws.name }), 'info', { action: { label: t('home.board.undo'), run: () => restore(ws) } })
}

/** Its day, now: it comes back into Needs you. */
export async function bringBackNow(ws: Workspace): Promise<void> {
  await attempt(() => api.updateWorkspace(ws.id, { later: { until: new Date().toISOString() } }))
}

/** Draw again when the next saved workspace comes back, so it shows up in Needs you on time. */
export function useLaterWake(): void {
  const next = useStore((s) => nextLaterDue(s.snapshot?.workspaces ?? [], Date.now()))
  const [, wake] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (next === null) return
    // setTimeout holds at most ~24.8 days; a later wake-up just looks again.
    const timer = setTimeout(wake, Math.min(Math.max(0, next - Date.now()) + 500, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [next])
}
