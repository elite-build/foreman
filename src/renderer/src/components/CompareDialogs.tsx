// Compare models: the dialog behind "Also try with…" and "Compare…", the Home row
// for a running comparison, and the confirmation for "Archive others". The dialog
// says what will be created, what it costs and how each target is allowed to act.
// It never picks a winner: you open whichever you like.
import { Zap } from 'lucide-react'
import { useRef, useState } from 'react'
import { AGENTS, effortLabel, modelInfo, type Loadout } from '../../../shared/agents'
import { COMPARE_MAX_EXTRA, compareBlock, compareSummary, costNote, promptTitle, type CompareGroup } from '../../../shared/compare'
import { permissionNote } from '../../../shared/permissions'
import { api, attempt, availableAgents, openCompareArchive, openCompareDialog, selectSession, selectWorkspace, useStore } from '../store'
import { AgentIcon, ModelChooser, opencodeModelParts } from './composer/AgentPicker'
import { useT } from '../i18n'
import { ActionRow, Button, Callout, Checkbox, Dialog, Field, LinkButton, MenuButton, MenuItem, MenuLabel, Popover, Tag, TextArea } from '../ui'

function nameOf(model: Loadout): string {
  const info = modelInfo(model.agent, model.model)
  return model.agent === 'opencode' ? opencodeModelParts(info).name : info.label
}

const same = (a: Loadout, b: Loadout) => a.agent === b.agent && a.model === b.model && a.effort === b.effort && a.fast === b.fast

function ModelLine({ model }: { model: Loadout }) {
  const t = useT()
  return (
    <span className="compare-model">
      <AgentIcon agent={model.agent} />
      <span>{nameOf(model)}</span>
      {model.effort && modelInfo(model.agent, model.model).efforts.length > 0 && <span className="faint">{effortLabel(model.effort, t)}</span>}
      {model.fast && <Zap size={11} className="fast-on" aria-hidden />}
    </span>
  )
}

export function CompareDialog({ workspaceId, sessionId, prompt: initialPrompt }: { workspaceId: string; sessionId?: string; prompt?: string }) {
  const snapshot = useStore((s) => s.snapshot!)
  const available = useStore((s) => availableAgents(s))
  const ws = snapshot.workspaces.find((w) => w.id === workspaceId)
  const tabs = snapshot.sessions.filter((s) => s.workspaceId === workspaceId)
  const tab = tabs.find((s) => s.id === sessionId) ?? tabs.find((s) => !s.closedAt)
  const [prompt, setPrompt] = useState(initialPrompt ?? '')
  const [picked, setPicked] = useState<Loadout[]>([])
  const [chooser, setChooser] = useState(false)
  const [extra, setExtra] = useState<Loadout>({ agent: 'claude', model: '', fast: false })
  const [busy, setBusy] = useState(false)
  // Set synchronously so a double-click can't start twice before React re-renders.
  const starting = useRef(false)
  const t = useT()
  const close = () => openCompareDialog(null)
  if (!ws || !tab) return null

  const reason = compareBlock(ws, tabs, t)
  const loadouts = snapshot.settings.loadouts
  const toggle = (model: Loadout) => setPicked((now) => (now.some((p) => same(p, model)) ? now.filter((p) => !same(p, model)) : now.length < COMPARE_MAX_EXTRA ? [...now, model] : now))
  const others = picked.filter((p) => !loadouts.some((l) => same(l, p)))
  const full = picked.length >= COMPARE_MAX_EXTRA
  const runs = picked.length + 1
  const ready = !reason && picked.length >= 1 && Boolean(prompt.trim()) && !busy

  const start = async () => {
    if (starting.current || !ready) return
    starting.current = true
    setBusy(true)
    const result = await attempt(() => api.startCompare(workspaceId, { sessionId: tab.id, prompt, models: picked }))
    if (result) {
      // The prompt went out from here; the composer's copy of it would only be sent twice.
      window.dispatchEvent(new CustomEvent('foreman:command', { detail: { command: 'clear-composer', workspaceId } }))
      close()
      return
    }
    starting.current = false
    setBusy(false)
  }

  return (
    <Dialog
      title={t('compare.dialog.title')}
      onClose={close}
      size="lg"
      className="dlg"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void start()}>
            {picked.length === 0 ? t('compare.dialog.pickModel') : t('compare.dialog.create', { count: picked.length })}
          </Button>
        </>
      }
    >
      <p className="small muted">
        {t.rich('compare.dialog.intro', { samePrompt: <b>{t('compare.dialog.samePrompt')}</b>, worktree: <b>{t('compare.dialog.separateWorktree')}</b> })}
      </p>
      {reason && <Callout tone="error" role="alert">{reason}</Callout>}
      <Field label={t('compare.dialog.prompt')}>
        {(control) => <TextArea {...control} rows={3} value={prompt} placeholder={t('compare.dialog.promptPlaceholder')} onChange={(e) => setPrompt(e.target.value)} />}
      </Field>
      <div className="dlg-group" role="group" aria-labelledby="compare-models-label" aria-describedby="compare-models-hint">
        <span id="compare-models-label" className="dlg-label">
          {t('compare.dialog.models')}
        </span>
        <div className="compare-models">
          <Checkbox checked readOnly disabled>
            <ModelLine model={{ agent: tab.agent, model: tab.model, effort: tab.effort, fast: tab.fastMode }} />
            <span className="faint small">{t('compare.dialog.thisTab', { workspace: ws.name })}</span>
          </Checkbox>
          {[...loadouts, ...others].map((model, n) => {
            const on = picked.some((p) => same(p, model))
            return (
              <Checkbox key={n} checked={on} disabled={!available[model.agent] || (!on && full)} onChange={() => toggle(model)}>
                <ModelLine model={model} />
              </Checkbox>
            )
          })}
          <Popover
            open={chooser}
            onOpenChange={setChooser}
            label={t('compare.dialog.anotherModel')}
            side="bottom"
            portal
            panelClassName="picker-panel"
            trigger={(popover) => (
              <LinkButton {...popover} disabled={full}>
                {t('compare.dialog.anotherModel')}
              </LinkButton>
            )}
          >
            <ModelChooser
              inPopover
              value={extra}
              onChoose={(choice) => {
                setExtra(choice)
                toggle(choice)
                setChooser(false)
              }}
              onEffort={(effort) => setExtra({ ...extra, effort })}
              onFast={(fast) => setExtra({ ...extra, fast })}
              onClose={() => setChooser(false)}
              footer={null}
            />
          </Popover>
        </div>
        <small id="compare-models-hint" className="dlg-hint">
          {t('compare.dialog.pickHint')}
        </small>
      </div>
      <Callout>
        <div>{t.rich('compare.dialog.setup', { before: <b>{t('compare.dialog.before')}</b> })}</div>
        <div>
          <b>{costNote(runs, t)}</b> {t('compare.dialog.noWinner')}
        </div>
        <div>
          {t('compare.dialog.permissions')}{' '}
          {[{ agent: tab.agent }, ...picked].map((m, n) => (
            <span key={n}>
              {n > 0 && ' · '}
              <b>
                {AGENTS[m.agent].label}: {permissionNote(m.agent, snapshot.settings, t)}
              </b>
            </span>
          ))}
        </div>
      </Callout>
    </Dialog>
  )
}

