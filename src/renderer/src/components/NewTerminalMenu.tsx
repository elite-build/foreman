// The + in the terminal panel's header: everything that opens a new tab. New terminal first, then (O4, Windows) the
// other shells that were found (looked up again each time it opens) for a one-off tab, then the saved commands (O9).
// The Shell setting stays as it is; shells that weren't found aren't offered.
import { Plus, SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import { newTerminalShells, shellName, shellPath, type ShellChoice } from '../../../shared/shells'
import type { SavedCommand } from '../../../shared/savedCommands'
import { useT } from '../i18n'
import { useStore } from '../store'
import { MenuButton, MenuItem, MenuLabel, MenuSeparator } from '../ui'
import { SavedCommandItems } from './SavedCommands'
import { useShells } from './useShells'

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
  // The default shell is New terminal itself.
  const others = found ? newTerminalShells(setting, found).filter((s) => !s.isDefault) : []

  return (
    <MenuButton
      className="new-menu"
      menuClassName="bottom-menu"
      look="icon"
      label={t('bottomPanel.newMenu')}
      trigger={<Plus size={13} />}
      placement="bottom-start"
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
    >
      <MenuItem icon={<SquareTerminal size={14} />} onSelect={() => onTerminal(undefined)}>
        {t('bottomPanel.newTerminal')}
      </MenuItem>
      {shells && !found && <MenuLabel>{t('terminal.shell.looking')}</MenuLabel>}
      {others.length > 0 && <MenuLabel>{t('terminal.shell.newMenu')}</MenuLabel>}
      {found &&
        others.map(({ shell }) => {
          const path = shellPath(shell, found)
          return (
            <MenuItem
              key={shell}
              icon={<SquareTerminal size={14} />}
              title={path ?? undefined}
              description={path ? <span className="mono">{path}</span> : undefined}
              onSelect={() => onTerminal(shell)}
            >
              {shellName(shell, t, found)}
            </MenuItem>
          )
        })}
      <MenuSeparator />
      <SavedCommandItems repoId={repoId} repoName={repoName} onPick={onCommand} />
    </MenuButton>
  )
}
