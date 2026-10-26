// One dialog for starting a new chat from another: Second opinion, the Git
// panel's Review, and Continue in another chat. It previews what would be sent
// and where, then starts the chat in this worktree.
import { ChevronDown, Lock, Zap } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AGENTS, effortLabel, modelInfo, type Loadout } from '../../../shared/agents'
import { MAX_OPEN_TABS, placeSections, sizeLine } from '../../../shared/handOff'
import { permissionNote, readOnlyEnforcement } from '../../../shared/permissions'
import type { HandOffKind, HandOffPreview } from '../../../shared/types'
import { api, attempt, availableAgents, modKey, openHandOffDialog, openSessions, selectSession, useStore } from '../store'
import { AgentIcon, ModelChooser, opencodeModelParts } from './composer/AgentPicker'
import { withReviewRequest } from '../../../shared/agentReports'
import { useT } from '../i18n'
import type { PlainKey } from '../../../shared/i18n'
import { ActionRow, Button, Callout, Checkbox, ChipButton, Dialog, Field, Kbd, Popover, Select, Tag, TextArea } from '../ui'

const TITLES: Record<HandOffKind, PlainKey> = {
  'second-opinion': 'secondOpinion.title.secondOpinion',
  review: 'secondOpinion.title.review',
  continue: 'secondOpinion.title.continue'
}

function modelName(model: Loadout): string {
  const info = modelInfo(model.agent, model.model)
  return model.agent === 'opencode' ? opencodeModelParts(info).name : info.label
}

/** Loadouts at the top of the chooser, as in the composer's picker. */
function LoadoutRows({ onPick }: { onPick: (loadout: Loadout) => void }) {
  const loadouts = useStore((s) => s.snapshot!.settings.loadouts)
  const available = useStore((s) => availableAgents(s))
  const t = useT()
  if (!loadouts.length) return null
  return (
    <div className="picker-section">
      <div className="picker-label">{t('secondOpinion.loadouts')}</div>
      {loadouts.map((loadout, n) => (
        <ActionRow key={n} onPress={() => onPick(loadout)} disabled={!available[loadout.agent]} primaryProps={{ className: 'picker-row-main' }}>
          <span className="picker-num">{n + 1}</span>
          <AgentIcon agent={loadout.agent} />
          <span className="picker-row-label">{modelName(loadout)}</span>
          {loadout.effort && <span className="faint">{effortLabel(loadout.effort, t)}</span>}
          {loadout.fast && <Zap size={11} className="fast-on" aria-hidden />}
        </ActionRow>
      ))}
    </div>
  )
}

/**
 * #16: the Access section. Read-only is offered only where Foreman enforces it (Claude: plan mode it can't
 * leave; Codex: the read-only sandbox). Elsewhere the checkbox is gone, with one line saying why.
 */
function AccessField({ agent, checked, onChange }: { agent: Loadout['agent']; checked: boolean; onChange: (on: boolean) => void }) {
  const t = useT()
  const labelId = useId()
  const how = readOnlyEnforcement(agent)
  return (
    <div className="dlg-group" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="dlg-label">
        {t('readOnlyOpinion.access')}
      </span>
      {how ? (
        <>
          <div className="handoff-check">
            <Checkbox checked={checked} onChange={(e) => onChange(e.target.checked)}>
              {t('readOnlyOpinion.label')}
            </Checkbox>
            {checked && <Tag>{t('readOnlyOpinion.enforcedTag')}</Tag>}
          </div>
          <small className="dlg-hint">{checked ? t(how === 'plan' ? 'readOnlyOpinion.enforced.claude' : 'readOnlyOpinion.enforced.codex') : t('readOnlyOpinion.off')}</small>
        </>
      ) : (
        <small className="read-only-receipt">
          <Lock size={11} aria-hidden /> {t('readOnlyOpinion.unavailable', { agent: AGENTS[agent].label })}
        </small>
      )}
    </div>
  )
}

