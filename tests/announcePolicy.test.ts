// @vitest-environment jsdom
// Accessibility plan E2/A4: what the live region says by policy (needs me / my chat / all chats), the end-of-turn
// sentence against the short string, one channel per event (the announcer speaks it; its toast and the OS
// notification do not repeat it in a live region), and the narrator's sentences on notifications and Home rows.
import './domShims'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createT } from '../src/shared/i18n'
import type { ApprovalRequest, Session, Workspace } from '../src/shared/types'
import {
  announcePolicy,
  earconsFor,
  filterEvents,
  narratedNotice,
  needsYouSentence,
  turnEndedEventSentence,
  turnEndedSentence,
  workspaceNarration,
  type StatusEvent
} from '../src/renderer/src/agentStatus'
import { announcer } from '../src/renderer/src/announce'
import { Announcer, ToastHost } from '../src/renderer/src/components/Announcer'
import { fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => {
  const base = (await import('./rendererStore')).storeModule
  const own: Record<string, unknown> = {
    activeSessionId: (s: { activeSession?: Record<string, string> }, workspaceId: string) => s.activeSession?.[workspaceId],
    dismissToast: vi.fn(),
    runToastAction: vi.fn()
  }
  return new Proxy(base, { get: (target, name: string) => (name in own ? own[name] : target[name]), has: () => true })
})

const t = createT('en')
const session = (id: string, patch: Partial<Session> = {}): Session => ({ id, workspaceId: 'w1', agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], ...patch }) as Session
const workspace = (patch: Partial<Workspace> = {}): Workspace => ({ id: 'w1', repoId: 'r', name: 'api-fix', branch: 'api-fix', baseBranch: 'main', path: '/work/api-fix', state: 'ready', ...patch }) as Workspace
const passed = (n: number) => ({ running: false, results: Array.from({ length: n }, (_, i) => ({ name: `c${i}`, command: 'x', status: 'passed' })) }) as unknown as NonNullable<Workspace['checks']>
const ev = (sessionId: string, kind: StatusEvent['kind']): StatusEvent => ({ sessionId, kind })
const open = (id: string) => id === 's1'

describe('filterEvents', () => {
  const events = [ev('s1', 'started'), ev('s2', 'started'), ev('s1', 'finished'), ev('s2', 'finished'), ev('s2', 'failed'), ev('s2', 'stopped'), ev('s2', 'needs-approval'), ev('s1', 'needs-question'), ev('s2', 'needs-plan')]

  it("'needs-me' says only an approval, a question or a plan, in any chat", () => {
    expect(filterEvents(events, 'needs-me', open).map((e) => e.kind)).toEqual(['needs-approval', 'needs-question', 'needs-plan'])
  })

  it("'my-chat' is the rule from before the setting: needs you anywhere, the rest for the open chat", () => {
    expect(filterEvents(events, 'my-chat', open)).toEqual([ev('s1', 'started'), ev('s1', 'finished'), ev('s2', 'needs-approval'), ev('s1', 'needs-question'), ev('s2', 'needs-plan')])
  })

  it("'all' also says started, finished, failed and stopped for the other chats, in order", () => {
    expect(filterEvents(events, 'all', open)).toEqual(events)
  })

  it('reads a value it does not know as the default', () => {
    expect(announcePolicy(undefined)).toBe('my-chat')
    expect(announcePolicy('loud')).toBe('my-chat')
    expect(announcePolicy('needs-me')).toBe('needs-me')
    expect(announcePolicy('all')).toBe('all')
  })
})

