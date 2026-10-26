// O19: Repository → Scripts & checks → Setup as named steps in order, each with a
// command and an optional timeout, and the "Retry failed step" switch. Saves to
// this computer's layer like every repo setting; a repo's settings.toml can set
// the same steps as [[scripts.setup.steps]]. G3: the archive script uses the same
// editor ([[scripts.archive.steps]]), and consecutive steps can run in parallel.
import { GripVertical, MoreHorizontal, Plus, Timer } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { cleanSteps, sameSteps, stepGroups, stepsPatch, type StepsKind } from '../../../../shared/setupSteps'
import type { SetupStep } from '../../../../shared/types'
import { useT, type RendererT } from '../../i18n'
import { useStore } from '../../store'
import { Button, Card, MenuButton, MenuCheckboxItem, MenuItem, MenuSeparator, Select, TextArea, TextInput } from '../../ui'
import { Row, saveRepoSettings, ToggleRow, useRepoSetting } from './controls'
import '../setupSteps.css'

interface DraftStep extends SetupStep {
  key: number
}

let nextKey = 1
const withKeys = (steps: SetupStep[]): DraftStep[] => steps.map((s) => ({ ...s, key: nextKey++ }))
const strip = (steps: DraftStep[]): SetupStep[] => steps.map(({ key: _key, ...s }) => s)

// Offered timeouts, in seconds; 0 is no limit. A value from settings.toml that isn't here is added.
const TIMEOUTS = [0, 60, 120, 300, 600, 900, 1800, 3600]

function timeoutLabel(seconds: number, t: RendererT): string {
  if (!seconds) return t('setupSteps.noLimit')
  return seconds % 60 === 0 ? t('setupSteps.minutes', { count: seconds / 60 }) : t('setupSteps.seconds', { count: seconds })
}

/** Move the item at `from` to `to` (an index in the list without it). */
function moved<T>(list: T[], from: number, to: number): T[] {
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item)
  return next
}

