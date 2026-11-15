import { useId, useState } from 'react'
import type { AgentKind, ContextBreakdown, ContextUsage } from '../../../../shared/types'
import type { Locale } from '../../../../shared/i18n'
import { formatCompact } from '../../../../shared/i18n/time'
import { AGENTS } from '../../../../shared/agents'
import { useLocale, useT } from '../../i18n'
import { useStore } from '../../store'
import { Button, Callout, Disclosure, Glyph, Popover, Tab, TabList, TabPanel, Tabs } from '../../ui'

type Category = ContextBreakdown['categories'][number]

const percents = new Map<string, Intl.NumberFormat>()
function percent(ratio: number, locale: string, digits = 0): string {
  const key = `${locale}:${digits}`
  let f = percents.get(key)
  if (!f) percents.set(key, (f = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: digits })))
  return f.format(ratio)
}

// Shown from 70% of the usable window (or always, if the setting asks); a warning, with its glyph, from 90%.
const SHOW_FROM = 0.7
const WARN_FROM = 0.9

/**
 * The window as the agent will use it. What it keeps free for compacting (Claude's autocompact buffer) comes off the top:
 * compaction starts when the rest is full, so "how close" is measured against `usable`, not the whole window.
 */
function contextRoom(usage: ContextUsage) {
  const kept = usage.breakdown?.categories.filter((c) => c.kind === 'buffer').reduce((n, c) => n + c.tokens, 0) ?? 0
  const buffer = kept > 0 && kept < usage.limit ? kept : 0
  const usable = usage.limit - buffer
  const used = Math.max(usage.used, 0)
  return { buffer, usable, used, left: Math.max(usable - used, 0), ratio: Math.min(used / usable, 1) }
}

// Segment colours go by position among what fills the window (composer-extras.css); the legend repeats each one with
// its name and size, so a colour is never the only way to tell them apart.
const SEGMENTS = 6

/** What fills the window, biggest first, each with its colour. */
function usedParts(usage: ContextUsage): { category: Category; segment: string }[] {
  const used = usage.breakdown?.categories.filter((c) => c.kind === 'used' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens) ?? []
  return used.map((category, i) => ({ category, segment: `seg-${Math.min(i, SEGMENTS - 1)}` }))
}

// The bar's width in the popover (its content box is 328 px wide).
const BAR = 328

/** A swatch for the legend, in the bar's look. */
function Swatch({ part, hatch }: { part: string; hatch: string }) {
  return (
    <svg className="context-bar" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" rx="2" className={part} fill={part === 'buffer' ? `url(#${hatch})` : undefined} />
    </svg>
  )
}

/**
 * One bar for the whole window: what fills it, then what's free, then what's kept for compacting, hatched and marked by a
 * tick where auto-compaction starts. Its text alternative says the same in words.
 */
function Bar({ usage, room, hatch, label, compactsAt }: { usage: ContextUsage; room: ReturnType<typeof contextRoom>; hatch: string; label: string; compactsAt?: string }) {
  const locale = useLocale()
  const scale = BAR / usage.limit
  const usableX = room.usable * scale
  const parts = usedParts(usage)
  const segments = parts.length ? parts.map((p) => ({ key: p.category.name, tokens: p.category.tokens, segment: p.segment })) : [{ key: 'used', tokens: room.used, segment: 'seg-0' }]
  let x = 0
  return (
    <svg className="context-bar" width={BAR} height={30} viewBox={`0 0 ${BAR} 30`} role="img" aria-label={label}>
      <defs>
        <pattern id={hatch} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="5" height="5" className="hatch-bg" />
          <line x1="0" y1="0" x2="0" y2="5" className="hatch-line" />
        </pattern>
      </defs>
      {segments.map((s) => {
        const width = Math.min(s.tokens * scale, usableX - x)
        if (width <= 0) return null
        const rect = <rect key={s.key} x={x} y={0} width={Math.max(width - (segments.length > 1 ? 1 : 0), 1)} height={10} className={s.segment} />
        x += width
        return rect
      })}
      {usableX - x > 1 && <rect x={x + 0.5} y={0.5} width={usableX - x - 1} height={9} className="free" />}
      {room.buffer > 0 && (
        <>
          <rect x={usableX + 0.5} y={0.5} width={Math.max(BAR - usableX - 1, 1)} height={9} className="buffer" fill={`url(#${hatch})`} />
          <line x1={usableX} y1={-3} x2={usableX} y2={14} className="tick" />
        </>
      )}
      <text x={0} y={26}>
        0
      </text>
      {compactsAt && (
        <text x={usableX - 4} y={26} textAnchor="end">
          {compactsAt}
        </text>
      )}
      <text x={BAR} y={26} textAnchor="end">
        {formatCompact(usage.limit, locale)}
      </text>
    </svg>
  )
}

