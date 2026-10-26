// Cues (O9) in Automations, under Templates: your saved shell commands (add, edit inline, delete)
// and the ones each repo shares in .foreman/settings.toml, read-only here. Templates are prompts
// for an agent; these are plain shell commands that open a terminal tab and never reach one.
import { Plus, SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { newCommandId, normalizeCommandCwd, normalizeCommandName, type SavedCommand } from '../../../../shared/savedCommands'
import { useT } from '../../i18n'
import { modKey, selectAutomation, useStore } from '../../store'
import { ActionRow, Field, LinkButton, Segmented, Select, Tag, TextInput } from '../../ui'
import { saveSettings, useDraft, useSettings } from '../settings/controls'

const NO_COMMANDS: SavedCommand[] = []

export function CommandsSection() {
  const t = useT()
  const commands = useSettings().savedCommands ?? NO_COMMANDS
  const repos = useStore((s) => s.snapshot!.repos)
  const byRepo = useStore((s) => s.snapshot!.repoCommands)
  const selectedRepo = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === s.selectedWorkspaceId)?.repoId)
  const [open, setOpen] = useState<{ id: string; fresh: boolean } | null>(null)
  const repoName = (id?: string) => repos.find((r) => r.id === id)?.name
  // G4 O9: Edit commands… (terminal panel, ⌘K) lands here rather than at the top of Automations.
  const section = useRef<HTMLElement>(null)
  const scrollHere = useStore((s) => s.automations?.scrollTo === 'commands')
  useEffect(() => {
    if (!scrollHere) return
    section.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    selectAutomation(null)
  }, [scrollHere])

  const save = (next: SavedCommand[]) => saveSettings({ savedCommands: next })
  const update = (id: string, patch: Partial<SavedCommand>) => void save(commands.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  const remove = (id: string) => {
    setOpen(null)
    void save(commands.filter((c) => c.id !== id))
  }
  const add = () => {
    const id = newCommandId()
    // This repo by default: the open workspace's, else the first one; all repos when there are none.
    const repoId = selectedRepo ?? repos[0]?.id
    const command: SavedCommand = { id, name: t('commands.defaultName'), command: '', scope: repoId ? 'repo' : 'all', ...(repoId ? { repoId } : {}) }
    void save([...commands, command]).then((ok) => ok && setOpen({ id, fresh: true }))
  }

  return (
    <section ref={section} className="cmd-section" aria-label={t('commands.section')}>
      <div className="auto-side-head">
        <span>{t('commands.section')}</span>
        <span className="auto-side-tools">
          <LinkButton size="sm" onClick={add}>
            <Plus size={12} aria-hidden /> {t('commands.new')}
          </LinkButton>
        </span>
      </div>
      <p className="faint small auto-side-note">{t('commands.note')}</p>
      {commands.length === 0 && <p className="faint small auto-side-note">{t('commands.empty')}</p>}
      {commands.map((c) =>
        open?.id === c.id ? (
          <CommandEditor key={c.id} command={c} autoFocus={open.fresh} onChange={(patch) => update(c.id, patch)} onRemove={() => remove(c.id)} onClose={() => setOpen(null)} />
        ) : (
          <CommandRow key={c.id} command={c} scopeLabel={c.scope === 'repo' ? (repoName(c.repoId) ?? t('commands.edit.thisRepo')) : t('commands.allRepos')} onOpen={() => setOpen({ id: c.id, fresh: false })} />
        )
      )}
      {repos
        .filter((r) => byRepo?.[r.id]?.length)
        .map((r) => (
          <div key={r.id}>
            <div className="auto-side-head sub">{t('commands.fromRepo', { repo: r.name })}</div>
            {byRepo[r.id].map((c) => (
              <CommandRow key={c.id} command={c} scopeLabel={t('commands.fromRepoTag')} />
            ))}
            <p className="faint small auto-side-note">{t.rich('commands.fromRepoNote', { file: <code key="file">.foreman/settings.toml</code> })}</p>
          </div>
        ))}
    </section>
  )
}