export function SetupStepsRow({ repoId, kind = 'setup' }: { repoId: string; kind?: StepsKind }) {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  const s = useRepoSetting(repoId, kind === 'archive' ? 'archiveSteps' : 'setupSteps')
  const archive = kind === 'archive'
  const resetPatch = archive ? { archiveScript: null, archiveSteps: null } : { setupScript: null, setupSteps: null }
  const [draft, setDraft] = useState<DraftStep[]>(() => withKeys(s.value))
  const [focusKey, setFocusKey] = useState<number | null>(null)
  // Drag to reorder: armed from the grip, so dragging in an input still selects text.
  const [armed, setArmed] = useState<number | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [drop, setDrop] = useState<{ key: number; after: boolean } | null>(null)

  // Follow changes from elsewhere (settings.toml, Reset) unless they are what the draft already says.
  const valueKey = JSON.stringify(s.value)
  useEffect(() => {
    setDraft((current) => (sameSteps(cleanSteps(strip(current)), s.value) ? current : withKeys(s.value)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey])

  const commit = (next: DraftStep[] = draft) => {
    // A step with a command but no name gets one, so the list shows what is saved.
    const named = next.map((step, i) => (step.command.trim() && !step.name.trim() ? { ...step, name: `Step ${i + 1}` } : step))
    if (named.some((step, i) => step !== next[i])) setDraft(named)
    const clean = cleanSteps(strip(named))
    if (sameSteps(clean, s.value)) return
    // Emptying a list nothing else sets just removes this computer's copy.
    void saveRepoSettings(repoId, !clean.length && s.inherited === 'default' ? resetPatch : stepsPatch(clean, kind))
  }

  // Edits still in an input when the page closes are saved.
  const latest = useRef(commit)
  latest.current = commit
  useEffect(() => () => latest.current(), [])

  const update = (key: number, patch: Partial<SetupStep>) => setDraft((list) => list.map((step) => (step.key === key ? { ...step, ...patch } : step)))
  const change = (next: DraftStep[]) => {
    setDraft(next)
    commit(next)
  }
  const move = (key: number, by: number) => {
    const at = draft.findIndex((step) => step.key === key)
    if (at + by < 0 || at + by >= draft.length) return
    change(moved(draft, at, at + by))
  }
  const remove = (key: number) => change(draft.filter((step) => step.key !== key))
  // G3: consecutive steps marked parallel run at the same time.
  const toggleParallel = (key: number) => change(draft.map((step) => (step.key === key ? { ...step, parallel: !step.parallel || undefined } : step)))
  const groups = stepGroups(draft)
  const groupOf = (i: number) => groups.find((g) => g.includes(i)) ?? [i]
  const add = () => {
    const step: DraftStep = { name: '', command: '', key: nextKey++ }
    setDraft([...draft, step])
    setFocusKey(step.key)
  }

  const onKeyDown = (e: KeyboardEvent, key: number) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    move(key, e.key === 'ArrowUp' ? -1 : 1)
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>, key: number) => {
    if (dragging === null || dragging === key) return
    e.preventDefault()
    const box = e.currentTarget.getBoundingClientRect()
    const after = e.clientY > box.top + box.height / 2
    if (drop?.key !== key || drop.after !== after) setDrop({ key, after })
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    if (dragging !== null && drop) {
      const from = draft.findIndex((step) => step.key === dragging)
      const without = draft.filter((step) => step.key !== dragging)
      const target = without.findIndex((step) => step.key === drop.key) + (drop.after ? 1 : 0)
      if (from >= 0 && target >= 0) change(moved(draft, from, target))
    }
    endDrag()
  }
  const endDrag = () => {
    setDragging(null)
    setArmed(null)
    setDrop(null)
  }

  const up = platform === 'darwin' ? '⌥↑' : 'Alt+↑'
  const down = platform === 'darwin' ? '⌥↓' : 'Alt+↓'
  return (
    <Row
      id={archive ? 'archive-script' : 'setup-script'}
      label={t(archive ? 'archiveSteps.label' : 'setupSteps.label')}
      help={t(archive ? 'archiveSteps.help' : 'setupSteps.help')}
      stacked
      source={s.sourceInfo}
      onReset={s.source === 'local' ? () => void saveRepoSettings(repoId, resetPatch) : undefined}
      detail={s.source === 'shared' ? t(archive ? 'archiveSteps.sharedNote' : 'setupSteps.sharedNote') : undefined}
    >
      <div className="steps-edit">
        {draft.length === 0 && <p className="repo-empty">{t(archive ? 'archiveSteps.empty' : 'setupSteps.empty')}</p>}
        {draft.map((step, i) => {
          const options = TIMEOUTS.includes(step.timeoutSec ?? 0) ? TIMEOUTS : [...TIMEOUTS, step.timeoutSec!].sort((a, b) => a - b)
          const dropAt = drop?.key === step.key ? (drop.after ? 'after' : 'before') : undefined
          const group = groupOf(i)
          const grouped = group.length > 1 ? `parallel ${group[0] === i ? 'group-start' : ''} ${group.at(-1) === i ? 'group-end' : ''}` : ''
          return (
            <Card
              key={step.key}
              interactive
              size="sm"
              className={`step-card ${grouped}`}
              lifted={dragging === step.key}
              drop={dropAt}
              stripe={group.length > 1 ? 'info' : undefined}
              draggable={armed === step.key}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                setDragging(step.key)
              }}
              onDragOver={(e) => onDragOver(e, step.key)}
              onDrop={onDrop}
              onDragEnd={endDrag}
              onKeyDown={(e) => onKeyDown(e, step.key)}
            >
              <span className="step-grip" title={t('setupSteps.drag')} onMouseDown={() => setArmed(step.key)} onMouseUp={() => setArmed(null)}>
                <GripVertical size={14} />
              </span>
              <span className="step-num" title={group.length > 1 ? t('setupSteps.parallelGroup', { count: group.length }) : undefined}>
                {i + 1}
              </span>
              <TextInput
                compact
                aria-label={t('setupSteps.stepName')}
                placeholder={t('setupSteps.namePlaceholder')}
                spellCheck={false}
                autoComplete="off"
                autoFocus={focusKey === step.key}
                value={step.name}
                onChange={(e) => update(step.key, { name: e.target.value })}
                onBlur={() => commit()}
              />
              {/* A text area, so a multi-line setup script (the old single script often is) keeps its lines. */}
              <TextArea
                className="step-command"
                mono
                aria-label={t('setupSteps.command')}
                placeholder={t('setupSteps.commandPlaceholder')}
                spellCheck={false}
                autoComplete="off"
                rows={Math.min(12, step.command.split('\n').length)}
                value={step.command}
                onChange={(e) => update(step.key, { command: e.target.value })}
                onBlur={() => commit()}
              />
              <span className="step-timeout">
                <Timer size={12} aria-hidden />
                <Select
                  label={t('setupSteps.timeout')}
                  width={94}
                  value={String(step.timeoutSec ?? 0)}
                  options={options.map((seconds) => ({ value: String(seconds), label: timeoutLabel(seconds, t) }))}
                  onChange={(value) => {
                    const seconds = Number(value)
                    change(draft.map((d) => (d.key === step.key ? { ...d, timeoutSec: seconds || undefined } : d)))
                  }}
                />
              </span>
              <StepMenu
                first={i === 0}
                last={i === draft.length - 1}
                onMove={(by) => move(step.key, by)}
                onRemove={() => remove(step.key)}
                parallel={Boolean(step.parallel)}
                onParallel={() => toggleParallel(step.key)}
              />
            </Card>
          )
        })}
        <div className="steps-foot">
          <Button size="sm" icon={<Plus size={13} />} onClick={add}>
            {t('setupSteps.add')}
          </Button>
          {draft.length > 1 && <span className="faint">{t('setupSteps.reorderHint', { up, down })}</span>}
          {groups.some((g) => g.length > 1) && <span className="faint">{t('setupSteps.parallelHint')}</span>}
        </div>
      </div>
    </Row>
  )
}