function Rows({ rows, limit, locale }: { rows: { key: string; name: string; tokens: number; note?: string; share?: boolean }[]; limit: number; locale: Locale }) {
  return (
    <table className="context-rows">
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td className="name">{row.name}</td>
            <td className="num">{row.note ?? formatCompact(row.tokens, locale)}</td>
            <td className="num faint">{row.share === false ? '—' : percent(row.tokens / limit, locale, 1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** A memory file's path, from the workspace when it's inside it. */
function shortPath(file: string, root: string | undefined): string {
  return root && file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
}

/**
 * How much room is left before the agent compacts: "15K left", measured against the usable window (the whole window less
 * what the agent keeps free for compacting). Shown from 70% of it, or always if the setting asks; a warning from 90%.
 * Pressing it opens one bar of what fills the window, a legend, and Compact now, which sends /compact.
 */
export function ContextWheel({
  usage,
  agent,
  root,
  onCompact,
  running,
  draft
}: {
  usage: ContextUsage
  agent: AgentKind
  root?: string
  // Sends /compact. Absent for an agent that has none.
  onCompact?: () => void
  // A turn is running, so /compact waits for it to end.
  running?: boolean
  // The box has a draft: /compact goes on its own and leaves it there.
  draft?: boolean
}) {
  const t = useT()
  const locale = useLocale()
  const always = useStore((s) => s.snapshot?.settings.alwaysShowContextUsage ?? false)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState('')
  const hatch = `context-hatch-${useId().replace(/[^\w-]/g, '')}`
  if (!(usage.limit > 0)) return null
  const room = contextRoom(usage)
  if (!always && room.ratio <= SHOW_FROM && !open) return null
  const warn = room.ratio >= WARN_FROM
  const fmt = (n: number) => formatCompact(n, locale)
  const used = fmt(room.used)
  const limit = fmt(usage.limit)
  const left = fmt(room.left)
  const name = room.buffer ? t('contextWheel.name', { used, limit, left }) : t('contextWheel.nameFull', { used, limit, left })
  const breakdown = usage.breakdown
  const agentLabel = AGENTS[agent]?.label ?? agent
  const parts = usedParts(usage)
  const free = breakdown?.categories.find((c) => c.kind === 'free')
  const buffers = breakdown?.categories.filter((c) => c.kind === 'buffer' && c.tokens > 0) ?? []
  const deferred = breakdown?.categories.filter((c) => c.kind === 'deferred' && c.tokens > 0) ?? []
  const extras = breakdown ? [breakdown.mcpServers.length > 0 && 'mcp', breakdown.memoryFiles.length > 0 && 'memory', breakdown.skills.length > 0 && 'skills'].filter((x): x is string => Boolean(x)) : []
  const current = extras.includes(tab) ? tab : extras[0]
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={t('contextWheel.heading')}
      side="top"
      align="end"
      portal
      panelClassName="context-pop"
      trigger={(p) => (
        <Button
          {...p}
          size="sm"
          variant="ghost"
          className="context-trigger"
          aria-label={name}
          title={name}
          icon={
            warn ? (
              <Glyph name="warn" />
            ) : (
              <svg className="context-ring" width={16} height={16} viewBox="0 0 16 16" aria-hidden="true">
                <circle cx={8} cy={8} r={6.75} className="track" strokeWidth={2.5} />
                <circle cx={8} cy={8} r={6.75} className="fill" strokeWidth={2.5} strokeDasharray={2 * Math.PI * 6.75} strokeDashoffset={2 * Math.PI * 6.75 * (1 - room.ratio)} transform="rotate(-90 8 8)" />
              </svg>
            )
          }
        >
          {t('contextWheel.left', { left })}
        </Button>
      )}
    >
      <div className="context-pop-head">
        <strong>{t('contextWheel.heading')}</strong>
        <span className="faint small">{agentLabel}</span>
      </div>
      <p className="context-pop-headline">
        {warn && <Glyph name="warn" />}
        <strong>{room.buffer ? t('contextWheel.compactsIn', { left }) : t('contextWheel.leftOf', { left, limit })}</strong>
      </p>
      <p className="context-pop-sub small">
        {room.buffer
          ? t('contextWheel.usable', { used, limit, agent: agentLabel, buffer: fmt(room.buffer), usable: fmt(room.usable), percent: percent(room.ratio, locale) })
          : t('contextWheel.usedShare', { used, limit, percent: percent(room.ratio, locale) })}
      </p>
      <Bar
        usage={usage}
        room={room}
        hatch={hatch}
        label={room.buffer ? t('contextWheel.bar', { used, free: left, buffer: fmt(room.buffer) }) : t('contextWheel.barFull', { used, free: left })}
        compactsAt={room.buffer ? t('contextWheel.compactsAt', { usable: fmt(room.usable) }) : undefined}
      />
      {breakdown ? (
        <ul className="context-legend" aria-label={t('contextWheel.legend')}>
          {parts.map(({ category, segment }) => (
            <li key={category.name}>
              <Swatch part={segment} hatch={hatch} />
              <span>{category.name}</span>
              <span className="faint">{fmt(category.tokens)}</span>
            </li>
          ))}
          <li>
            <Swatch part="free" hatch={hatch} />
            <span>{free?.name ?? t('contextWheel.free')}</span>
            <span className="faint">{left}</span>
          </li>
          {buffers.map((category) => (
            <li key={category.name}>
              <Swatch part="buffer" hatch={hatch} />
              <span>{category.name}</span>
              <span className="faint">{fmt(category.tokens)}</span>
            </li>
          ))}
          {deferred.map((category) => (
            <li key={category.name} className="deferred">
              <Swatch part="deferred" hatch={hatch} />
              <span>{category.name}</span>
              <span className="faint">{t('contextWheel.deferred', { tokens: fmt(category.tokens) })}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="faint small">{t('contextWheel.totalOnly', { agent: agentLabel })}</p>
      )}
      {breakdown && current && (
        <Disclosure quiet label={t('contextWheel.more')}>
          <Tabs value={current} onChange={setTab} variant="pill">
            <TabList label={t('contextWheel.tabs')}>
              {extras.includes('mcp') && <Tab value="mcp">{t('contextWheel.tab.mcp')}</Tab>}
              {extras.includes('memory') && <Tab value="memory">{t('contextWheel.tab.memory')}</Tab>}
              {extras.includes('skills') && <Tab value="skills">{t('contextWheel.tab.skills')}</Tab>}
            </TabList>
            <TabPanel value="mcp">
              <Rows
                locale={locale}
                limit={usage.limit}
                rows={breakdown.mcpServers.map((s) => ({
                  key: s.name,
                  name: `${s.name} · ${t('contextWheel.tools', { count: s.tools })}`,
                  tokens: s.tokens,
                  share: !s.deferred,
                  note: s.deferred ? t('contextWheel.onDemand') : undefined
                }))}
              />
            </TabPanel>
            <TabPanel value="memory">
              <Rows locale={locale} limit={usage.limit} rows={breakdown.memoryFiles.map((f) => ({ key: f.path, name: shortPath(f.path, root), tokens: f.tokens }))} />
            </TabPanel>
            <TabPanel value="skills">
              <Rows locale={locale} limit={usage.limit} rows={breakdown.skills.map((s) => ({ key: s.name, name: s.name, tokens: s.tokens }))} />
            </TabPanel>
          </Tabs>
        </Disclosure>
      )}
      {onCompact && (
        <div className="context-pop-compact">
          {draft && <Callout tone="info">{t('contextWheel.compactDraft')}</Callout>}
          <div className="context-pop-actions">
            <Button
              size="sm"
              onClick={() => {
                setOpen(false)
                onCompact()
              }}
            >
              {t('contextWheel.compact')}
            </Button>
            <span className="faint small">{running ? t('contextWheel.compactQueues', { agent: agentLabel }) : t('contextWheel.compactSends', { agent: agentLabel })}</span>
          </div>
        </div>
      )}
    </Popover>
  )
}
