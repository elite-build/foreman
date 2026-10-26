// A personal template's fields: name, prompt, and the optional start model and follow-up.
import { Trash2 } from 'lucide-react'
import { useEffect, useRef, type ChangeEvent } from 'react'
import { effortLabel, modelInfo } from '../../../../shared/agents'
import type { Loadout, PromptTemplate, TemplateFollowUp, TemplateStartModel } from '../../../../shared/types'
import { useT, type RendererT } from '../../i18n'
import { Checkbox, IconButton, Select, TextArea, TextInput } from '../../ui'
import { useDraft, useSettings } from '../settings/controls'
import { FieldModeToggle, RichField, useFieldMode } from '../MarkdownField'

export function TemplateEditor({
  template,
  autoFocus,
  onChange,
  onRemove
}: {
  template: PromptTemplate
  autoFocus: boolean
  onChange: (patch: Partial<PromptTemplate>) => void
  onRemove: () => void
}) {
  const t = useT()
  const nameRef = useRef<HTMLInputElement>(null)
  const name = useDraft(template.name, (next) => {
    if (!next.trim()) return false
    onChange({ name: next.trim() })
  })
  const body = useDraft(template.body, (next) => onChange({ body: next }))
  // G4 O15: the prompt can be edited Rich too (the choice is shared with the workspace note).
  const [fieldMode, setFieldMode] = useFieldMode()

  useEffect(() => {
    if (autoFocus) nameRef.current?.select()
  }, [autoFocus])

  return (
    <div className="set-card tpl-card">
      <div className="tpl-head">
        <TextInput
          ref={nameRef}
          className="tpl-name"
          aria-label={t('automations.editor.name')}
          spellCheck={false}
          autoComplete="off"
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          {...name}
        />
        <IconButton label={t('automations.editor.delete', { name: template.name })} onClick={onRemove}>
          <Trash2 size={13} />
        </IconButton>
      </div>
      <div className="field-mode-row">
        <FieldModeToggle value={fieldMode} onChange={setFieldMode} />
      </div>
      {fieldMode === 'rich' ? (
        <RichField
          value={body.value}
          saved={template.body}
          label={t('automations.editor.prompt', { name: template.name })}
          onChange={(next) => body.onChange({ target: { value: next } } as ChangeEvent<HTMLTextAreaElement>)}
          onFocus={body.onFocus}
          onBlur={(e) => {
            // Moving between blocks of the same field isn't leaving it.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) body.onBlur()
          }}
        />
      ) : (
        <TextArea
          className="tpl-body"
          aria-label={t('automations.editor.prompt', { name: template.name })}
          rows={4}
          placeholder={t('automations.editor.promptPlaceholder', { example: '{{placeholder}}' })}
          {...body}
        />
      )}
      <StartModelEditor template={template} onChange={onChange} />
      <FollowUpEditor template={template} onChange={onChange} />
    </div>
  )
}

const loadoutName = (l: Loadout, t: RendererT) => `${modelInfo(l.agent, l.model).label}${l.effort ? ` · ${effortLabel(l.effort, t)}` : ''}`

/** Optional model for a chat this template starts (foreman run, New workspace, a new tab). Inserting into an existing chat never changes its model. */
function StartModelEditor({ template, onChange }: { template: PromptTemplate; onChange: (patch: Partial<PromptTemplate>) => void }) {
  const t = useT()
  const loadouts = useSettings().loadouts
  const start = template.startModel
  const asStart = (l: Loadout): TemplateStartModel => ({ agent: l.agent, model: l.model, ...(l.effort ? { effort: l.effort } : {}) })
  const current = start ? loadouts.findIndex((l) => l.agent === start.agent && l.model === start.model && l.effort === start.effort) : -1
  return (
    <div className="tpl-followup">
      <Checkbox checked={Boolean(start)} disabled={!start && !loadouts.length} onChange={(e) => onChange({ startModel: e.target.checked ? asStart(loadouts[0]) : undefined })}>
        {t('automations.editor.startModel')}
      </Checkbox>
      {start && (
        <>
          <div className="tpl-followup-row">
            <Select
              label={t('automations.editor.startModelLabel')}
              value={String(current)}
              options={[...(current === -1 ? [{ value: '-1', label: loadoutName({ ...start, fast: false }, t) }] : []), ...loadouts.map((l, n) => ({ value: String(n), label: loadoutName(l, t) }))]}
              onChange={(next) => loadouts[Number(next)] && onChange({ startModel: asStart(loadouts[Number(next)]) })}
            />
          </div>
          <p className="faint small">
            {t.rich('automations.editor.startModelHelp', { command: <code key="command">foreman run</code> })}
          </p>
        </>
      )}
    </div>
  )
}

/** Optional "Continue to …" offered on the answer to a message written from this template. It never runs by itself. */
function FollowUpEditor({ template, onChange }: { template: PromptTemplate; onChange: (patch: Partial<PromptTemplate>) => void }) {
  const t = useT()
  const follow = template.followUp
  const set = (patch: Partial<TemplateFollowUp>) => onChange({ followUp: { title: '', prompt: '', ...follow, ...patch } })
  return (
    <div className="tpl-followup">
      <Checkbox checked={Boolean(follow)} onChange={(e) => onChange({ followUp: e.target.checked ? { title: '', prompt: '' } : undefined })}>
        {t('automations.editor.followUp')}
      </Checkbox>
      {follow && <FollowUpFields follow={follow} onChange={set} />}
    </div>
  )
}

function FollowUpFields({ follow, onChange }: { follow: TemplateFollowUp; onChange: (patch: Partial<TemplateFollowUp>) => void }) {
  const t = useT()
  const loadouts = useSettings().loadouts
  const title = useDraft(follow.title, (next) => onChange({ title: next.trim() }))
  const prompt = useDraft(follow.prompt, (next) => onChange({ prompt: next }))
  const current = follow.model ? loadouts.findIndex((l) => l.agent === follow.model!.agent && l.model === follow.model!.model && l.effort === follow.model!.effort && l.fast === follow.model!.fast) : -1
  return (
    <>
      <div className="tpl-followup-row">
        <TextInput aria-label={t('automations.editor.followUpName')} placeholder={t('automations.editor.followUpNamePlaceholder')} spellCheck={false} autoComplete="off" {...title} />
        <Select
          label={t('automations.editor.followUpModel')}
          value={follow.model ? String(current) : ''}
          options={[
            { value: '', label: t('automations.editor.followUpSameModel') },
            ...(follow.model && current === -1 ? [{ value: '-1', label: loadoutName(follow.model, t) }] : []),
            ...loadouts.map((l, n) => ({ value: String(n), label: loadoutName(l, t) }))
          ]}
          onChange={(next) => onChange({ model: next === '' ? undefined : loadouts[Number(next)] })}
        />
      </div>
      <TextArea className="tpl-body" aria-label={t('automations.editor.followUpPrompt')} rows={3} placeholder={t('automations.editor.followUpPromptPlaceholder')} {...prompt} />
      <p className="faint small">
        {t('automations.editor.followUpHelp', { title: follow.title || '…' })}
      </p>
    </>
  )
}
