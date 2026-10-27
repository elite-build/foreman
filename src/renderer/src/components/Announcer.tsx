import { useEffect, useRef } from 'react'
import type { ApprovalRequest, Session } from '../../../shared/types'
import { AGENTS } from '../../../shared/agents'
import type { TFunction } from '../../../shared/i18n'
import { announce, announcer, useSpoken } from '../announce'
import { announcePolicy, earconsFor, filterEvents, sessionStatuses, statusEvents, turnEndedSentence, type StatusKind, type StatusMap } from '../agentStatus'
import { useLocale, useT } from '../i18n'
import { playEventEarcon } from '../sound'
import { speech } from '../speech'
import { activeSessionId, dismissToast, getState, runToastAction, subscribeLive, useStore } from '../store'
import { LinkButton } from '../ui'

function statusText(kind: StatusKind, name: string, t: TFunction): string {
  switch (kind) {
    case 'started':
      return t('a11y.agent.started', { name })
    case 'needs-approval':
      return t('a11y.agent.needsApproval', { name })
    case 'needs-question':
      return t('a11y.agent.needsQuestion', { name })
    case 'needs-plan':
      return t('a11y.agent.needsPlan', { name })
    case 'finished':
      return t('a11y.agent.finished', { name })
    case 'failed':
      return t('a11y.agent.failed', { name })
    case 'stopped':
      return t('a11y.agent.stopped', { name })
  }
}

const ENDED: ReadonlySet<StatusKind> = new Set(['finished', 'failed', 'stopped'])

// The chat on screen: the selected workspace's active tab, unless Settings, Automations or the Assistant cover it.
const openSessionId = (s: ReturnType<typeof getState>): string | undefined => (s.settingsPage || s.automations || s.assistantOpen || !s.selectedWorkspaceId ? undefined : activeSessionId(s, s.selectedWorkspaceId))

/**
 * Says what the agents are doing, as far as the announcement setting allows. A chat that needs the user (an approval, a
 * question, a plan to review) is said wherever it is, in every setting. Started, finished, failed and stopped are said
 * for the open chat ("My open chat", the default), for no chat ("Only what needs me") or for every chat ("All chats").
 * A turn that ended is said as the narrator's sentence (what changed, the checks) unless that is turned off. With sound
 * cues on, each event also plays its cue; one voice and one cue per event.
 */
function useAgentStatusAnnouncements(): void {
  const t = useT()
  const tRef = useRef(t)
  tRef.current = t
  const sessions = useStore((s) => s.snapshot?.sessions)
  const workspaces = useStore((s) => s.snapshot?.workspaces)
  const approvals = useStore((s) => s.approvals)
  const openId = useStore(openSessionId)
  const previous = useRef<StatusMap | null>(null)
  // The sessions and approvals last looked at: most changes (a streaming chat) touch neither, and cost nothing here.
  const seen = useRef<{ sessions: Session[]; approvals: ApprovalRequest[] } | null>(null)

  // Reads the store as it is now, so the render below and the hidden window's changes agree on what was already said.
  const check = useRef(() => {
    const s = getState()
    const sessions = s.snapshot?.sessions
    if (!sessions) return
    if (seen.current?.sessions === sessions && seen.current.approvals === s.approvals) return
    seen.current = { sessions, approvals: s.approvals }
    const workspaces = s.snapshot?.workspaces
    const openId = openSessionId(s)
    const next = sessionStatuses(sessions, s.approvals)
    const isOpen = (id: string) => id === openId
    const current = s.snapshot?.settings
    const policy = announcePolicy(current?.announce)
    const all = statusEvents(previous.current, next, sessions, () => true)
    previous.current = next
    if (current?.earcons) for (const cue of new Set(earconsFor(all, policy, isOpen))) playEventEarcon(current, cue)
    for (const event of filterEvents(all, policy, isOpen)) {
      const session = sessions.find((s) => s.id === event.sessionId)
      if (!session) continue
      const agent = AGENTS[session.agent]?.label ?? session.agent
      // Say which chat only when it isn't the one in front of the user.
      const workspace = workspaces?.find((w) => w.id === session.workspaceId)
      const name = event.sessionId === openId ? agent : [workspace?.name, session.title || agent].filter(Boolean).join(', ')
      const summary = ENDED.has(event.kind) && current?.announceSummary === true ? turnEndedSentence(tRef.current, session, workspace, event.kind as 'finished' | 'failed' | 'stopped') : null
      // One announcement per chat: a later one (finished) replaces an earlier one (started) that has not been spoken yet.
      announce(summary ?? statusText(event.kind, name, tRef.current), `status:${event.sessionId}`)
    }
  }).current

  useEffect(check, [check, sessions, workspaces, approvals, openId])
  // A minimized or hidden window doesn't re-render (store.ts, `held`), but a chat that finishes or needs you meanwhile
  // still gets its cue and its words, as it happens: shown again, there is nothing left over to say.
  useEffect(() => subscribeLive(() => getState().windowVisible || check()), [check])
}

/**
 * Tells the announcer and the voice where their settings are (read when they are needed, so a change applies to what is
 * still waiting), and stops the voice when Foreman's voice is turned off.
 */
function useSpeechSettings(): void {
  const settings = useStore((s) => s.snapshot?.settings)
  const locale = useLocale()
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const localeRef = useRef(locale)
  localeRef.current = locale
  useEffect(() => {
    announcer.configure({ getMode: () => (settingsRef.current?.speechOutput === 'on' ? 'on' : 'off') })
    speech.configure(() => ({ voice: settingsRef.current?.speechVoice, rate: settingsRef.current?.speechRate, volume: settingsRef.current?.speechVolume, language: localeRef.current }))
    return () => speech.configure(undefined)
  }, [])
  const on = settings?.speechOutput === 'on'
  useEffect(() => {
    if (!on) speech.cancel()
  }, [on])
}

/** The window's one polite live region, and the watcher that feeds it. Mounted once, in App. */
export function Announcer() {
  useAgentStatusAnnouncements()
  useSpeechSettings()
  const { text, nonce } = useSpoken()
  // The text sits in a node of its own, so a repeat of the same words is a new addition and is spoken again.
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-ui-live>
      {text && <span key={nonce}>{text}</span>}
    </div>
  )
}

/**
 * Toasts, in two live regions that are always in the page and filled when a toast arrives (a region inserted together
 * with its text is announced unreliably): an error goes to the alert, anything else to the status. The regions are
 * zero-size and fixed, so they take no room in the layout.
 */
export function ToastHost() {
  const toast = useStore((s) => s.toast)
  // A toast whose words the announcer already said (`silent`) is shown outside the live regions: one voice per event.
  const live = toast && !toast.silent
  const body = toast && (
    <div className={`toast ${toast.kind}`} onClick={dismissToast}>
      {toast.text}
      {toast.actions?.map((a, i) => (
        <LinkButton
          key={i}
          underline
          className="toast-action"
          onClick={(e) => {
            e.stopPropagation()
            runToastAction(toast.id, i)
          }}
        >
          {a.label}
        </LinkButton>
      ))}
    </div>
  )
  return (
    <>
      <div className="toast-host" role="status" data-ui-live>
        {live && toast.kind !== 'error' && body}
      </div>
      <div className="toast-host" role="alert" data-ui-live>
        {live && toast.kind === 'error' && body}
      </div>
      <div className="toast-host" data-ui-live>
        {toast?.silent && body}
      </div>
    </>
  )
}
