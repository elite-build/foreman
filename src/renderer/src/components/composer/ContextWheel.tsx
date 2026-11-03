import { useState, type ReactNode } from 'react'
import type { AgentKind, ContextBreakdown, ContextUsage } from '../../../../shared/types'
import type { Locale } from '../../../../shared/i18n'
import { formatCompact } from '../../../../shared/i18n/time'
import { AGENTS } from '../../../../shared/agents'
import { useLocale, useT } from '../../i18n'
import { useStore } from '../../store'
import { Button, Popover, Tab, TabList, TabPanel, Tabs } from '../../ui'

type Category = ContextBreakdown['categories'][number]

const percents = new Map<string, Intl.NumberFormat>()
function percent(ratio: number, locale: string, digits = 0): string {
  const key = `${locale}:${digits}`
  let f = percents.get(key)
  if (!f) percents.set(key, (f = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: digits })))
  return f.format(ratio)
}

// Segment colours go by position among what fills the window (composer-extras.css); the legend repeats each one with
// its name and size, so a colour is never the only way to tell them apart.
const SEGMENTS = 6
const segment = (c: Category, index: number) => (c.kind === 'buffer' ? 'seg-buffer' : `seg-${Math.min(index, SEGMENTS - 1)}`)

/** What's in the ring: what fills the window, biggest first, then what's kept for compaction. */
function ringParts(usage: ContextUsage): { category: Category; segment: string }[] {
  const breakdown = usage.breakdown
  if (!breakdown) return []
  const used = breakdown.categories.filter((c) => c.kind === 'used' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  const buffer = breakdown.categories.filter((c) => c.kind === 'buffer' && c.tokens > 0)
  return [...used, ...buffer].map((category, i) => ({ category, segment: segment(category, i) }))
}

// `parts`: split by what fills the window; otherwise one fill in the warning tone (amber above 70%, red above 90%).
function Ring({ usage, ratio, tone, size, stroke, parts: split, label, children }: { usage: ContextUsage; ratio: number; tone: string; size: number; stroke: number; parts?: boolean; label?: string; children?: ReactNode }) {
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  const parts = split ? ringParts(usage) : []
  let offset = 0
  return (
    <svg className={`context-ring ${tone}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <circle cx={size / 2} cy={size / 2} r={r} className="track" strokeWidth={stroke} />
      {parts.length ? (
        parts.map(({ category, segment }) => {
          const length = (category.tokens / usage.limit) * circumference
          const arc = (
            <circle
              key={category.name}
              cx={size / 2}
              cy={size / 2}
              r={r}
              className={segment}
              strokeWidth={stroke}
              strokeDasharray={`${Math.max(length - (parts.length > 1 ? 1 : 0), 0.5)} ${circumference}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          )
          offset += length
          return arc
        })
      ) : (
        <circle cx={size / 2} cy={size / 2} r={r} className="fill" strokeWidth={stroke} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - ratio)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      )}
      {children}
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
 * A ring showing how full the context window is: shown above 70%, or always if the setting asks. Pressing it opens what
 * fills the window when the agent says (Claude), or the total when that's all it reports.
 */
export function ContextWheel({ usage, agent, root, onCompact }: { usage: ContextUsage; agent: AgentKind; root?: string; onCompact?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const always = useStore((s) => s.snapshot?.settings.alwaysShowContextUsage ?? false)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState('all')
  if (!(usage.limit > 0)) return null
  const ratio = Math.min(Math.max(usage.used / usage.limit, 0), 1)
  if (!always && ratio <= 0.7 && !open) return null
  const tone = ratio >= 0.9 ? 'red' : ratio >= 0.7 ? 'amber' : ''
  const used = formatCompact(usage.used, locale)
  const limit = formatCompact(usage.limit, locale)
  const title = t('contextWheel.title', { used, limit, percent: Math.round(ratio * 100) })
  const breakdown = usage.breakdown
  const legend = ringParts(usage)
  const agentLabel = AGENTS[agent]?.label ?? agent
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
        <Button {...p} size="sm" variant="ghost" aria-label={title} title={title} icon={<Ring usage={usage} ratio={ratio} tone={tone} size={18} stroke={2.5} />}>
          {percent(ratio, locale)}
        </Button>
      )}
    >
      <div className="context-pop-head">
        <strong>{t('contextWheel.heading')}</strong>
        <span className="faint small">{agentLabel}</span>
      </div>
      <div className="context-pop-summary">
        <Ring usage={usage} ratio={ratio} tone={tone} size={116} stroke={13} parts label={t('contextWheel.chart', { percent: Math.round(ratio * 100) })}>
          <text x="50%" y="47%" textAnchor="middle" className="ring-big">{percent(ratio, locale)}</text>
          <text x="50%" y="62%" textAnchor="middle" className="ring-small">{t('contextWheel.usedOf', { used, limit })}</text>
        </Ring>
        {legend.length ? (
          <ul className="context-legend">
            {legend.map(({ category, segment }) => (
              <li key={category.name}>
                <svg className="context-ring" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="0.5" y="0.5" width="9" height="9" rx="2" className={segment} />
                </svg>
                <span>{category.name}</span>
                <span className="faint">{formatCompact(category.tokens, locale)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="faint small">{t('contextWheel.totalOnly', { agent: agentLabel })}</p>
        )}
      </div>
      {breakdown && (
        <Tabs value={tab} onChange={setTab} variant="pill">
          <TabList label={t('contextWheel.tabs')}>
            <Tab value="all">{t('contextWheel.tab.all')}</Tab>
            {breakdown.mcpServers.length > 0 && <Tab value="mcp">{t('contextWheel.tab.mcp')}</Tab>}
            {breakdown.memoryFiles.length > 0 && <Tab value="memory">{t('contextWheel.tab.memory')}</Tab>}
            {breakdown.skills.length > 0 && <Tab value="skills">{t('contextWheel.tab.skills')}</Tab>}
          </TabList>
          <div className="context-pop-rows">
            <TabPanel value="all">
              <Rows
                locale={locale}
                limit={usage.limit}
                rows={breakdown.categories.map((c) => ({ key: c.name, name: c.name, tokens: c.tokens, share: c.kind !== 'deferred' }))}
              />
            </TabPanel>
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
          </div>
        </Tabs>
      )}
      {onCompact && (
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
        </div>
      )}
    </Popover>
  )
}