describe('earconsFor', () => {
  it('cues each event by kind: needs you, started, finished, failed; stopped has none', () => {
    const events = [ev('s1', 'started'), ev('s1', 'needs-plan'), ev('s1', 'finished'), ev('s1', 'failed'), ev('s1', 'stopped')]
    expect(earconsFor(events, 'my-chat', open)).toEqual(['started', 'needs-me', 'finished', 'failed'])
  })

  it('follows the policy for started, but a turn that ends is cued in any chat, as the completion sound it replaces was', () => {
    const events = [ev('s2', 'started'), ev('s2', 'finished'), ev('s2', 'failed'), ev('s2', 'needs-approval')]
    expect(earconsFor(events, 'my-chat', open)).toEqual(['finished', 'failed', 'needs-me'])
    expect(earconsFor(events, 'needs-me', open)).toEqual(['finished', 'failed', 'needs-me'])
    expect(earconsFor(events, 'all', open)).toEqual(['started', 'finished', 'failed', 'needs-me'])
  })
})

describe('the end-of-turn sentence (A4)', () => {
  const done = session('s1', { lastTurn: { outcome: 'completed', endedAt: '2026-10-25T12:00:00Z', additions: 120, deletions: 14 } })

  it("is the narrator's, with the turn's lines and the checks, when it ended as the event says", () => {
    expect(turnEndedSentence(t, done, workspace({ checks: passed(12) }), 'finished')).toBe('Claude Code finished in api-fix: this turn +120 -14. Checks: 12 passed.')
  })

  it('says a failed or stopped turn the same way, and says stale checks as stale', () => {
    const failed = session('s1', { lastTurn: { outcome: 'error', endedAt: '', additions: 0, deletions: 0 } })
    expect(turnEndedSentence(t, failed, workspace(), 'failed')).toBe('Claude Code failed in api-fix.')
    const stopped = session('s1', { lastTurn: { outcome: 'cancelled', endedAt: '' } })
    expect(turnEndedSentence(t, stopped, workspace(), 'stopped')).toBe('Claude Code stopped in api-fix.')
    expect(turnEndedSentence(t, done, workspace({ checks: { ...passed(3), stale: true } }), 'finished')).toBe('Claude Code finished in api-fix: this turn +120 -14. Checks: 3 passed, stale.')
  })

  it('declines when the snapshot has not caught up with the event', () => {
    expect(turnEndedSentence(t, session('s1'), workspace(), 'finished')).toBeNull()
    expect(turnEndedSentence(t, done, workspace(), 'failed')).toBeNull()
  })

  describe('in the announcer', () => {
    const live = () => screen.getAllByRole('status')[0].textContent
    const settle = () => act(() => void vi.advanceTimersByTime(800))
    const setSessions = (sessions: Session[]) => {
      fakeState.snapshot.sessions = sessions
    }
    const finish = (rerender: (ui: ReturnType<typeof createElement>) => void) => {
      setSessions([session('s1', { status: 'running' })])
      rerender(createElement(Announcer))
      setSessions([done])
      rerender(createElement(Announcer))
      settle()
    }

    beforeEach(() => {
      vi.useFakeTimers()
      resetFake()
      announcer.reset()
      Object.assign(fakeState, { approvals: [], toast: null, settingsPage: null, selectedWorkspaceId: 'w1', activeSession: { w1: 's1' } })
      fakeState.snapshot.workspaces = [workspace({ checks: passed(12) })]
      fakeState.snapshot.sessions = [session('s1'), session('s2', { title: 'Other' })]
      Object.assign(fakeState.snapshot.settings, { announce: 'my-chat', announceSummary: true, earcons: false, sound: 'chime' })
    })
    afterEach(() => {
      cleanup()
      vi.useRealTimers()
    })

    it('says the sentence instead of the bare "finished" when the summary is on', () => {
      const { rerender } = render(createElement(Announcer))
      finish(rerender)
      expect(live()).toBe('Claude Code finished in api-fix: this turn +120 -14. Checks: 12 passed.')
    })

    it('says the short string when the summary is off', () => {
      fakeState.snapshot.settings.announceSummary = false
      const { rerender } = render(createElement(Announcer))
      finish(rerender)
      expect(live()).toBe('Claude Code finished.')
    })

    it("says only what needs me under 'needs-me': not started, not finished", () => {
      fakeState.snapshot.settings.announce = 'needs-me'
      const { rerender } = render(createElement(Announcer))
      finish(rerender)
      expect(live()).toBe('')
      fakeState.approvals = [{ id: 'a1', sessionId: 's1', kind: 'tool', toolName: 'Bash', input: {} } as ApprovalRequest]
      rerender(createElement(Announcer))
      settle()
      expect(live()).toBe('Claude Code needs your approval.')
    })

    it("names the workspace and the chat for another chat under 'all'", () => {
      fakeState.snapshot.settings.announce = 'all'
      fakeState.snapshot.settings.announceSummary = false
      const { rerender } = render(createElement(Announcer))
      setSessions([session('s1'), session('s2', { title: 'Other', status: 'running' })])
      rerender(createElement(Announcer))
      setSessions([session('s1'), session('s2', { title: 'Other', lastTurn: { outcome: 'completed', endedAt: '' } })])
      rerender(createElement(Announcer))
      settle()
      expect(live()).toBe('api-fix, Other finished.')
    })

    it('says nothing about another chat under the default', () => {
      const { rerender } = render(createElement(Announcer))
      setSessions([session('s1'), session('s2', { status: 'running' })])
      rerender(createElement(Announcer))
      setSessions([session('s1'), session('s2', { lastTurn: { outcome: 'completed', endedAt: '' } })])
      rerender(createElement(Announcer))
      settle()
      expect(live()).toBe('')
    })

    it('is one channel: one live announcement for a finished turn, and its silent toast is outside every live region', () => {
      const page = () => createElement('div', null, createElement(Announcer), createElement(ToastHost))
      const { rerender } = render(page())
      setSessions([session('s1', { status: 'running' })])
      rerender(page())
      setSessions([done])
      rerender(page())
      const sentence = 'Claude Code finished in api-fix: this turn +120 -14. Checks: 12 passed.'
      // The toast raised for the same event, marked as already announced.
      fakeState.toast = { id: 7, text: sentence, kind: 'info', silent: true }
      rerender(page())
      settle()
      const spoken = [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')].filter((el) => el.textContent?.includes(sentence))
      expect(spoken).toHaveLength(1)
      expect(spoken[0].getAttribute('aria-live')).toBe('polite')
      const toast = document.querySelector('.toast')!
      expect(toast.textContent).toContain(sentence)
      expect(toast.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull()
    })

    it('plays the cue for the event when cues are on, and nothing when they are off or the sound is None', () => {
      const started: number[] = []
      class FakeAudio {
        currentTime = 0
        destination = {}
        createOscillator() {
          return { type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (n: unknown) => n, start: (at: number) => started.push(at), stop() {} }
        }
        createGain() {
          return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (n: unknown) => n }
        }
      }
      vi.stubGlobal('AudioContext', FakeAudio)
      const run = (settings: Record<string, unknown>) => {
        started.length = 0
        Object.assign(fakeState.snapshot.settings, settings)
        const { rerender, unmount } = render(createElement(Announcer))
        finish(rerender)
        unmount()
        return started.length
      }
      // The finished cue is two notes; the started cue (the open chat's) is one.
      expect(run({ earcons: true, sound: 'chime' })).toBe(3)
      expect(run({ earcons: false })).toBe(0)
      expect(run({ earcons: true, sound: 'none' })).toBe(0)
    })

    it('still puts an ordinary toast in a live region', () => {
      fakeState.toast = { id: 8, text: 'Copied', kind: 'info' }
      render(createElement(ToastHost))
      expect(document.querySelector('.toast')!.closest('[role="status"]')).not.toBeNull()
      cleanup()
      fakeState.toast = { id: 9, text: 'Could not save', kind: 'error' }
      render(createElement(ToastHost))
      expect(document.querySelector('.toast')!.closest('[role="alert"]')).not.toBeNull()
    })
  })

  it('raises a toast flagged silent from the toast options', async () => {
    // The real store reads the bridge when it loads.
    ;(window as unknown as { foreman: unknown }).foreman = { invoke: {}, send: {}, onEvent() {} }
    const real = await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')
    expect(real.makeToast(1, 'hi', 'info', { silent: true }).toast).toEqual({ id: 1, text: 'hi', kind: 'info', silent: true })
    expect(real.makeToast(2, 'hi', 'info').toast).toEqual({ id: 2, text: 'hi', kind: 'info' })
  })
})

describe('the narrator on notifications and Home rows (E2, E4)', () => {
  const done = session('s1', { lastTurn: { outcome: 'completed', endedAt: '2026-10-25T12:00:00Z', additions: 5, deletions: 1 } })
  const ask: ApprovalRequest = { id: 'a1', sessionId: 's1', kind: 'tool', toolName: 'Bash', input: { command: 'npm test' } }
  const notice = (kind: 'finished' | 'attention' | 'stopped' | 'info', sessionId = 's1') => ({ kind, sessionId, title: 'main title', body: 'main body' })

  it('a finished turn: the workspace name as the title, the sentence as the body', () => {
    expect(narratedNotice(t, notice('finished'), [done], [workspace({ checks: passed(2) })], [])).toEqual({ title: 'api-fix', body: 'Claude Code finished in api-fix: this turn +5 -1. Checks: 2 passed.' })
  })

  it('a request: what it wants, in words', () => {
    expect(narratedNotice(t, notice('attention'), [done], [workspace()], [ask])).toEqual({ title: 'api-fix', body: 'Claude Code in api-fix wants to run Bash: npm test' })
  })

  it('a failed turn (also an attention notice) says it failed', () => {
    const failed = session('s1', { lastTurn: { outcome: 'error', endedAt: '' } })
    expect(narratedNotice(t, notice('attention'), [failed], [workspace()], []).body).toBe('Claude Code failed in api-fix.')
  })

  it("leaves main's text for a stopped turn, an info notice, an unknown chat, or a snapshot that has not caught up", () => {
    const plain = { title: 'main title', body: 'main body' }
    expect(narratedNotice(t, notice('stopped'), [done], [workspace()], [])).toEqual(plain)
    expect(narratedNotice(t, notice('info'), [done], [workspace()], [])).toEqual(plain)
    expect(narratedNotice(t, notice('finished', ''), [done], [workspace()], [])).toEqual(plain)
    expect(narratedNotice(t, notice('finished', 'gone'), [done], [workspace()], [])).toEqual(plain)
    expect(narratedNotice(t, notice('finished'), [session('s1')], [workspace()], [])).toEqual(plain)
  })

  it('a Home row describes a waiting request first, else how the last turn ended, and nothing while working', () => {
    expect(workspaceNarration(t, workspace(), [done], [ask])).toBe('Claude Code in api-fix wants to run Bash: npm test')
    expect(workspaceNarration(t, workspace(), [done], [])).toBe('Claude Code finished in api-fix: this turn +5 -1.')
    expect(workspaceNarration(t, workspace(), [{ ...done, status: 'running' }], [])).toBeNull()
    expect(workspaceNarration(t, workspace(), [session('s1')], [])).toBeNull()
    // Another workspace's request is not this row's.
    expect(workspaceNarration(t, workspace(), [session('s9', { workspaceId: 'w2' })], [{ ...ask, sessionId: 's9' }])).toBeNull()
  })

  it('a Recent row for a turn that ended says how it ended, and needs the chat to name the agent', () => {
    expect(turnEndedEventSentence(t, { session: done, workspace: workspace(), outcome: 'error' })).toBe('Claude Code failed in api-fix.')
    expect(turnEndedEventSentence(t, { workspace: workspace(), outcome: 'completed' })).toBeNull()
    expect(needsYouSentence(t, done, workspace(), [ask])).toBe('Claude Code in api-fix wants to run Bash: npm test')
  })
})
