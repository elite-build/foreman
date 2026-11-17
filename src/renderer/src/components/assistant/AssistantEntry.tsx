// An icon in the sidebar's top row, beside Automations: opens the assistant. Its name and tooltip carry its shortcut; a
// mark on its corner says a reply finished meanwhile, or that the default agent needs signing in.
import { Sparkles } from 'lucide-react'
import { useT } from '../../i18n'
import { shortcutHint } from '../../shortcuts'
import { toggleAssistant, useStore } from '../../store'
import { IconButton, Status } from '../../ui'
import './assistant.css'

/** `className`: its place where it is drawn (the top row, or a tile on the folded rail). */
export function AssistantEntry({ className }: { className?: string }) {
  const t = useT()
  const enabled = useStore((s) => s.snapshot!.settings.assistantEnabled)
  const open = useStore((s) => s.assistantOpen)
  const unread = useStore((s) => s.assistantUnread)
  const signedOut = useStore((s) => s.assistant?.gate.state === 'signed-out')
  const platform = useStore((s) => s.snapshot!.platform)
  if (!enabled) return null
  const key = shortcutHint('assistant.toggle', platform)
  const state = unread ? t('assistant.entry.unread') : signedOut ? t('assistant.entry.signedOut') : undefined
  return (
    // Same frame as the Automations icon beside it (`.automations-entry`).
    <IconButton
      className={['automations-entry', 'assistant-entry', className].filter(Boolean).join(' ')}
      label={[t('assistant.title'), state, key].filter(Boolean).join(' · ')}
      pressed={open}
      aria-current={open ? 'true' : undefined}
      aria-keyshortcuts={platform === 'darwin' ? 'Meta+Shift+A' : 'Control+Shift+A'}
      data-tour="assistant"
      onClick={toggleAssistant}
    >
      <Sparkles size={15} />
      {state && (
        <span className="assistant-entry-dot">
          <Status compact tone={signedOut && !unread ? 'warn' : 'info'} label={state} />
        </span>
      )}
    </IconButton>
  )
}
