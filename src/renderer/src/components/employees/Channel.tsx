// What an organization's channel and a project's channel share (docs/ai-employees.md §15): a post (a hat, who, when, the
// words), a line Foreman says, and the message box, whose @ chips put a name at its start ("@Priya …" starts a project,
// "@Ravi …" asks Ravi). Enter sends, Shift+Enter is a new line. Feature compositions of ui/ parts.
import { Send } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { timeAgo } from '../../../../shared/i18n/time'
import { useT } from '../../i18n'
import { Button, ChipButton, HardHat, TextArea, type HardHatColour } from '../../ui'

export interface ChannelMember {
  id: string
  name: string
  colour: string
  role: string
}

/** One post: who (a hat, the person's when no colour), what they are, how long ago, and what they said. */
export function Post({ who, colour, role, at, children, className }: { who: string; colour?: string; role?: string; at: string; children: ReactNode; className?: string }) {
  const t = useT()
  return (
    <li className={className ? `channel-post ${className}` : 'channel-post'}>
      <HardHat colour={(colour ?? 'slate') as HardHatColour} size={24} />
      <div className="channel-post-body">
        <div className="channel-post-head">
          <span className="employee-subheading">{who}</span>
          {role && <span className="employee-faint">{role}</span>}
          <span className="employee-faint">{timeAgo(at, t.locale)}</span>
        </div>
        {children}
      </div>
    </li>
  )
}

/** A line Foreman says (a part started, a replan went ahead): no hat, quiet. */
export function SystemLine({ children }: { children: ReactNode }) {
  return <li className="channel-system employee-faint">{children}</li>
}

/** The message box, with a chip per member that puts their name first. Clears once `onSend` resolves true. */
export function ChannelComposer({ label, placeholder, members, onSend, hint }: { label: string; placeholder: string; members: readonly ChannelMember[]; onSend: (text: string) => Promise<boolean>; hint?: ReactNode }) {
  const t = useT()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const send = () => {
    if (!text.trim() || busy) return
    setBusy(true)
    void onSend(text.trim())
      .then((ok) => ok && setText(''))
      .finally(() => setBusy(false))
  }
  const mention = (name: string) => {
    const rest = text.replace(/^\s*@\S+\s*/, '')
    setText(`@${name} ${rest}`)
    box.current?.focus()
  }
  return (
    <div className="channel-composer">
      {members.length > 0 && (
        <div className="channel-mentions" role="group" aria-label={t('projects.composer.mention')}>
          {members.map((m) => (
            <ChipButton key={m.id} pill onClick={() => mention(m.name)} title={m.role}>
              <HardHat colour={m.colour as HardHatColour} size={14} /> @{m.name}
            </ChipButton>
          ))}
        </div>
      )}
      <div className="channel-composer-row">
        <TextArea
          ref={box}
          aria-label={label}
          placeholder={placeholder}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
            e.preventDefault()
            send()
          }}
        />
        <Button variant="primary" icon={<Send size={13} />} disabled={!text.trim() || busy} onClick={send}>
          {busy ? t('projects.composer.sending') : t('projects.composer.send')}
        </Button>
      </div>
      {hint && <div className="channel-hint employee-faint">{hint}</div>}
    </div>
  )
}
