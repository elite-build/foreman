// What a proposed flow changes, in words (src/shared/flowDiff.ts): one line per step, exit or loop it adds, changes or
// removes, each tagged with what happens to it, so the change is never colour or a symbol alone. The assistant's
// proposal card shows it; the flow studio's review lists it beside the graph.
import type { FlowChange, FlowChangeOp } from '../../../../shared/flowDiff'
import type { PlainKey } from '../../../../shared/i18n'
import { useT, type RendererT } from '../../i18n'
import { Tag, type TagTone } from '../../ui'

export const CHANGE_WORD: Record<FlowChangeOp, PlainKey> = {
  added: 'flowChange.op.added',
  changed: 'flowChange.op.changed',
  removed: 'flowChange.op.removed'
}

export const CHANGE_TONE: Record<FlowChangeOp, TagTone> = { added: 'ok', changed: 'warn', removed: 'error' }

const FLOW_FIELD: Record<Extract<FlowChange, { on: 'flow' }>['field'], PlainKey> = {
  name: 'flowChange.flow.name',
  description: 'flowChange.flow.description',
  start: 'flowChange.flow.start',
  inputs: 'flowChange.flow.inputs',
  after: 'flowChange.flow.after'
}

/** One change as a sentence: "New step security", "qa on clean → security (was done)". */
export function flowChangeText(change: FlowChange, t: RendererT): string {
  const list = (fields: string[] | undefined) => (fields ?? []).join(', ')
  switch (change.on) {
    case 'flow':
      return t(FLOW_FIELD[change.field])
    case 'step':
      return change.op === 'added' ? t('flowChange.step.added', { step: change.step }) : change.op === 'removed' ? t('flowChange.step.removed', { step: change.step }) : t('flowChange.step.changed', { step: change.step, fields: list(change.fields) })
    case 'loop':
      return change.op === 'added' ? t('flowChange.loop.added', { loop: change.loop }) : change.op === 'removed' ? t('flowChange.loop.removed', { loop: change.loop }) : t('flowChange.loop.changed', { loop: change.loop, fields: list(change.fields) })
    case 'edge': {
      const exit = change.fact ? t('flowChange.edge.on', { from: change.from, fact: change.fact }) : change.from
      if (change.op === 'changed') return t('flowChange.edge.changed', { exit, to: change.to, was: change.was ?? '' })
      return t(change.op === 'added' ? 'flowChange.edge.added' : 'flowChange.edge.removed', { exit, to: change.to })
    }
  }
}

/** The changes as a list, each line tagged added, changed or removed. */
export function FlowChangeList({ changes, label }: { changes: FlowChange[]; label: string }) {
  const t = useT()
  return (
    <ul className="flow-changes" aria-label={label}>
      {changes.map((change, i) => (
        <li key={i} className="flow-change">
          <Tag tone={CHANGE_TONE[change.op]}>{t(CHANGE_WORD[change.op])}</Tag>
          <span>{flowChangeText(change, t)}</span>
        </li>
      ))}
    </ul>
  )
}
