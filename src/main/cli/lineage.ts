// `foreman workspace lineage` and `foreman flow draft` (docs/loops-and-graphs.md, "Recovering graphs from what
// happened"), behind Settings → Experimental → Flows like the Lineage tab: a workspace's history through one lens as the
// outline (or the diagram's Mermaid source), and a flow drafted from it, saved as a personal flow with --save. Reads the
// same records the tab does (main/lineage.ts), through the host; the words are English, as the command line's are.
import { flowMermaid } from '../../shared/flowGraph'
import { draftFlowFromLineage, leftOutText, lineageGraph, lineageOutline, LINEAGE_LENSES, type LineageLens } from '../../shared/lineage'
import type { FlowDraftResult } from '../../shared/cli/flows'
import type { WsLineageResult } from '../../shared/cli/workspaces'
import { lineageInput } from '../lineage'
import { flowsOn } from './flows'
import type { CliHost } from './host'
import { flagParam, invalid, paramsObject, textParam, type MethodDef } from './kit'
import { findWorkspace } from './resolve'

const GAP_TEXT: Record<string, string> = {
  'Session.handedOffFrom': 'where a handed-off chat came from',
  'Workspace.startedBy': 'which chat started this workspace',
  MessageOrigin: 'why Foreman sent a message itself',
  'turn-end.usage': 'how full the window was as each turn ended',
  'turn-end.memoryWrites': 'which memory files each turn wrote',
  'turn-end.tree': 'which tree each turn started from and ended on',
  'WorkspaceChecks.startedBy': 'what started the check run'
}

/** The records a workspace's lineage is drawn from, read through the host. */
async function inputFor(host: CliHost, p: Record<string, unknown>) {
  const state = host.state()
  const ws = findWorkspace(state, textParam(p, 'workspace'), textParam(p, 'cwd', { optional: true }) ?? process.cwd())
  const input = await lineageInput(
    {
      workspaces: state.workspaces,
      sessions: state.sessions,
      readChat: (id) => host.api.getChat(id),
      flowRuns: await host.api.listFlowRuns().catch(() => []),
      templateNames: Object.fromEntries(state.settings.promptTemplates.map((t) => [t.id, t.name]))
    },
    ws.id
  )
  return { ws, input }
}

/** `ws-lineage`, listed with the other workspace methods. */
export const wsLineage: MethodDef = {
  tier: 'read',
  async handle(host, params): Promise<WsLineageResult> {
    flowsOn(host)
    const p = paramsObject(params)
    const lens = (textParam(p, 'lens', { optional: true }) ?? 'run') as LineageLens
    if (!LINEAGE_LENSES.includes(lens)) throw invalid(`--lens is ${LINEAGE_LENSES.join(', ')}, not “${lens}”.`)
    const { ws, input } = await inputFor(host, p)
    const graph = lineageGraph(input, lens)
    const outline = lineageOutline(graph)
    const mermaid = flowMermaid(graph)
    const base = { workspace: { id: ws.id, name: ws.name }, lens, outline, gaps: graph.gaps, mermaid }
    if (flagParam(p, 'mermaid')) return { ...base, text: mermaid }
    const lines = [graph.title]
    if (!outline.length) lines.push('', 'No turns yet.')
    for (const entry of outline) {
      lines.push('', entry.label)
      for (const line of entry.sublabel?.split('\n') ?? []) lines.push(`  ${line}`)
      for (const e of entry.edges) {
        const words = e.direction === 'from' ? `${e.label ?? 'after'} from ${e.other}` : `${e.label ?? 'then'} to ${e.other}`
        lines.push(`  ${e.direction === 'from' ? '←' : '→'} ${words}${e.reconstructed ? ' (inferred)' : ''}`)
      }
      if (entry.tags.length) lines.push(`  ${entry.tags.join(' · ')}`)
    }
    if (graph.gaps.length) {
      lines.push('', 'Gaps: this history lacks these records, so the edges that need them are inferred:')
      for (const gap of graph.gaps) lines.push(`  ${gap}: ${GAP_TEXT[gap] ?? gap}`)
    }
    return { ...base, text: lines.join('\n') }
  }
}

const draft: MethodDef = {
  // Saving writes a personal flow, as `flow add` does, so it is admin like flow add: never from inside an agent turn.
  tier: 'admin',
  async handle(host, params): Promise<FlowDraftResult> {
    flowsOn(host)
    const p = paramsObject(params)
    const { ws, input } = await inputFor(host, p)
    const drafted = draftFlowFromLineage(lineageGraph(input, 'run'))
    const name = textParam(p, 'name', { optional: true })?.trim()
    if (name && !flagParam(p, 'save')) throw invalid('--name names the flow --save keeps; add --save.')
    const toml = name ? drafted.toml.replace(/^name = .*$/m, `name = ${JSON.stringify(name)}`) : drafted.toml
    const base = { workspace: { id: ws.id, name: ws.name }, toml, leftOut: drafted.leftOut }
    const left = drafted.leftOut.map((l) => `  - ${leftOutText(l)}`)
    if (!flagParam(p, 'save')) return { ...base, text: toml.trimEnd() }
    const saved = await host.api.savePersonalFlow({ toml })
    if ('problems' in saved) return { ...base, saved: false, problems: saved.problems, text: [`Not saved: the draft isn’t a flow yet.`, ...saved.problems.map((x) => `  ${x}`), '', toml.trimEnd()].join('\n') }
    const lines = [`Saved the personal flow “${saved.flow.name}” (id ${saved.flow.id}) from ${ws.name}.`, 'Read it with `foreman flow show`, and run it with `foreman flow run` once it says what you want.']
    if (left.length) lines.push('Left out:', ...left)
    return { ...base, saved: true, flow: { id: saved.flow.id, name: saved.flow.name }, text: lines.join('\n') }
  }
}

/** `flow-draft`, registered beside the flow methods (it reads a workspace, so it lives here rather than in flows.ts). */
export const LINEAGE_METHODS: Record<string, MethodDef> = {
  'flow-draft': draft
}