/** A command in the list: name, command line, and where it's offered. Repo commands don't open (read-only). */
function CommandRow({ command: c, scopeLabel, onOpen }: { command: SavedCommand; scopeLabel: string; onOpen?: () => void }) {
  const t = useT()
  const body = (
    <>
      <span className="auto-row-title">{c.name}</span>
      <span className="auto-row-sub mono">{c.command.trim() ? c.command.split('\n')[0] : t('commands.edit.emptyCommand')}</span>
    </>
  )
  return (
    <ActionRow
      className={`auto-tpl cmd-row ${onOpen ? '' : 'readonly'}`}
      title={!onOpen && c.approved === false ? t('commands.asksFirstTitle') : undefined}
      onPress={onOpen}
      primaryProps={{ 'aria-expanded': false }}
      actions={<Tag tone="outline">{scopeLabel}</Tag>}
    >
      {body}
    </ActionRow>
  )
}

/** The inline editor: name, command, scope (this repo / all repos), an optional folder, and where it runs. */
function CommandEditor({
  command: c,
  autoFocus,
  onChange,
  onRemove,
  onClose
}: {
  command: SavedCommand
  autoFocus: boolean
  onChange: (patch: Partial<SavedCommand>) => void
  onRemove: () => void
  onClose: () => void
}) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const platform = useStore((s) => s.snapshot!.platform)
  const nameRef = useRef<HTMLInputElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const [badFolder, setBadFolder] = useState(false)
  const name = useDraft(c.name, (next) => {
    const clean = normalizeCommandName(next)
    if (!clean) return false
    onChange({ name: clean })
  })
  const command = useDraft(c.command, (next) => onChange({ command: next.trim() }))
  const folder = useDraft(c.cwd ?? '', (next) => {
    const cwd = normalizeCommandCwd(next)
    setBadFolder(cwd === null)
    if (cwd === null) return false
    onChange({ cwd })
  })

  useEffect(() => {
    if (autoFocus) nameRef.current?.select()
  }, [autoFocus])
  // Esc closes the editor (the text is saved on blur).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !card.current?.contains(document.activeElement)) return
      e.preventDefault()
      ;(document.activeElement as HTMLElement | null)?.blur()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const repoId = c.repoId ?? repos[0]?.id
  return (
    <div className="set-card tpl-card cmd-card" ref={card}>
      <TextInput
        ref={nameRef}
        aria-label={t('commands.edit.name')}
        spellCheck={false}
        autoComplete="off"
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        {...name}
      />
      <TextInput
        mono
        aria-label={t('commands.edit.command')}
        placeholder={t('commands.edit.commandPlaceholder')}
        spellCheck={false}
        autoComplete="off"
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        {...command}
      />
      <div className="cmd-scope">
        <span className="faint small">{t('commands.edit.scope')}</span>
        <Segmented
          plain
          small
          label={t('commands.edit.scope')}
          value={c.scope}
          options={[
            { value: 'repo', label: t('commands.edit.thisRepo'), disabled: !repos.length, title: repos.length ? undefined : t('commands.edit.noRepos') },
            { value: 'all', label: t('commands.edit.allRepos') }
          ]}
          onChange={(scope) => onChange(scope === 'repo' ? { scope, repoId } : { scope, repoId: undefined })}
        />
        {c.scope === 'repo' && (
          <Select className="cmd-repo" label={t('commands.edit.repo')} value={repoId ?? ''} options={repos.map((r) => ({ value: r.id, label: r.name }))} onChange={(next) => onChange({ repoId: next })} />
        )}
      </div>
      <Field label={t('commands.edit.folder')} hideLabel error={badFolder ? t('commands.edit.folderInvalid') : undefined}>
        {(control) => (
          <TextInput
            {...control}
            mono
            placeholder={t('commands.edit.folderPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            {...folder}
          />
        )}
      </Field>
      <div className="cmd-runs-in">
        <SquareTerminal size={13} />
        <span>
          <strong>{t('commands.edit.runsInLabel')}</strong> {c.cwd ? t('commands.edit.runsInFolder', { folder: c.cwd }) : t('commands.edit.runsIn')}
        </span>
      </div>
      <div className="cmd-foot">
        <span className="faint small">{t('commands.edit.where', { key: `${modKey(platform)}K` })}</span>
        <span className="spacer" />
        <LinkButton size="sm" onClick={onClose}>
          {t('commands.edit.done')}
        </LinkButton>
        <LinkButton size="sm" danger aria-label={t('commands.edit.deleteLabel', { name: c.name })} onClick={onRemove}>
          {t('commands.edit.delete')}
        </LinkButton>
      </div>
    </div>
  )
}
