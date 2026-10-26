// Forking a chat: where to cut its history, and how a fork of an agent that
// can't fork natively carries that history with its first message.
import type { TFunction } from './i18n'
import { chatToMarkdown } from './transcript'
import type { ChatItem } from './types'

// The carried history keeps its newest part when longer than this.
export const MAX_FORK_HISTORY_CHARS = 100_000

type User = Extract<ChatItem, { kind: 'user' }>

export interface ForkCut {
  // The items the fork starts with.
  items: ChatItem[]
  // Where the agent's conversation stands at the cut: from the next message's resume point, or the chat's latest reply.
  resumeFrom: User['resumeFrom'] | 'latest'
}

/**
 * The fork of a chat after a turn's answer: everything up to the next message
 * (steered messages belong to the turn they were sent into). Without a turn,
 * the whole chat.
 */
export function forkCut(items: ChatItem[], turnId?: string): ForkCut {
  if (!turnId) return { items, resumeFrom: 'latest' }
  const start = items.findIndex((i) => i.kind === 'user' && i.turnId === turnId && !i.steered)
  if (start < 0) throw new Error('Message not found')
  if (!items.some((i) => i.kind === 'turn-end' && i.turnId === turnId)) throw new Error('This turn hasn’t finished yet')
  const next = items.findIndex((i, n) => n > start && i.kind === 'user' && !i.steered)
  if (next < 0) return { items, resumeFrom: 'latest' }
  return { items: items.slice(0, next), resumeFrom: (items[next] as User).resumeFrom }
}

/** #16: a cut before a message, or `first` when nothing comes before it (Edit and resend opens a new chat then). */
export type ForkBefore = (ForkCut & { first?: false; message: User }) | { first: true; message: User }

/**
 * Edit and resend: the fork of a chat from just before the message that started
 * this turn. The agent's conversation resumes where that message started from
 * (none recorded: the fork carries the visible history instead).
 */
export function forkCutBefore(items: ChatItem[], turnId: string): ForkBefore {
  const at = items.findIndex((i) => i.kind === 'user' && i.turnId === turnId && !i.steered)
  if (at < 0) throw new Error('Message not found')
  const message = items[at] as User
  if (!items.slice(0, at).some((i) => i.kind === 'user')) return { first: true, message }
  return { items: items.slice(0, at), resumeFrom: message.resumeFrom, message }
}

/**
 * Why Edit and resend isn't offered on this message, or null when it is. A steered message
 * went into a running turn, so there is no turn boundary just before it to fork from.
 */
export function editResendBlock(item: User, running: boolean): 'steered' | 'running' | null {
  if (item.steered) return 'steered'
  if (running) return 'running'
  return null
}

/**
 * A fork's title as its tab shows it: the "(fork)" suffixes come off, because the tab marks forks with
 * an icon instead (a long title would cut the suffix off at the tab's width). The title itself is unchanged.
 */
export function forkTabTitle(title: string): string {
  return title.replace(/(?:\s*\(fork\))+$/, '') || title
}

/** A message as the fork notice quotes it: one line, cut to fit. */
export function quoteMessage(text: string, max = 60): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/**
 * #16: the notice a fork's chat ends with, in the app's language (it's Foreman's own words in the chat, not something
 * an agent reads). `native`: the agent continues its own conversation; otherwise the next message starts a new
 * conversation carrying the history. `before`: Edit and resend, from just before that message.
 */
export function forkNoticeText(t: TFunction, fork: { native: boolean; sourceTitle?: string; before?: string; agent: string }): string {
  const source = fork.sourceTitle ? t('fork.notice.source.titled', { title: fork.sourceTitle }) : t('fork.notice.source.untitled')
  const before = fork.before !== undefined ? t('fork.notice.before', { message: quoteMessage(fork.before) }) : ''
  if (fork.native) return t(before ? 'fork.notice.nativeBefore' : 'fork.notice.native', { source, before })
  return t(before ? 'fork.notice.historyBefore' : 'fork.notice.history', { source, before, agent: fork.agent })
}

/** The forked history as a block that goes before the fork's first message, or '' when there is none. */
export function forkHistoryBlock(items: ChatItem[]): string {
  return carriedHistory(items).text
}

/**
 * The visible history as the block a new agent conversation gets with its first message: messages only, the newest
 * MAX_FORK_HISTORY_CHARS kept (`cut` says the oldest part was left out). O1 `switch`: the tab was switched to this agent.
 */
export function carriedHistory(items: ChatItem[], reason: 'fork' | 'switch' = 'fork'): { text: string; cut: boolean } {
  let history = chatToMarkdown(items, { toolOutput: false }).trim()
  if (!history) return { text: '', cut: false }
  let cut = false
  if (history.length > MAX_FORK_HISTORY_CHARS) {
    history = history.slice(-MAX_FORK_HISTORY_CHARS)
    cut = true
  }
  const left = cut ? ' Its oldest part was left out to fit.' : ''
  const intro =
    reason === 'switch'
      ? `This chat began with another agent, and the user has switched it to you. Its conversation so far, which you don't otherwise remember, is below.${left} It is given here for context only; it is not a new request:`
      : `This chat is a fork of an earlier conversation, which you don't otherwise remember.${left} It is given here for context only; it is not a new request:`
  return {
    cut,
    text: [intro, '<earlier_conversation>', history, '</earlier_conversation>', '', "The user's new message:", '', ''].join('\n')
  }
}
