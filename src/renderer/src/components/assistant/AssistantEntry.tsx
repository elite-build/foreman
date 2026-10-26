// Under Automations in the sidebar: opens the assistant. A dot says a reply finished meanwhile, or that the default agent needs signing in.
import { Sparkles } from 'lucide-react'
import { useT } from '../../i18n'
import { modKey, toggleAssistant, useStore } from '../../store'
import { ActionRow, Kbd, Status } from '../../ui'
import './assistant.css'

export function AssistantEntry() {
  const t = useT()
  const enabled = useStore((s) => s.snapshot!.settings.assistantEnabled)
  const open = useStore((s) => s.assistantOpen)
  const unread = useStore((s) => s.assistantUnread)
  const signedOut = useStore((s) => s.assistant?.gate.state === 'signed-out')
  const mod = useStore((s) => modKey(s.snapshot!.platform))
  if (!enabled) return null
  return (
    // Same row as the Automations entry above it, so the two share the `.automations-entry` frame.
    <ActionRow
      card
      className="automations-entry assistant-entry"
      selected={open}
      data-tour="assistant"
      onPress={toggleAssistant}
      primaryProps={{ title: t('assistant.entry.title'), 'aria-pressed': open }}
    >
      <Sparkles size={14} />
      <span className="automations-entry-label">{t('assistant.title')}</span>
      {unread || signedOut ? (
        <Status className="assistant-entry-dot" compact tone={signedOut && !unread ? 'warn' : 'info'} label={unread ? t('assistant.entry.unread') : t('assistant.entry.signedOut')} />
      ) : (
        <Kbd>{mod}⇧A</Kbd>
      )}
    </ActionRow>
  )
}