export function CompareArchiveDialog({ compareId, keepWorkspaceId }: { compareId: string; keepWorkspaceId: string }) {
  const snapshot = useStore((s) => s.snapshot!)
  const group = snapshot.workspaces.filter((w) => w.compareId === compareId && w.state !== 'archived')
  const keep = group.find((w) => w.id === keepWorkspaceId)
  const others = group.filter((w) => w.id !== keepWorkspaceId)
  const [busy, setBusy] = useState(false)
  const t = useT()
  const close = () => openCompareArchive(null)
  if (!keep) return null
  const archive = async () => {
    setBusy(true)
    const done = await attempt(async () => (await api.archiveCompareOthers(compareId, keepWorkspaceId), true))
    setBusy(false)
    if (done) close()
  }
  return (
    <Dialog
      title={t('compare.archive.title', { name: keep.name })}
      onClose={close}
      className="dlg"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void archive()}>
            {busy ? t('compare.archive.archiving') : t('compare.archive.button', { count: others.length })}
          </Button>
        </>
      }
    >
      <p className="muted">{t('compare.archive.body', { others: others.map((w) => w.name).join(', '), keep: keep.name })}</p>
    </Dialog>
  )
}

/** Home's row for one comparison: how far each run got, and where to go next. Never says which is better. */
export function CompareRow({ group }: { group: CompareGroup }) {
  const t = useT()
  const done = group.members.every((m) => m.finished)
  const open = (id: string, sessionId?: string) => {
    selectWorkspace(id)
    if (sessionId) selectSession(id, sessionId)
  }
  return (
    <ActionRow
      divided
      className="compare-row"
      onPress={() => open(group.members[0].ws.id, group.members[0].session?.id)}
      primaryProps={{ className: 'compare-row-flow' }}
      actions={
        <>
          <MenuButton label={t('compare.row.continue')} look="button" small portal placement="bottom-start" trigger={t('compare.row.continue')}>
            {group.members.map((m) => (
              <MenuItem key={m.ws.id} onSelect={() => open(m.ws.id, m.session?.id)}>
                {m.ws.name} · {m.label}
              </MenuItem>
            ))}
          </MenuButton>
          <MenuButton label={t('compare.row.archiveOthers')} look="ghost" small portal placement="bottom-start" trigger={t('compare.row.archiveOthers')}>
            <MenuLabel>{t('compare.row.keep')}</MenuLabel>
            {group.members.map((m) => (
              <MenuItem key={m.ws.id} onSelect={() => openCompareArchive({ compareId: group.id, keepWorkspaceId: m.ws.id })}>
                {m.ws.name} · {m.label}
              </MenuItem>
            ))}
          </MenuButton>
        </>
      }
    >
      <Tag tone={done ? 'info' : 'neutral'} className="card-row-tag">
        {done ? t('compare.row.done') : t('compare.row.comparing')}
      </Tag>
      <span className="home-row-main">
        <span className="home-row-title">
          <span className="home-row-name">{promptTitle(group.prompt, 60)}</span>
          <span className="home-row-branch">×{group.members.length}</span>
        </span>
        <span className="home-row-sub" title={group.members.map((m) => `${m.label}: ${m.ws.name}`).join('\n')}>
          {compareSummary(group, t)}
        </span>
      </span>
    </ActionRow>
  )
}
