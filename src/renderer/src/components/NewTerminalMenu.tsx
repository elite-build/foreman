// The + in the terminal panel's header: everything that opens a new tab. + itself opens a terminal in the default shell;
// its arrow lists (O4, Windows) the shells that were found (looked up again each time it opens), the default marked, for
// a one-off tab, then the saved commands (O9). The Shell setting stays as it is; shells that weren't found aren't offered.
import { GitBranch, Plus, Server, SquareChevronRight, SquareTerminal, Terminal } from 'lucide-react'
import { useState } from 'react'
import { newTerminalShells, shellName, shellPath, type KnownShell, type ShellChoice } from '../../../shared/shells'
import type { SavedCommand } from '../../../shared/savedCommands'
import { useT } from '../i18n'
import { useStore } from '../store'
import { MenuItem, MenuLabel, MenuSeparator, SplitButton, Tag } from '../ui'
import { SavedCommandItems } from './SavedCommands'
import { useShells } from './useShells'

/** Each shell's own icon, so the list reads without its labels: PowerShell's prompt, Git Bash's git, cmd's bare >_, WSL's Linux machine. */
export function ShellIcon({ shell, size = 14 }: { shell: KnownShell | 'custom'; size?: number }) {
  switch (shell) {
    case 'pwsh':
    case 'powershell':
      return <SquareChevronRight size={size} />
    case 'gitbash':
      return <GitBranch size={size} />
    case 'cmd':
      return <Terminal size={size} />
    case 'wsl':
      return <Server size={size} />
    default:
      return <SquareTerminal size={size} />
  }
}

export function NewMenu({
  repoId,
  repoName,
  shells,
  disabled,
  onTerminal,
  onCommand
}: {
  repoId: string
  repoName: string
  // Offer other shells: Windows, on this computer.
  shells: boolean
  disabled: boolean
  // undefined: a plain tab, which follows Settings → Shell.
  onTerminal: (shell: ShellChoice | undefined) => void
  onCommand: (command: SavedCommand) => void
}) {
  const t = useT()
  const setting = useStore((s) => s.snapshot!.settings.terminalShell ?? 'auto')
  const [open, setOpen] = useState(false)
  // Looked up each time the menu opens.
  const { found } = useShells(open && shells)
  const list = found ? newTerminalShells(setting, found) : []

  return (
    <SplitButton
      className="new-menu"
      variant="ghost"
      size="sm"
      label={<Plus size={13} aria-hidden="true" />}
      aria-label={t('bottomPanel.newTerminal')}
      title={t('bottomPanel.newTerminal')}
      onClick={() => onTerminal(undefined)}
      menuLabel={t('bottomPanel.newMore')}
      placement="bottom-start"
      // In <body>, above xterm's own layers.
      portal
      menuOpen={open}
      onMenuOpenChange={setOpen}
      disabled={disabled}
    >
      {shells && (
        <>
          <MenuLabel>{t('terminal.shell.openIn')}</MenuLabel>
          {!found && <MenuLabel>{t('terminal.shell.looking')}</MenuLabel>}
          {list.map(({ shell, isDefault }) => (
            <MenuItem
              key={shell}
              icon={<ShellIcon shell={shell} />}
              title={(found && shellPath(shell, found)) ?? undefined}
              hint={isDefault ? <Tag>{t('terminal.shell.defaultTag')}</Tag> : undefined}
              // The default is a plain tab, so it keeps following the setting.
              onSelect={() => onTerminal(isDefault ? undefined : shell)}
            >
              {shellName(shell, t, found)}
            </MenuItem>
          ))}
          <MenuSeparator />
        </>
      )}
      <SavedCommandItems repoId={repoId} repoName={repoName} onPick={onCommand} />
    </SplitButton>
  )
}
