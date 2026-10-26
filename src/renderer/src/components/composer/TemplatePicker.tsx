// A button that opens a searchable list of saved prompt templates
// (Automations) and hands the chosen one to its owner.
import { ScrollText, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { filterTemplates } from '../../../../shared/promptTemplates'
import { layeredTemplates, REPO_TEMPLATE_DIR } from '../../../../shared/repoTemplates'
import { commandText, filterCommands, repoCommands } from '../../../../shared/repoCommands'
import type { AgentKind } from '../../../../shared/agents'
import type { PromptTemplate, SlashCommandInfo } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, openAutomations, useStore } from '../../store'
import { Combobox, IconButton, LinkButton, Popover, type ListboxOption } from '../../ui'

const firstLine = (text: string) => text.trim().split('\n')[0]

export function TemplatePicker({
  open,
  onOpenChange,
  onPick,
  title,
  className,
  side,
  align,
  manageLink = true,
  repoId,
  session,
  onPickCommand
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (template: PromptTemplate) => void
  title?: string
  // Layout classes for the wrapper. The old "below" and "align-right" still pick the side and edge, until the callers
  // pass `side` and `align`.
  className?: string
  // Which side of the button the list opens on (above by default) and which edge it lines up with.
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
  // Offer "Manage templates" (opens Settings).
  manageLink?: boolean
  // The repository whose .foreman/templates are offered under "From repo".
  repoId?: string
  // The chat this opens from. Claude chats also list the repo's commands and skills; picking one inserts its name.
  session?: { id: string; agent: AgentKind }
  onPickCommand?: (text: string) => void
}) {
  const t = useT()
  const personal = useStore((s) => s.snapshot!.settings.promptTemplates)
  const fromRepo = useStore((s) => (repoId ? s.snapshot!.repoTemplates[repoId] : undefined))
  const trigger = useRef<HTMLElement | null>(null)
  const [query, setQuery] = useState('')
  const templates = useMemo(() => layeredTemplates(personal, fromRepo ?? []).filter((e) => e.template.body.trim()), [personal, fromRepo])
  // Both layers are searched together; each keeps its own heading.
  const shown = useMemo(() => {
    const keep = new Set(filterTemplates(templates.map((e) => ({ ...e.template, name: e.label })), query).map((t) => t.id))
    return templates.filter((e) => keep.has(e.template.id))
  }, [templates, query])

  const [found, setFound] = useState<SlashCommandInfo[]>([])
  const agent = session?.agent
  const sessionId = session?.id
  useEffect(() => {
    if (!open || agent !== 'claude' || !sessionId || !onPickCommand) return setFound([])
    let current = true
    void api.slashCommands(sessionId).then((list) => current && setFound(list), () => current && setFound([]))
    return () => {
      current = false
    }
  }, [open, agent, sessionId, onPickCommand])
  const commands = useMemo(() => (agent && onPickCommand ? filterCommands(repoCommands(agent, found), query) : []), [agent, found, query, onPickCommand])

  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  const options: ListboxOption[] = [
    ...shown.map((e) => ({
      value: `template:${e.template.id}`,
      label: e.label,
      // The personal list is headed only when the repo's templates are listed with it.
      group: e.layer === 'repo' ? t('templatePicker.repo.heading', { dir: REPO_TEMPLATE_DIR }) : fromRepo?.length ? t('templatePicker.personal') : undefined,
      description: firstLine(e.template.body),
      trailing:
        e.layer === 'repo' && e.template.rev ? (
          <span className="faint small" title={t('templatePicker.rev.title', { file: e.template.file ?? '', rev: e.template.rev })}>
            {t('templatePicker.rev.label', { rev: e.template.rev.slice(0, 6) })}
          </span>
        ) : undefined
    })),
    ...commands.map((c) => ({
      value: `command:${c.source}:${c.kind}:${c.name}`,
      label: `/${c.name}`,
      group: t('templatePicker.commands.heading', { dir: '.claude/' }),
      description: c.description || undefined,
      trailing: (
        <span className="faint small">
          {c.kind === 'skill' ? t('templatePicker.kind.skill') : c.kind === 'command' ? t('templatePicker.kind.command') : c.kind}
          {c.source === 'home' ? ` · ${t('templatePicker.source.home')}` : ''}
        </span>
      )
    }))
  ]

  const pick = (value: string) => {
    onOpenChange(false)
    if (value.startsWith('template:')) {
      const found = shown.find((e) => `template:${e.template.id}` === value)
      if (found) onPick(found.template)
    } else {
      const found = commands.find((c) => `command:${c.source}:${c.kind}:${c.name}` === value)
      if (found) onPickCommand?.(commandText(found))
    }
  }

  // The list stays open while the picker does, so the combobox never closes it; Escape closes the picker.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape' || e.nativeEvent.isComposing) return
    // Don't also close a dialog behind the picker or stop the agent.
    e.preventDefault()
    e.stopPropagation()
    onOpenChange(false)
    trigger.current?.focus()
  }

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={t('templatePicker.label')}
      side={side ?? (className?.includes('below') ? 'bottom' : 'top')}
      align={align ?? (className?.includes('align-right') ? 'end' : 'start')}
      panelClassName="template-picker"
      trigger={({ ref, ...rest }) => (
        <IconButton
          {...rest}
          ref={(el) => {
            trigger.current = el
            ref(el)
          }}
          label={title ?? t('templatePicker.title')}
        >
          <ScrollText size={14} />
        </IconButton>
      )}
    >
      <div className="picker-combo">
        <Combobox
          inline
          open
          label={t('templatePicker.search')}
          placeholder={t('templatePicker.search')}
          leading={<Search size={13} aria-hidden />}
          options={options}
          onChange={pick}
          query={query}
          onQueryChange={setQuery}
          onKeyDown={onKeyDown}
          empty={<span className="template-empty">{personal.length || fromRepo?.length ? t('templatePicker.noMatch') : t('templatePicker.none')}</span>}
        />
      </div>
      {manageLink && (
        <div className="picker-footer faint small">
          <span>{t('templatePicker.keys')}</span>
          <LinkButton
            size="sm"
            onClick={() => {
              onOpenChange(false)
              openAutomations()
            }}
          >
            {t('templatePicker.manage')}
          </LinkButton>
        </div>
      )}
    </Popover>
  )
}
