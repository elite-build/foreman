// Settings search, in the page: the matches as rows grouped by category (or repository), each with where it lives and
// its current value. Enter (or a click) opens the setting where it lives, scrolled to and lit; an agent that isn't
// signed in carries the button that goes to its sign-in. ↓ from the search box moves into the list, ↑ ↓ move along
// it, and Escape goes back to the box.
import { ChevronRight } from 'lucide-react'
import type { KeyboardEvent, ReactNode, Ref } from 'react'
import { formatNumber } from '../../../../shared/i18n/time'
import { readSettingValue, SETTINGS_SCHEMA } from '../../../../shared/settingsSchema'
import type { AgentKind } from '../../../../shared/types'
import { useAgentReadiness } from '../../agentReadiness'
import { useT } from '../../i18n'
import type { SettingsPage } from '../../store'
import { ActionRow, Button, Kbd, Status } from '../../ui'
import { useSettings } from './controls'
import { highlight, type SearchItem } from './searchIndex'

// The primary button of each result: what the arrow keys move between.
const RESULT = 'button.set-result-main'

interface Props {
  query: string
  results: SearchItem[]
  // Group keys in menu order (categories, then repositories): the order the groups are listed in.
  order: string[]
  onOpen: (target: SettingsPage) => void
  // Back to the search box; `clear` empties it too.
  onExit: (clear: boolean) => void
  listRef?: Ref<HTMLDivElement>
}

export function SearchResults({ query, results, order, onOpen, onExit, listRef }: Props) {
  const t = useT()
  const groups = order.map((key) => ({ key, items: results.filter((r) => r.groupKey === key) })).filter((g) => g.items.length > 0)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(RESULT)]
    const at = rows.indexOf(e.target as HTMLButtonElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onExit(true)
      return
    }
    if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return
    const next = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : null
    if (next === null) return
    e.preventDefault()
    if (next < 0) onExit(false)
    else rows[Math.min(next, rows.length - 1)].focus()
  }

  return (
    <div className="set-page set-search">
      <div aria-live="polite">
        <h1>{results.length ? t('settings.search.title', { count: results.length, query: query.trim() }) : t('settings.search.empty', { query: query.trim() })}</h1>
      </div>
      {results.length > 0 && (
        <p className="set-page-desc">{t.rich('settings.search.hint', { down: <Kbd key="down">↓</Kbd>, enter: <Kbd key="enter">Enter</Kbd>, esc: <Kbd key="esc">Esc</Kbd> })}</p>
      )}
      <div ref={listRef} className="set-results" aria-label={t('settings.search.results')} role="region" onKeyDown={onKeyDown}>
        {groups.map((g) => (
          <section key={g.key} className="set-section" aria-label={g.items[0].group}>
            <h2>
              {g.items[0].group} <span className="faint">{formatNumber(g.items.length, t.locale)}</span>
            </h2>
            <div className="set-card">
              {g.items.map((item) => (
                <Result key={item.key} item={item} query={query} onOpen={onOpen} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function Result({ item, query, onOpen }: { item: SearchItem; query: string; onOpen: (target: SettingsPage) => void }) {
  return (
    <ActionRow
      className="set-result"
      primaryProps={{ className: 'set-result-main' }}
      onPress={() => onOpen(item.target)}
      actions={item.agent ? <AgentFix agent={item.agent} onOpen={onOpen} /> : undefined}
    >
      <span className="set-result-text">
        <span className="set-label">{highlight(item.label, query)}</span>
        {item.where.length > 0 && <span className="set-help">{item.where.join(' › ')}</span>}
      </span>
      <span className="set-result-value">{item.agent ? <AgentState agent={item.agent} /> : item.rowId ? <RowValue rowId={item.rowId} /> : null}</span>
      <ChevronRight size={14} className="faint" aria-hidden />
    </ActionRow>
  )
}

/** A setting's value as the page shows it: on or off, a number, a path. Choices are left to the page. */
function RowValue({ rowId }: { rowId: string }): ReactNode {
  const t = useT()
  const settings = useSettings()
  const spec = SETTINGS_SCHEMA.find((s) => s.registryId === rowId)
  if (!spec) return null
  const value = readSettingValue(spec, settings)
  switch (spec.type) {
    case 'boolean':
      return <Status tone={value ? 'ok' : 'off'} label={value ? t('common.on') : t('common.off')} />
    case 'integer':
    case 'number':
      return typeof value === 'number' ? <span className="small">{formatNumber(value, t.locale)}</span> : null
    case 'path':
    case 'string':
      return typeof value === 'string' && value ? (
        <span className="mono small set-result-path" title={value}>
          {value}
        </span>
      ) : null
    default:
      return null
  }
}

/** A Full agent's sign-in, in words. */
function AgentState({ agent }: { agent: AgentKind }) {
  const t = useT()
  const readiness = useAgentReadiness(agent)
  const checking = readiness.evidenceKey === 'agentReadiness.checking'
  return <Status tone={readiness.ready ? 'ok' : checking ? 'off' : 'error'} label={t(readiness.evidenceKey)} />
}

/** The one button that fixes an agent that can't run: its sign-in page, where Sign in or the key is. */
function AgentFix({ agent, onOpen }: { agent: AgentKind; onOpen: (target: SettingsPage) => void }) {
  const t = useT()
  const readiness = useAgentReadiness(agent)
  if (readiness.ready || readiness.evidenceKey === 'agentReadiness.checking') return null
  const label = readiness.needsSignIn ? t('agentReadiness.signIn') : readiness.evidenceKey === 'agentReadiness.noKey' ? t('settings.search.addKey') : t('settings.search.setUp')
  return (
    <Button size="sm" variant={readiness.needsSignIn ? 'primary' : undefined} onClick={() => onOpen({ section: 'agents', agent, part: 'signin' })}>
      {label}
    </Button>
  )
}
