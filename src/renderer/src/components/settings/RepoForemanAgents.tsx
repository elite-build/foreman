// #2 Repository → Actions → Foreman for agents: "Teach agents Foreman", the separate
// opt-in for `foreman run` / `send`, the exact instructions each agent would get, and
// the "Plan the work" template. Stored on this computer only; nothing goes into the repo.
import { Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AGENT_ORDER, AGENTS, type AgentKind } from '../../../../shared/agents'
import { byteLength, missingPlanTemplates, teachText } from '../../../../shared/agentReports'
import { partSize } from '../../../../shared/context'
import type { Repo } from '../../../../shared/types'
import { api, showToast, useStore } from '../../store'
import { useT } from '../../i18n'
import { Button, Segmented } from '../../ui'
import { RepoToggleRow, Row, Section, saveSettings, useRepoSetting } from './controls'
import '../agentReports.css'

/** Whether the `foreman` command is installed; null while the first check runs. */
function useCliInstalled(): boolean | null {
  const [installed, setInstalled] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    api.cliStatus().then(
      (s) => alive && setInstalled(s.installed),
      () => alive && setInstalled(false)
    )
    return () => {
      alive = false
    }
  }, [])
  return installed
}

export function ForemanForAgents({ repo }: { repo: Repo }) {
  const t = useT()
  const teach = useRepoSetting(repo.id, 'teachAgents').value
  const mayStart = useRepoSetting(repo.id, 'agentsMayStart').value
  const checksAfterTurn = useRepoSetting(repo.id, 'checksAfterTurn').value
  const cli = useCliInstalled()
  const [agent, setAgent] = useState<AgentKind>('claude')
  const templates = useStore((s) => s.snapshot!.settings.promptTemplates)
  const missing = missingPlanTemplates(templates)
  const taught = teachText({ agent, cli: Boolean(cli), mayStart, checksAfterTurn })
  const code = (text: string) => <code>{text}</code>

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(taught.text)
      showToast(t('reports.settings.copied'))
    } catch {
      showToast(t('reports.settings.copyFailed'))
    }
  }

  const addPlan = async () => {
    if (!missing.length) return
    if (await saveSettings({ promptTemplates: [...templates, ...missing] })) showToast(t('reports.settings.planAddedToast'))
  }

  return (
    <Section title={t('reports.settings.section')} description={t('reports.settings.sectionDesc')}>
      <RepoToggleRow repoId={repo.id} setting="teachAgents" id="teach-agents" label={t('reports.settings.teach')} help={t('reports.settings.teachHelp')} />
      <RepoToggleRow
        repoId={repo.id}
        setting="agentsMayStart"
        id="agents-may-start"
        label={t('reports.settings.mayStart')}
        help={t.rich('reports.settings.mayStartHelp', { run: code('foreman run'), send: code('foreman send') })}
        detail={<span className="repo-warning">{t('reports.settings.cooperative')}</span>}
      />
      <Row
        id="teach-agents-preview"
        stacked
        label={t('reports.settings.instructions')}
        help={t.rich('reports.settings.instructionsHelp', { cli: code('foreman') })}
        detail={!teach ? t('reports.settings.offNote') : undefined}
      >
        <div className="instr-box">
          <div className="instr-head">
            <Segmented plain small label={t('reports.settings.instructions')} value={agent} onChange={setAgent} options={AGENT_ORDER.map((a) => ({ value: a, label: AGENTS[a].label }))} />
            <span className="spacer" />
            {taught.text && (
              <>
                <span className="faint small">
                  {partSize({ kind: 'foreman', label: '', size: byteLength(taught.text), unit: 'bytes', source: '' })} ·{' '}
                  {taught.commands.includes('run') ? t('reports.settings.runSendListed') : t('reports.settings.runSendHidden')}
                </span>
                <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => void copy()}>
                  {t('reports.settings.copy')}
                </Button>
              </>
            )}
          </div>
          {taught.text ? (
            <pre className="set-code instr-pre">{taught.text}</pre>
          ) : (
            cli !== null && <p className="faint small">{t.rich('reports.settings.nothing', { agent: AGENTS[agent].label, cli: code('foreman') })}</p>
          )}
          {/* G1: Cursor now gets report and request_review as SDK tools, so its reports land on the tab; untested without a key. */}
          {agent === 'cursor' && taught.text && <p className="faint small">{t('g1.reports.cursorTools')}</p>}
        </div>
      </Row>
      <Row id="plan-the-work" label={t('reports.settings.plan')} help={t.rich('reports.settings.planHelp', { run: code('foreman run … --base …') })}>
        <Button size="sm" disabled={!missing.length} onClick={() => void addPlan()}>
          {missing.length ? t('reports.settings.planAdd') : t('reports.settings.planAdded')}
        </Button>
      </Row>
    </Section>
  )
}
