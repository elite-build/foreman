// The in-chat card for a turn that failed because the agent isn't signed in. It opens Settings → Agents; once the agent's
// status turns ready (Settings re-checks after a sign-in, and the window re-checks when it is focused again) the card says
// so and offers Retry for the message that failed. Agents Foreman can't check from outside a turn keep the plain button.
import { LogIn, RotateCcw } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { AGENTS } from '../../../shared/agents'
import type { ChatItem, Session } from '../../../shared/types'
import { refreshAgentStatuses, useAgentStatuses } from '../agentReadiness'
import { useT } from '../i18n'
import { api, attempt, openSettingsPage, useStore } from '../store'
import { Button, Callout } from '../ui'

type Notice = Extract<ChatItem, { kind: 'notice' }>
type UserMessage = Extract<ChatItem, { kind: 'user' }>

/** The message this notice's turn failed on, when it is still the latest one: only then is Retry honest. */
export function retryableMessage(notice: Pick<Notice, 'turnId'>, items: ChatItem[]): UserMessage | undefined {
  if (!notice.turnId) return undefined
  const sent = items.filter((i): i is UserMessage => i.kind === 'user' && !i.steered)
  const last = sent[sent.length - 1]
  return last && last.turnId === notice.turnId ? last : undefined
}

export function SignInNotice({ item, items, session, running, readOnly, children }: { item: Notice; items: ChatItem[]; session: Session; running: boolean; readOnly?: boolean; children: ReactNode }) {
  const t = useT()
  const agent = session.agent
  const name = AGENTS[agent]?.label ?? agent
  const checked = agent === 'claude' || agent === 'codex'
  const statuses = useAgentStatuses()
  const status = statuses[agent]
  const ready = Boolean(status?.installed && status.ready)
  // Signed in is only claimed after the user went to sign in here, or the status was seen signed out first: a status that
  // was already ready is not news, and the turn failed anyway.
  const [clicked, setClicked] = useState(false)
  const [sawSignedOut, setSawSignedOut] = useState(false)
  useEffect(() => {
    if (status && !ready) setSawSignedOut(true)
  }, [status, ready])
  // Back from Settings: look again.
  const settingsOpen = useStore((s) => s.settingsPage !== null && s.settingsPage !== undefined)
  useEffect(() => {
    if (clicked && !settingsOpen) void refreshAgentStatuses(true)
  }, [clicked, settingsOpen])

  const signedIn = checked && ready && (clicked || sawSignedOut)
  const message = retryableMessage(item, items)
  const canRetry = Boolean(message) && !running && !readOnly

  if (signedIn) {
    return (
      <Callout
        tone="ok"
        role="status"
        className="chat-notice"
        actions={
          canRetry &&
          message && (
            <Button
              size="sm"
              icon={<RotateCcw size={12} />}
              title={t('chat.recovery.retryTitle')}
              onClick={() => void attempt(() => api.sendMessage(session.id, message.text, { attachments: message.attachments, templateId: message.followUp?.templateId }))}
            >
              {t('common.retry')}
            </Button>
          )
        }
      >
        {t('chat.notice.signedIn', { agent: name })}
      </Callout>
    )
  }

  return (
    <Callout
      tone="error"
      className="chat-notice"
      actions={
        <>
          <Button
            size="sm"
            icon={<LogIn size={12} />}
            onClick={() => {
              setClicked(true)
              openSettingsPage({ section: 'agents', agent })
            }}
          >
            {t('chat.notice.signIn', { agent: name })}
          </Button>
          {checked && clicked && (
            <Button size="sm" variant="ghost" onClick={() => void refreshAgentStatuses(true)}>
              {t('chat.notice.checkAgain')}
            </Button>
          )}
        </>
      }
    >
      {children}
    </Callout>
  )
}
