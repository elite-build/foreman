import { ChevronDown, ChevronRight, SquareTerminal, X } from 'lucide-react'
import { useState } from 'react'
import { snippetLabel, snippetPreview, splitSentMessage, TERMINAL_SNIPPET_MAX_CHARS, type SentSnippet, type TerminalSnippet } from '../../../../shared/terminalSnippet'
import { useT } from '../../i18n'
import { IconButton, TextArea } from '../../ui'

/**
 * A terminal selection waiting in the composer (#10): one collapsed line saying where and when it came
 * from, the chevron shows the text, × takes it out. It goes with the next message, never on its own.
 * G4: opened, the text can be trimmed (edited) before it's sent.
 */
export function TerminalDraft({ snippet, onRemove, onEdit }: { snippet: TerminalSnippet; onRemove: () => void; onEdit?: (text: string) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const label = snippetLabel(snippet, t)
  return (
    <div className={`term-draft ${open ? 'open' : ''}`} onClick={(e) => e.stopPropagation()}>
      <div className="term-draft-head">
        <IconButton aria-expanded={open} label={open ? t('terminalChat.hide') : t('terminalChat.show', { count: snippet.lines })} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </IconButton>
        <SquareTerminal size={13} className="term-draft-icon" />
        <span className="term-draft-label">{label}</span>
        {open ? <span className="spacer" /> : <span className="term-draft-preview mono">{snippetPreview(snippet)}</span>}
        {open && onEdit && <span className="faint small term-draft-hint">{t('terminalChat.trimHint')}</span>}
        <IconButton label={t('terminalChat.remove')} onClick={onRemove}>
          <X size={12} />
        </IconButton>
      </div>
      {open &&
        (onEdit ? (
          <div className="term-draft-edit">
            <TextArea
              bare
              mono
              aria-label={t('terminalChat.trimLabel')}
              spellCheck={false}
              maxLength={TERMINAL_SNIPPET_MAX_CHARS}
              rows={Math.min(10, Math.max(3, snippet.lines))}
              value={snippet.text}
              onChange={(e) => onEdit(e.target.value)}
            />
          </div>
        ) : (
          <pre className="term-draft-body mono">{snippet.text}</pre>
        ))}
    </div>
  )
}

/** G4 #10: a terminal block in a sent message, drawn like the composer's block (collapsed to its label, read-only). */
function SentTerminalBlock({ snippet }: { snippet: SentSnippet }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const label = t('terminalChat.label', { source: snippet.source, workspace: snippet.workspace, time: snippet.time, count: snippet.lines })
  return (
    <div className={`term-draft term-sent ${open ? 'open' : ''}`}>
      <div className="term-draft-head">
        <IconButton aria-expanded={open} label={open ? t('terminalChat.hide') : t('terminalChat.show', { count: snippet.lines })} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </IconButton>
        <SquareTerminal size={13} className="term-draft-icon" />
        <span className="term-draft-label">{label}</span>
        {!open && <span className="term-draft-preview mono">{snippet.text.split('\n').find((line) => line.trim()) ?? ''}</span>}
      </div>
      {open && <pre className="term-draft-body mono">{snippet.text}</pre>}
    </div>
  )
}

/** G4 #10: a sent message's text, with the terminal blocks it starts with drawn as blocks instead of raw fences. */
export function UserMessageText({ text }: { text: string }) {
  const { snippets, text: rest } = splitSentMessage(text)
  if (!snippets.length) return <>{text}</>
  return (
    <>
      {snippets.map((s, i) => (
        <SentTerminalBlock key={i} snippet={s} />
      ))}
      {rest}
    </>
  )
}
