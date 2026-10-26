// O5: the Changes panel's source menu, replacing the All / Uncommitted switch.
// Each source shows a file count read from git when the menu opens.
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { DIFF_SOURCES } from '../../../shared/diffSource'
import type { DiffScope, DiffSourceInfo } from '../../../shared/types'
import { useT, type RendererT } from '../i18n'
import { api, useStore } from '../store'
import { Kbd, MenuButton, MenuGroup, MenuLabel, MenuRadioItem, MenuSeparator } from '../ui'
import type { DiffSourceChoice } from './diffSourcePref'
import './diffSource.css'

/** The source's name, as on the menu button. */
export function sourceLabel(t: RendererT, choice: DiffSourceChoice): string {
  switch (choice.scope) {
    case 'uncommitted':
      return t('diffSource.uncommitted')
    case 'staged':
      return t('diffSource.staged')
    case 'last-commit':
      return t('diffSource.lastCommit')
    case 'last-3':
      return t('diffSource.last3')
    case 'picked':
      return t('diffSource.picked.button', { count: choice.picked.length })
    case 'pr':
      return t('diffSource.pr')
    default:
      return t('diffSource.all')
  }
}

function detail(t: RendererT, scope: DiffScope, info: DiffSourceInfo | null): string {
  switch (scope) {
    case 'all':
      return t('diffSource.all.detail', { base: info?.baseRef ?? t('diffSourceMenu.baseFallback') })
    case 'uncommitted':
      return t('diffSource.uncommitted.detail')
    case 'staged':
      return t('diffSource.staged.detail')
    case 'last-commit':
      return info?.lastCommit ? `${info.lastCommit.sha.slice(0, 7)} · ${info.lastCommit.subject}` : ''
    case 'last-3':
      return info && info.lastN < 3 ? t('diffSource.last3.all') : t('diffSource.last3.detail')
    case 'picked':
      return t('diffSource.picked.detail')
    case 'pr':
      if (!info?.pr) return ''
      return info.pr.provider === 'gitlab' ? t('diffSource.pr.detailGitlab', { number: info.pr.number }) : t('diffSource.pr.detail', { number: info.pr.number })
    default:
      return ''
  }
}

export function DiffSourceMenu({
  workspaceId,
  choice,
  onChange,
  onPick
}: {
  workspaceId: string
  choice: DiffSourceChoice
  onChange: (scope: DiffScope) => void
  // "Pick commits…": choose them in the Commits tab.
  onPick: () => void
}) {
  const t = useT()
  const mac = useStore((s) => s.snapshot!.platform) === 'darwin'
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<DiffSourceInfo | null>(null)

  useEffect(() => {
    if (!open) return
    // Counts come from git each time the menu opens.
    let live = true
    setInfo(null)
    api.diffSources(workspaceId, choice.picked).then(
      (next) => live && setInfo(next),
      () => live && setInfo({ counts: {}, blocked: {}, baseRef: '', branchCommits: 0, lastN: 0 })
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId])

  const title = (scope: DiffScope) =>
    scope === 'all' ? t('diffSource.all') : scope === 'picked' ? t('diffSource.picked') : sourceLabel(t, { scope, picked: [] })

  return (
    <MenuButton
      look="ghost"
      small
      className="diff-source"
      menuClassName="diff-source-menu"
      label={t('diffSource.label')}
      open={open}
      onOpenChange={setOpen}
      placement="bottom-end"
      trigger={
        <>
          <span className="diff-source-name">{sourceLabel(t, choice)}</span> <ChevronDown size={12} />
        </>
      }
    >
      <MenuLabel>{t('diffSource.heading')}</MenuLabel>
      <MenuGroup label={t('diffSource.heading')}>
        {DIFF_SOURCES.map((scope) => {
          const blocked = info?.blocked[scope]
          // Picking happens in the Commits tab, so "Pick commits…" is never blocked for having no picks.
          const disabled = Boolean(blocked) && scope !== 'picked'
          const count = info?.counts[scope]
          const reason = blocked && scope !== 'picked' ? t(`diffSource.blocked.${blocked}`) : null
          const sub = reason ?? detail(t, scope, info)
          const separate = scope === 'last-commit' || scope === 'picked' || scope === 'pr'
          return (
            <Fragment key={scope}>
              {separate && <MenuSeparator />}
              <MenuRadioItem
                checked={choice.scope === scope}
                disabled={disabled}
                title={reason ?? undefined}
                description={sub || undefined}
                hint={
                  <span className="diff-source-hint">
                    {scope === 'uncommitted' && <Kbd>{mac ? '⌘⌥U' : 'Ctrl+Alt+U'}</Kbd>}
                    {scope === 'picked' && !count ? <ChevronRight size={13} aria-hidden="true" /> : !info ? t('diffSource.loading') : count !== undefined ? t('diffSource.files', { count }) : ''}
                  </span>
                }
                onSelect={() => {
                  if (scope === 'picked') onPick()
                  else onChange(scope)
                }}
              >
                {title(scope)}
              </MenuRadioItem>
            </Fragment>
          )
        })}
      </MenuGroup>
    </MenuButton>
  )
}
