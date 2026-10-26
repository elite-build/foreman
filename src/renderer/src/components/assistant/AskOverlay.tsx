// Ask Foreman (accessibility plan, phase F3): a one-line dialog over whatever is showing, opened from anywhere with
// Ctrl+Alt+Space (the `assistant.ask` entry in shortcuts.ts) or from the command palette. Three quick actions are
// answered by the narrator from the snapshot, with no model turn; free text goes to the assistant on its own thread,
// with the workspace and chat the user is in as context.
//
// One channel: the answer is on screen in an ordinary article (not a live region) and the same words go through
// `announce`, so a screen reader hears them once. A proposed command renders as the assistant view's Run card; the
// text field's Enter only sends, and Enter runs a proposal only while that card's own Run button has focus (a native
// button: nothing here handles Enter for it).
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { assistantToolName, type AssistantGate } from '../../../../shared/assistant'
import { whatNeedsMe, workspaceSummary } from '../../../../shared/narration'
import type { ChatItem } from '../../../../shared/types'
import { announce } from '../../announce'
import { spokenSnippet, turnEndedSentence } from '../../agentStatus'
import { useT, type RendererT } from '../../i18n'
import { activeSessionId, closeAsk, getState, loadAssistant, sendToAsk, useStore } from '../../store'
import { Button, Callout, Dialog, Field, Spinner, TextInput } from '../../ui'
import { Markdown } from '../Markdown'
import { ForemanRunRow, wrapForemanCode } from './ForemanRun'
import './assistant.css'
import './ask.css'

const EMPTY: ChatItem[] = []
// "Read the last reply" shows and says this much of it.
export const REPLY_CAP = 2000
// What the announcer says of a model's answer: the start of it, as plain words.
const SPOKEN_ANSWER = 1000

/** A quick action's answer: sentences, then a list. */
interface Quick {
  paragraphs: string[]
  items: string[]
  note?: string
}

const sentence = (text: string): string => (/[.!?…]$/.test(text) ? text : `${text}.`)

function gateReason(gate: AssistantGate, t: RendererT): string {
  switch (gate.state) {
    case 'off':
      return t('assistant.gate.off.title')
    case 'privacy':
      return t('assistant.gate.privacy.title')
    case 'checking':
      return t('assistant.gate.checking')
    case 'none':
      return t('assistant.gate.none.title')
    case 'signed-out':
      return t('assistant.gate.signedOut.title')
    case 'unsupported':
      return t('assistant.gate.unsupported.title')
    case 'ready':
      return ''
  }
}

/** The last turn-end in a run of items, or undefined while the turn is still going. */
const lastEnd = (items: readonly ChatItem[]): Extract<ChatItem, { kind: 'turn-end' }> | undefined => {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'turn-end') return item
  }
  return undefined
}

