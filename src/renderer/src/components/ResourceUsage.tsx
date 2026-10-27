// Settings → Experimental → Show resource usage, in the sidebar footer: CPU and memory of Foreman's own processes and,
// when workspaces run something, the memory of what they run (agents with the MCP servers and hooks they start,
// terminals, scripts). The line opens a breakdown by workspace. Polled every 3 s while the setting is on and the window
// can be seen; main counts workspaces' processes from one system listing, refreshed less often on Windows.
import { useEffect, useState } from 'react'
import { formatMemory } from '../../../shared/i18n/time'
import type { ProcessRootKind, ResourceUsage as Usage, WorkspaceResourceUsage } from '../../../shared/types'
import { useT } from '../i18n'
import { api, useStore, useWindowVisible } from '../store'
import { Popover, Pressable } from '../ui'

export const RESOURCE_POLL_MS = 3000

const KIND_LABEL = {
  agent: 'sidebar.usage.kind.agent',
  terminal: 'sidebar.usage.kind.terminal',
  script: 'sidebar.usage.kind.script'
} as const satisfies Record<ProcessRootKind, string>

const MB = 1024 * 1024

/** Polls while `on` and the window can be seen; the last answer stays until the next. */
function useResourceUsage(on: boolean): Usage | null {
  const [usage, setUsage] = useState<Usage | null>(null)
  const windowVisible = useWindowVisible()
  useEffect(() => {
    if (!on || !windowVisible) return
    let live = true
    const poll = () =>
      void api
        .resourceUsage()
        .then((next) => live && setUsage(next))
        .catch(() => undefined)
    poll()
    const timer = setInterval(poll, RESOURCE_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [on, windowVisible])
  return on ? usage : null
}

export function ResourceUsage() {
  const t = useT()
  const on = useStore((s) => s.snapshot!.settings.showResourceUsage)
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  const usage = useResourceUsage(on)
  const [open, setOpen] = useState(false)
  if (!usage) return null
  const names = new Map(workspaces.map((w) => [w.id, w.name]))
  const rows = (usage.workspaces ?? []).filter((w) => names.has(w.workspaceId) && w.processes > 0).sort((a, b) => b.memoryBytes - a.memoryBytes)
  const own = t('sidebar.usage', { cpu: Math.round(usage.cpuPercent), memory: formatMemory(usage.memoryMb * MB, t.locale) })
  if (!rows.length) {
    return (
      <div className="sidebar-usage" title={t('sidebar.usage.title')}>
        {own}
      </div>
    )
  }
  const total = rows.reduce((n, w) => n + w.memoryBytes, 0)
  return (
    <div className="sidebar-usage">
      <Popover
        open={open}
        onOpenChange={setOpen}
        label={t('sidebar.usage.panel')}
        portal
        panelClassName="usage-panel"
        trigger={(p) => (
          <Pressable {...p} className="usage-trigger" title={t('sidebar.usage.title')}>
            {own} · {t('sidebar.usage.workspaces', { memory: formatMemory(total, t.locale) })}
          </Pressable>
        )}
      >
        <div className="usage-body">
          <p className="usage-note">{t('sidebar.usage.note')}</p>
          <ul className="usage-list">
            {rows.map((w) => (
              <WorkspaceUsageItem key={w.workspaceId} name={names.get(w.workspaceId)!} usage={w} />
            ))}
          </ul>
        </div>
      </Popover>
    </div>
  )
}

function WorkspaceUsageItem({ name, usage }: { name: string; usage: WorkspaceResourceUsage }) {
  const t = useT()
  const memory = (bytes: number) => formatMemory(bytes, t.locale)
  return (
    <li className="usage-item">
      <span className="usage-name">{name}</span>
      <span>{t('sidebar.usage.workspace', { memory: memory(usage.memoryBytes), cpu: Math.round(usage.cpuPercent), count: usage.processes })}</span>
      {usage.kinds.length > 0 && <span className="usage-detail">{usage.kinds.map((k) => t(KIND_LABEL[k.kind], { memory: memory(k.memoryBytes) })).join(' · ')}</span>}
      {usage.top.length > 0 && (
        <span className="usage-detail">{usage.top.map((g) => t('sidebar.usage.group', { name: g.name, count: g.count, memory: memory(g.memoryBytes) })).join(' · ')}</span>
      )}
    </li>
  )
}