function StepMenu({
  first,
  last,
  onMove,
  onRemove,
  parallel,
  onParallel
}: {
  first: boolean
  last: boolean
  onMove: (by: number) => void
  onRemove: () => void
  parallel: boolean
  onParallel: () => void
}) {
  const t = useT()
  return (
    <MenuButton label={t('setupSteps.actions')} look="icon" trigger={<MoreHorizontal size={14} />} placement="bottom-end">
      <MenuItem disabled={first} onSelect={() => onMove(-1)}>
        {t('setupSteps.moveUp')}
      </MenuItem>
      <MenuItem disabled={last} onSelect={() => onMove(1)}>
        {t('setupSteps.moveDown')}
      </MenuItem>
      <MenuSeparator />
      <MenuCheckboxItem checked={parallel} title={t('setupSteps.parallelTitle')} onCheckedChange={onParallel}>
        {t('setupSteps.parallel')}
      </MenuCheckboxItem>
      <MenuSeparator />
      <MenuItem variant="danger" onSelect={onRemove}>
        {t('setupSteps.remove')}
      </MenuItem>
    </MenuButton>
  )
}

/** "Retry a failed step once automatically": off unless switched on. */
export function SetupRetryRow({ repoId }: { repoId: string }) {
  const t = useT()
  const s = useRepoSetting(repoId, 'setupRetryOnce')
  return (
    <ToggleRow
      id="setup-retry"
      label={t('setupSteps.retry.label')}
      help={t('setupSteps.retry.help')}
      checked={s.value}
      onChange={(next) => void s.set(next)}
      source={s.sourceInfo}
      onReset={s.source === 'local' ? () => void s.reset() : undefined}
    />
  )
}