export function AskOverlay() {
  const t = useT()
  const assistant = useStore((s) => s.assistant)
  const threadId = useStore((s) => s.askThreadId)
  const items = useStore((s) => (s.askThreadId ? (s.assistantItems[s.askThreadId] ?? EMPTY) : EMPTY))
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  // What the answer area shows: a quick action's answer, the model's turn for the last question, or nothing yet.
  const [mode, setMode] = useState<'quick' | 'model' | null>(null)
  const [quick, setQuick] = useState<Quick | null>(null)
  // The thread's items before the question that was just sent: only what follows is this question's answer.
  const [from, setFrom] = useState(0)
  const field = useRef<HTMLInputElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const headingId = useId()

  const gate = assistant?.gate ?? { state: 'checking' as const }
  const running = Boolean(assistant?.threads.find((th) => th.id === threadId)?.running)
  const canSend = gate.state === 'ready'

  // The gate is unknown until asked (it is only loaded when the assistant view opens).
  useEffect(() => {
    void loadAssistant()
  }, [])

  // The dialog's root carries `data-ask-overlay`, so other code (speech) can tell the overlay is open. Dialog takes no
  // attributes of its own. Escape needs nothing here: Dialog's handler already skips a key that was default-prevented,
  // so speech's capture-phase Escape (stop talking) leaves the overlay open and the next one closes it.
  useEffect(() => {
    const root = body.current?.closest('[role="dialog"]')
    root?.setAttribute('data-ask-overlay', '')
    return () => root?.removeAttribute('data-ask-overlay')
  }, [])

  // Focus lands in the field. When it only becomes usable after the gate check, take focus then, unless the user has
  // already moved on to a quick action.
  useEffect(() => {
    if (!canSend) return
    const active = document.activeElement
    if (!active || active === document.body || active.getAttribute('role') === 'dialog') field.current?.focus()
  }, [canSend])

  const turn = mode === 'model' ? items.slice(from) : EMPTY
  const end = lastEnd(turn)
  const waiting = mode === 'model' && !end
  const modelText = [...turn].reverse().find((i) => i.kind === 'assistant' && i.text.trim())

  // The turn's final text, said once when the turn ends. A turn that was already over when the overlay opened is not
  // said again.
  const said = useRef<string | undefined>(lastEnd(items)?.id)
  useEffect(() => {
    if (!end || said.current === end.id) return
    said.current = end.id
    setMode('model')
    if (end.outcome === 'cancelled') return
    const spoken = end.outcome === 'completed' ? (modelText?.kind === 'assistant' ? spokenSnippet(modelText.text, SPOKEN_ANSWER) : '') : (end.error ?? t('assistant.failed'))
    if (spoken) announce(spoken, 'ask:answer')
    // Once per ended turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [end?.id])

  const show = (answer: Quick, spoken: string) => {
    setQuick(answer)
    setMode('quick')
    announce(spoken, 'ask:answer')
  }

  // The workspace the user is in, and its open chat.
  const here = () => {
    const state = getState()
    const ws = state.snapshot?.workspaces.find((w) => w.id === state.selectedWorkspaceId)
    const sessionId = ws ? activeSessionId(state, ws.id) : undefined
    return { state, ws, session: state.snapshot?.sessions.find((s) => s.id === sessionId) }
  }

  const whatNeeds = () => {
    const { snapshot, approvals } = getState()
    if (!snapshot) return
    const { lead, items: needs } = whatNeedsMe(t, { sessions: snapshot.sessions, approvals, workspaces: snapshot.workspaces })
    show({ paragraphs: [lead], items: needs }, [lead, ...needs].map(sentence).join(' '))
  }

  const happened = () => {
    const { state, ws, session } = here()
    if (!state.snapshot || !ws) return show({ paragraphs: [t('ask.noWorkspace')], items: [] }, t('ask.noWorkspace'))
    const paragraphs = [workspaceSummary(t, ws, { sessions: state.snapshot.sessions, approvals: state.approvals }), session ? turnEndedSentence(t, session, ws) : null].filter((p): p is string => Boolean(p))
    show({ paragraphs, items: [] }, paragraphs.map(sentence).join(' '))
  }

  const lastReply = () => {
    const { state, session } = here()
    const chat = session ? state.chats[session.id] : undefined
    const reply = [...(chat ?? [])].reverse().find((i) => i.kind === 'assistant' && i.text.trim())
    if (reply?.kind !== 'assistant') return show({ paragraphs: [t('ask.noReply')], items: [] }, t('ask.noReply'))
    const full = reply.text.trim()
    const cut = full.length > REPLY_CAP
    const shown = cut ? `${full.slice(0, REPLY_CAP).trimEnd()}...` : full
    const note = cut ? t('ask.reply.cut', { count: REPLY_CAP }) : undefined
    const spoken = spokenSnippet(shown, REPLY_CAP + 3)
    show({ paragraphs: [shown], items: [], note }, note ? `${sentence(spoken)} ${note}` : spoken)
  }

  const send = async () => {
    const question = text.trim()
    if (!question || sending || running || !canSend) return
    const { state, session } = here()
    setSending(true)
    setFrom(items.length)
    setMode('model')
    const context = { ...(state.selectedWorkspaceId ? { workspaceId: state.selectedWorkspaceId } : {}), ...(session ? { sessionId: session.id } : {}) }
    const ok = await sendToAsk(question, context)
    setSending(false)
    if (ok) setText('')
    else setMode(null)
  }

  return (
    <Dialog title={t('ask.title')} size="lg" className="ask" onClose={closeAsk} closeLabel={t('common.close')}>
      <div className="ask-body" ref={body}>
        <div className="ask-quick" role="group" aria-label={t('ask.quick.label')}>
          <Button onClick={whatNeeds}>{t('ask.quick.needsMe')}</Button>
          <Button onClick={happened}>{t('ask.quick.happened')}</Button>
          <Button onClick={lastReply}>{t('ask.quick.lastReply')}</Button>
        </div>
        <Field label={t('ask.field.label')} description={canSend ? t('ask.field.hint') : gateReason(gate, t)}>
          {(control) => (
            <TextInput
              {...control}
              ref={field}
              value={text}
              disabled={!canSend}
              autoFocus={canSend}
              autoComplete="off"
              placeholder={t('ask.field.placeholder')}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends the question. It never runs a proposed command: that is the Run button's own Enter.
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                e.preventDefault()
                void send()
              }}
            />
          )}
        </Field>
        {mode && (
          <article className="ask-answer" aria-labelledby={headingId} aria-busy={waiting || undefined}>
            <h3 id={headingId} className="sr-only">
              {t('ask.answer')}
            </h3>
            {mode === 'quick' && quick && <QuickAnswer answer={quick} />}
            {mode === 'model' && (
              <>
                {turn.map((item) => (
                  <ModelItem key={item.id} item={item} threadId={threadId} t={t} />
                ))}
                {waiting && (
                  <div className="ask-waiting faint small">
                    <Spinner size={12} /> {t('ask.answering')}
                  </div>
                )}
              </>
            )}
          </article>
        )}
      </div>
    </Dialog>
  )
}

function QuickAnswer({ answer }: { answer: Quick }) {
  return (
    <>
      {answer.paragraphs.map((p, i) => (
        <p key={i} className="ask-text">
          {p}
        </p>
      ))}
      {answer.items.length > 0 && (
        <ul className="ask-list">
          {answer.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
      {answer.note && <p className="faint small">{answer.note}</p>}
    </>
  )
}

/** One item of the model's turn: its words, a proposed command as the Run card, an error. The rest stays out of the way. */
function ModelItem({ item, threadId, t }: { item: ChatItem; threadId: string | null; t: RendererT }): ReactNode {
  switch (item.kind) {
    case 'assistant':
      return <Markdown text={item.text} streaming={item.streaming} wrapCode={wrapForemanCode} headingStart={4} />
    case 'tool':
      return assistantToolName(item.name) === 'foreman' ? <ForemanRunRow threadId={threadId} item={item} /> : null
    // Errors are said through `announce` with the answer; these callouts are not live regions.
    case 'notice':
      return item.level === 'error' ? <Callout tone="error">{item.text}</Callout> : null
    case 'turn-end':
      return item.outcome === 'error' || item.outcome === 'interrupted' ? <Callout tone="error">{item.error ?? t('assistant.failed')}</Callout> : null
    default:
      return null
  }
}