// #2: `prefill` is what the worker asked to have checked (Home's "Worker asks for a review · Open…"); `reportId` is that request.
export function SecondOpinionDialog({ sourceId, kind, prefill, reportId, readOnly: startReadOnly }: { sourceId: string; kind: HandOffKind; prefill?: string; reportId?: string; readOnly?: boolean }) {
  const source = useStore((s) => s.snapshot!.sessions.find((x) => x.id === sourceId))
  const snapshot = useStore((s) => s.snapshot!)
  const platform = snapshot.platform
  const [preview, setPreview] = useState<HandOffPreview | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [model, setModel] = useState<Loadout | null>(null)
  const [useTask, setUseTask] = useState(false)
  const [taskTurnId, setTaskTurnId] = useState<string | undefined>()
  const [useAnswer, setUseAnswer] = useState(false)
  const [useDiff, setUseDiff] = useState(false)
  const [message, setMessage] = useState('')
  // #16: Read-only, on by default for a second opinion (an opinion rarely needs to edit files). Only sent where it's enforced.
  const [readOnly, setReadOnly] = useState(kind === 'second-opinion' || Boolean(startReadOnly))
  const t = useT()
  const [chooser, setChooser] = useState(false)
  const [busy, setBusy] = useState(false)
  // Set synchronously so a double-click can't start twice before React re-renders.
  const starting = useRef(false)
  const close = () => openHandOffDialog(null)

  /** Read the chat and files; `keep` leaves the user's edits in place (refresh after a stale start). */
  const load = async (keep: boolean) => {
    const next = await attempt(() => api.prepareHandOff(sourceId, kind))
    if (!next) {
      setError(t('secondOpinion.readError'))
      return
    }
    setPreview(next)
    if (!keep) {
      setModel(next.model)
      setMessage(withReviewRequest(next.message, prefill))
      // Review keeps today's instructions and reads the diff itself; the others ship what's ticked.
      setUseTask(kind === 'second-opinion' && next.tasks.length > 0)
      setUseAnswer(kind !== 'review' && Boolean(next.answer))
      setUseDiff(kind !== 'review' && Boolean(next.diff))
      setTaskTurnId(next.defaultTaskTurnId)
    } else {
      setTaskTurnId((id) => (id && next.tasks.some((t) => t.turnId === id) ? id : next.defaultTaskTurnId))
      setUseTask((v) => v && next.tasks.length > 0)
      setUseAnswer((v) => v && Boolean(next.answer))
      setUseDiff((v) => v && Boolean(next.diff))
    }
  }

  useEffect(() => {
    void load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const task = preview?.tasks.find((t) => t.turnId === taskTurnId)
  const sizes = useMemo(() => {
    const parts: { kind: 'task' | 'answer' | 'diff'; bytes: number }[] = []
    if (useTask && task) parts.push({ kind: 'task', bytes: task.bytes })
    if (useAnswer && preview?.answer) parts.push({ kind: 'answer', bytes: preview.answer.bytes })
    if (useDiff && preview?.diff) parts.push({ kind: 'diff', bytes: preview.diff.bytes })
    return placeSections(parts)
  }, [useTask, useAnswer, useDiff, task, preview])

  if (!source) return null
  // #16: Continue hands work on, so it has no Access choice; the others offer Read-only where Foreman can enforce it.
  const offersReadOnly = kind !== 'continue'
  const open = openSessions(snapshot, source.workspaceId).length
  const atLimit = open >= MAX_OPEN_TABS

  const start = async () => {
    if (starting.current || !preview || !model || atLimit || !message.trim()) return
    starting.current = true
    setBusy(true)
    setNote('')
    const result = await attempt(() =>
      api.startHandOff(sourceId, {
        kind,
        model,
        message,
        taskTurnId: useTask ? taskTurnId : undefined,
        answer: useAnswer,
        diff: useDiff,
        readOnly: offersReadOnly && readOnly && readOnlyEnforcement(model.agent) ? true : undefined,
        expect: { task: useTask ? task?.hash : undefined, answer: useAnswer ? preview.answer?.hash : undefined, diff: useDiff ? preview.diff?.hash : undefined }
      })
    )
    if (result && 'session' in result) {
      // #2: the review the worker asked for has started, so its Home row goes to history.
      if (reportId) void attempt(() => api.closeAgentReport(source.workspaceId, reportId, 'opened'))
      close()
      selectSession(source.workspaceId, result.session.id)
      return
    }
    if (result && 'stale' in result) {
      // Nothing was started. Show the current sizes and let the user confirm again.
      await load(true)
      setNote(t('secondOpinion.stale', { reason: result.stale }))
    }
    starting.current = false
    setBusy(false)
  }

  // Ctrl+Enter (⌘↵ on a Mac) starts, from the form and from the buttons under it.
  const startKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (platform === 'darwin' ? e.metaKey : e.ctrlKey)) {
      e.preventDefault()
      void start()
    }
  }

  const heading = kind === 'continue' && preview?.followUp ? t('secondOpinion.continueTo', { title: preview.followUp.title }) : t(TITLES[kind])
  const mod = modKey(platform)
  const diffLabel = preview?.diff
    ? t(preview.diff.stat ? 'secondOpinion.diffStatLabel' : 'secondOpinion.diffLabel', { base: preview.diff.baseRef, count: preview.diff.files, additions: preview.diff.additions, deletions: preview.diff.deletions })
    : t('secondOpinion.diffNone')

  return (
    <Dialog
      title={heading}
      onClose={close}
      size="lg"
      className="dlg"
      footer={
        preview && model ? (
          <>
            <span className={`faint small dlg-start ${atLimit ? 'handoff-limit' : ''}`}>
              {atLimit ? t('secondOpinion.tabLimit', { max: MAX_OPEN_TABS }) : t('secondOpinion.tabOf', { n: open + 1, max: MAX_OPEN_TABS })}
            </span>
            <Button onClick={close} onKeyDown={startKey}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void start()} onKeyDown={startKey} disabled={busy || atLimit || !message.trim() || Boolean(preview.blocked)}>
              {t('common.start')} <Kbd>{mod}↵</Kbd>
            </Button>
          </>
        ) : undefined
      }
    >
      {!preview && !error && (
        <div className="faint small pad" role="status">
          {t('secondOpinion.reading')}
        </div>
      )}
      {error && (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      )}
      {preview && model && (
        <div className="dlg-stack" onKeyDown={startKey}>
          {preview.blocked && (
            <Callout tone="error" role="alert">
              {preview.blocked}
            </Callout>
          )}
          <div className="dlg-group">
            <span id="so-model-label" className="dlg-label">
              {t('secondOpinion.model')}
            </span>
            <Popover
              open={chooser}
              onOpenChange={setChooser}
              label={t('secondOpinion.model')}
              side="bottom"
              portal
              panelClassName="picker-panel"
              trigger={(popover) => (
                <ChipButton {...popover} aria-labelledby="so-model-label so-model-chip" className="picker-trigger">
                  <AgentIcon agent={model.agent} />
                  <span id="so-model-chip">{modelName(model)}</span>
                  {model.effort && modelInfo(model.agent, model.model).efforts.length > 0 && <span className="faint">{effortLabel(model.effort, t)}</span>}
                  {model.fast && <Zap size={12} className="fast-on" aria-hidden />}
                  <ChevronDown size={12} className="faint" aria-hidden />
                </ChipButton>
              )}
            >
              <ModelChooser
                inPopover
                value={model}
                onChoose={(choice) => setModel(choice)}
                onEffort={(effort) => setModel({ ...model, effort })}
                onFast={(fast) => setModel({ ...model, fast })}
                onClose={() => {
                  setChooser(false)
                  close()
                }}
                top={<LoadoutRows onPick={(loadout) => (setModel(loadout), setChooser(false))} />}
                footer={null}
              />
            </Popover>
            <small className="dlg-hint">
              {kind === 'continue'
                ? preview.followUp
                  ? t('secondOpinion.modelHint.followUp', { title: preview.followUp.title })
                  : t('secondOpinion.modelHint.continue')
                : t('secondOpinion.modelHint.review')}
            </small>
          </div>

          <div className="dlg-group" role="group" aria-labelledby="so-include-label">
            <span id="so-include-label" className="dlg-label">
              {t('secondOpinion.include')}
            </span>
            <div className="handoff-check">
              <Checkbox checked={useTask} disabled={preview.tasks.length === 0} onChange={(e) => setUseTask(e.target.checked)}>
                {t('secondOpinion.task')}
              </Checkbox>
              <Select
                className="handoff-task-select"
                label={t('secondOpinion.task')}
                value={taskTurnId ?? ''}
                disabled={!useTask}
                onChange={setTaskTurnId}
                options={preview.tasks.map((x) => ({ value: x.turnId, label: `“${x.label}”` }))}
              />
              {task && useTask && <span className="faint small">{t('secondOpinion.kb', { size: (task.bytes / 1024).toFixed(1) })}</span>}
            </div>
            <div className="handoff-check">
              <Checkbox checked={useAnswer} disabled={!preview.answer} onChange={(e) => setUseAnswer(e.target.checked)}>
                {t('secondOpinion.lastAnswer')}
                {!preview.answer && <span className="faint small"> {t('secondOpinion.noneYet')}</span>}
              </Checkbox>
              {preview.answer && <span className="faint small">{t('secondOpinion.kb', { size: (preview.answer.bytes / 1024).toFixed(1) })}</span>}
            </div>
            <div className="handoff-check">
              <Checkbox checked={useDiff} disabled={!preview.diff} onChange={(e) => setUseDiff(e.target.checked)}>
                {diffLabel}
              </Checkbox>
              {preview.diff && <span className="faint small">{t('secondOpinion.kb', { size: (preview.diff.bytes / 1024).toFixed(1) })}</span>}
            </div>
            {kind === 'review' && <small className="dlg-hint">{t('secondOpinion.reviewNote')}</small>}
          </div>

          {offersReadOnly && <AccessField agent={model.agent} checked={readOnly} onChange={setReadOnly} />}

          <Field label={t('secondOpinion.firstMessage')}>{(control) => <TextArea {...control} rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />}</Field>

          <Callout>
            <div>{t.rich('secondOpinion.sending', { size: <b>{sizeLine(sizes, model.agent, t)}</b> })}</div>
            <div>{t('secondOpinion.newChatNote')}</div>
            <div>
              {t('secondOpinion.permissions', { agent: AGENTS[model.agent].label })}{' '}
              <b>
                {offersReadOnly && readOnly && readOnlyEnforcement(model.agent)
                  ? t(readOnlyEnforcement(model.agent) === 'plan' ? 'readOnlyOpinion.permissions.plan' : 'readOnlyOpinion.permissions.sandbox')
                  : permissionNote(model.agent, snapshot.settings, t)}
              </b>
            </div>
          </Callout>
          {note && (
            <Callout role="status">{note}</Callout>
          )}
        </div>
      )}
    </Dialog>
  )
}
