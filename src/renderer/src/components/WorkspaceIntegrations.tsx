// Which integrations' tools a workspace's agents get. Each connection says whether new workspaces start with it on
// (a repository can override that); New workspace and the composer switch it per workspace. One that's off gets no
// MCP server and adds nothing to the agent's context. Switching never grants access: only ready connections that
// agents may use are listed.
import { ChevronDown, Plug } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { workspaceTools, type RepoIntegrationService, type ToolCost, type WorkspaceIntegrations, type WorkspaceTool } from '../../../shared/integrations'
import { formatCompact } from '../../../shared/i18n/time'
import { AGENTS, type AgentKind } from '../../../shared/agents'
import type { Repo, Workspace } from '../../../shared/types'
import { useT } from '../i18n'
import { api, attempt, useStore } from '../store'
import { MenuButton, MenuCheckboxItem, MenuGroup, MenuLabel, MenuSeparator, type FieldControlProps, type MenuButtonLook } from '../ui'
import { SERVICE_NAMES, ServiceMark } from './settings/integrations/ServiceMark'
import './settings/integrations/integrations.css'

/** The integrations a workspace in this repository can switch, with `choice` over the defaults. */
export function useWorkspaceTools(repo: Repo | undefined, choice: WorkspaceIntegrations | undefined): WorkspaceTool[] {
  const connections = useStore((s) => s.snapshot!.integrations.connections)
  return useMemo(() => {
    if (!repo) return []
    const defaults = Object.fromEntries(connections.filter((c) => c.isDefault).map((c) => [c.service, c.id]))
    return workspaceTools({ connections, defaults, rules: [], people: [] }, repo, choice)
  }, [connections, repo, choice])
}

/** How much each integration's tools cost, asked when the menu opens (main caches the lists). Null until known. */
function useToolCosts(repoId: string, open: boolean): ToolCost[] | null {
  const [costs, setCosts] = useState<ToolCost[] | null>(null)
  useEffect(() => {
    if (!open) return
    let live = true
    api.integrationToolCosts(repoId).then(
      (next) => live && setCosts(next),
      () => live && setCosts([])
    )
    return () => {
      live = false
    }
  }, [repoId, open])
  return costs
}

interface IntegrationsMenuProps {
  repoId: string
  tools: WorkspaceTool[]
  onChange: (service: RepoIntegrationService, on: boolean) => void
  look?: MenuButtonLook
  small?: boolean
  // Show only how many are on (the composer's chip), not their names.
  compact?: boolean
  title?: string
  triggerClassName?: string
  // From a Field: the trigger is its control.
  control?: FieldControlProps
}

/** A menu of the integrations a workspace can switch, grouped by what new workspaces start with. */
export function IntegrationsMenu({ repoId, tools, onChange, look = 'button', small, compact, title, triggerClassName, control }: IntegrationsMenuProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const costs = useToolCosts(repoId, open)
  const costOf = (service: RepoIntegrationService) => costs?.find((c) => c.service === service)
  const on = tools.filter((x) => x.on)
  // What the switched-on ones add, once every one of them is known.
  const onCosts = on.map((x) => costOf(x.service))
  const total = costs && onCosts.every(Boolean) ? onCosts.reduce((n, c) => n + c!.tokens, 0) : null
  const names = on.length ? on.map((x) => SERVICE_NAMES[x.service]).join(', ') : t('workspaceIntegrations.none')
  const group = (items: WorkspaceTool[], label: string) =>
    items.length > 0 && (
      <MenuGroup label={label}>
        <MenuLabel>{label}</MenuLabel>
        {items.map((x) => (
          <MenuCheckboxItem
            key={x.service}
            checked={x.on}
            closeOnSelect={false}
            icon={<ServiceMark service={x.service} size={16} />}
            description={x.connection.agentAccess === 'read' ? t('workspaceIntegrations.readOnly', { name: x.connection.name }) : x.connection.name}
            hint={costOf(x.service) ? t('workspaceIntegrations.cost', { count: costOf(x.service)!.tools, tokens: formatCompact(costOf(x.service)!.tokens, t.locale) }) : undefined}
            onCheckedChange={(next) => onChange(x.service, next)}
          >
            {SERVICE_NAMES[x.service]}
          </MenuCheckboxItem>
        ))}
      </MenuGroup>
    )
  return (
    <MenuButton
      {...control}
      label={t('workspaceIntegrations.label')}
      aria-label={t('workspaceIntegrations.trigger', { names })}
      title={title}
      look={look}
      small={small}
      portal
      placement="bottom-start"
      triggerClassName={triggerClassName}
      onOpenChange={setOpen}
      trigger={
        <>
          <Plug size={13} aria-hidden />
          <span className="ws-int-names">{compact ? on.length : names}</span>
          <ChevronDown size={12} aria-hidden />
        </>
      }
    >
      {group(
        tools.filter((x) => x.byDefault),
        t('workspaceIntegrations.onByDefault')
      )}
      {group(
        tools.filter((x) => !x.byDefault),
        t('workspaceIntegrations.offByDefault')
      )}
      {total !== null && (
        <>
          <MenuSeparator />
          <MenuLabel>{on.length ? t('workspaceIntegrations.total', { tokens: formatCompact(total, t.locale) }) : t('workspaceIntegrations.totalNone')}</MenuLabel>
        </>
      )}
    </MenuButton>
  )
}

/** The composer's chip: switch an integration for this workspace's next turns. Only for agents that take MCP servers. */
export function WorkspaceToolsChip({ workspace, agent }: { workspace: Workspace; agent: AgentKind }) {
  const t = useT()
  const repo = useStore((s) => s.snapshot!.repos.find((r) => r.id === workspace.repoId))
  const tools = useWorkspaceTools(repo, workspace.integrations)
  if (!tools.length || workspace.cloud || !AGENTS[agent]?.supportsRepoMcp) return null
  return (
    <IntegrationsMenu
      repoId={workspace.repoId}
      tools={tools}
      look="chip"
      small
      compact
      title={t('workspaceIntegrations.composerTitle')}
      onChange={(service, on) => void attempt(() => api.setWorkspaceIntegration(workspace.id, service, on))}
    />
  )
}
