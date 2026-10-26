// O4, Windows: the arrow next to + in the terminal panel. It lists the shells that were found
// (looked up again each time it opens) for a one-off tab in another shell; the Shell setting
// stays as it is. Shells that weren't found aren't offered.
import { ChevronDown, SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { newTerminalShells, shellName, shellPath, type ShellChoice } from '../../../shared/shells'
import { useT } from '../i18n'
import { useStore } from '../store'
import { MenuButton, MenuItem, MenuLabel } from '../ui'
import { useShells } from './useShells'

export function NewTerminalMenu({ disabled, onPick }: { disabled: boolean; onPick: (shell: ShellChoice | undefined) => void }) {
  const t = useT()
  const setting = useStore((s) => s.snapshot!.settings.terminalShell ?? 'auto')
  const [open, setOpen] = useState(false)
  // Looked up each time the menu opens.
  const { found } = useShells(open)
  const first = useRef<HTMLButtonElement>(null)
  // The list can arrive after the menu has opened: the first shell takes focus once it has.
  useEffect(() => {
    if (open && found) first.current?.focus()
  }, [open, found])

  const shells = found ? newTerminalShells(setting, found) : []
  return (
    <MenuButton
      className="new-term-more"
      menuClassName="bottom-menu new-term-menu"
      look="icon"
      label={t('terminal.shell.newMenu')}
      trigger={<ChevronDown size={11} />}
      placement="bottom-start"
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
    >
      {!found && <MenuLabel>{t('terminal.shell.looking')}</MenuLabel>}
      {found &&
        shells.map(({ shell, isDefault }, i) => {
          const path = shellPath(shell, found)
          return (
            <MenuItem
              key={shell}
              ref={i === 0 ? first : undefined}
              icon={<SquareTerminal size={14} />}
              title={path ?? undefined}
              description={path ? <span className="mono">{path}</span> : undefined}
              // The default shell opens a plain tab, which follows the setting.
              onSelect={() => onPick(isDefault ? undefined : shell)}
            >
              {shellName(shell, t, found)}
              {isDefault && <span className="faint"> {t('terminal.shell.default')}</span>}
            </MenuItem>
          )
        })}
    </MenuButton>
  )
}
