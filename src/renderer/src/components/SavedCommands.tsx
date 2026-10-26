// Cues (O9) in a workspace: the terminal panel's ▶ Commands menu, the request ⌘K sends,
// and the approval a repo's command needs before its first run (and after its text changes).
// Each run opens a new terminal tab named after the command; nothing goes to an agent.
import { ChevronDown, Play, SquareTerminal, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { commandsForRepo, needsApproval, type SavedCommand } from '../../../shared/savedCommands'
import type { CheckConsentItem } from '../../../shared/types'
import { useT } from '../i18n'
import { api, attempt, modKey, openAutomations, useStore } from '../store'
import { ConsentRow } from './ChecksDialogs'
import { Button, Dialog, MenuButton, MenuGroup, MenuItem, MenuLabel, MenuSeparator, Tag } from '../ui'

const NO_COMMANDS: SavedCommand[] = []
const EVENT = 'foreman:saved-command'

/** ⌘K → the workspace's terminal panel: run saved command `id` there. */
export function requestSavedCommand(workspaceId: string, id: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { workspaceId, id } }))
}

function onSavedCommandRequest(handler: (workspaceId: string, id: string) => void): () => void {
  const listener = (event: Event) => {
    const { workspaceId, id } = (event as CustomEvent<{ workspaceId: string; id: string }>).detail
    handler(workspaceId, id)
  }
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

/** The commands a workspace in `repoId` offers: this repo's (yours, then the repo's own), and yours for all repos. */
export function useRepoCommands(repoId: string): { repo: SavedCommand[]; all: SavedCommand[] } {
  const personal = useStore((s) => s.snapshot!.settings.savedCommands ?? NO_COMMANDS)
  const fromRepo = useStore((s) => s.snapshot!.repoCommands?.[repoId] ?? NO_COMMANDS)
  return commandsForRepo(personal, fromRepo, repoId)
}

/**
 * Running saved commands in one workspace: asks main whether the command needs approval (it checks
 * the repo's file as it is now), shows the approval when it does, then calls `open` for a new tab.
 * Requests from ⌘K for this workspace arrive here too. Render `dialog` somewhere in the panel.
 */
export function useSavedCommandRunner(workspaceId: string, repoId: string, open: (command: SavedCommand) => void) {
  const { repo, all } = useRepoCommands(repoId)
  const [consent, setConsent] = useState<{ command: SavedCommand; item: CheckConsentItem } | null>(null)
  const latest = useRef({ open, commands: [...repo, ...all] })
  latest.current = { open, commands: [...repo, ...all] }

  const run = async (command: SavedCommand) => {
    const item = await attempt(() => api.savedCommandConsent(workspaceId, command.id))
    if (item === undefined) return
    if (item) setConsent({ command, item })
    else latest.current.open(command)
  }
  const runRef = useRef(run)
  runRef.current = run

  useEffect(
    () =>
      onSavedCommandRequest((target, id) => {
        if (target !== workspaceId) return
        const command = latest.current.commands.find((c) => c.id === id)
        if (command) void runRef.current(command)
      }),
    [workspaceId]
  )

  const approve = async () => {
    if (!consent) return
    const ok = await attempt(async () => (await api.approveSavedCommand(workspaceId, consent.command.id, consent.item.command), true))
    setConsent(null)
    if (ok) latest.current.open(consent.command)
  }

  return {
    run: (command: SavedCommand) => void run(command),
    dialog: consent && <CommandConsentDialog item={consent.item} onCancel={() => setConsent(null)} onApprove={approve} />
  }
}

function CommandConsentDialog({ item, onCancel, onApprove }: { item: CheckConsentItem; onCancel: () => void; onApprove: () => Promise<void> }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const approve = async () => {
    setBusy(true)
    await onApprove()
  }
  return (
    <Dialog
      title={t('commands.consent.title')}
      onClose={onCancel}
      size="lg"
      className="dlg"
      footer={
        <>
          <Button onClick={onCancel}>{t('commands.consent.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void approve()}>
            {busy ? t('commands.consent.starting') : t('commands.consent.run')}
          </Button>
        </>
      }
    >
      <p className="muted">{t('commands.consent.body')}</p>
      <ConsentRow item={item} />
    </Dialog>
  )
}

/** ▶ Commands in the terminal panel: this repo's commands, then all repos', and Edit commands… (Automations). */
export function CommandsMenu({ repoId, repoName, disabled, onPick }: { repoId: string; repoName: string; disabled: boolean; onPick: (command: SavedCommand) => void }) {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  const { repo, all } = useRepoCommands(repoId)

  const row = (c: SavedCommand) => (
    <MenuItem
      key={c.id}
      icon={<SquareTerminal size={14} />}
      title={c.command}
      description={<span className="mono">{c.command}</span>}
      hint={c.source === 'repo' ? <Tag>{needsApproval(c) ? t('commands.palette.fromRepoAsks') : t('commands.fromRepoTag')}</Tag> : undefined}
      onSelect={() => onPick(c)}
    >
      {c.name}
    </MenuItem>
  )

  return (
    <MenuButton
      look="ghost"
      small
      menuClassName="bottom-menu commands-menu"
      label={t('commands.menu.button')}
      title={t('commands.menu.title')}
      disabled={disabled}
      trigger={
        <>
          <Play size={11} aria-hidden /> <span className="btn-label">{t('commands.menu.button')}</span> <ChevronDown size={11} aria-hidden />
        </>
      }
    >
      {repo.length > 0 && (
        <>
          <MenuLabel>{repoName}</MenuLabel>
          <MenuGroup label={repoName}>{repo.map(row)}</MenuGroup>
        </>
      )}
      {all.length > 0 && (
        <>
          <MenuLabel>{t('commands.menu.allRepos')}</MenuLabel>
          <MenuGroup label={t('commands.menu.allRepos')}>{all.map(row)}</MenuGroup>
        </>
      )}
      {!repo.length && !all.length && <MenuLabel>{t('commands.menu.empty')}</MenuLabel>}
      <MenuSeparator />
      <MenuItem icon={<Zap size={14} />} onSelect={() => openAutomations(null, 'commands')}>
        {t('commands.menu.edit')}
      </MenuItem>
      <MenuLabel>{t('commands.menu.footer', { key: `${modKey(platform)}K` })}</MenuLabel>
    </MenuButton>
  )
}
