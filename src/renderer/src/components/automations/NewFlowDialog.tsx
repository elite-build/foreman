// New flow (docs/loops-and-graphs.md, "Building one without writing a file"): asks what the flow is called and what it
// starts from before the flow studio opens: Blank (one step on the run's task), Describe it (the assistant drafts it),
// or a copy of a flow already listed. The draft opens under that name; nothing is saved until Save there.
import { useState } from 'react'
import { setFlowText } from '../../../../shared/flowRename'
import { BLANK_FLOW } from '../../../../shared/flowStarters'
import type { FlowListing } from '../../../../shared/flows'
import { useT } from '../../i18n'
import { openFlowDraft, useStore } from '../../store'
import { Button, Callout, Dialog, Field, RadioCards, Select, TextInput } from '../../ui'
import { flowTitle } from './FlowStartFields'

type Start = 'blank' | 'describe' | 'copy'

export function NewFlowDialog({ flows, onClose }: { flows: FlowListing[]; onClose: () => void }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  // Only a flow that reads can be copied from here; one with problems is fixed on its own page.
  const copyable = flows.filter((f) => f.problems.length === 0)
  const [name, setName] = useState('')
  const [start, setStart] = useState<Start>('blank')
  const [from, setFrom] = useState(copyable[0]?.id ?? '')
  const trimmed = name.trim()
  const taken = trimmed !== '' && flows.some((f) => [flowTitle(f, t), f.name].some((n) => n.toLowerCase() === trimmed.toLowerCase()))
  const where = (f: FlowListing) => (f.source === 'built-in' ? t('automations.flows.builtIn') : f.source === 'personal' ? t('automations.flows.personal') : t('automations.flows.fromRepo', { repo: repos.find((r) => r.id === f.repoId)?.name ?? '' }))
  const original = copyable.find((f) => f.id === from)

  const create = () => {
    if (!trimmed || (start === 'copy' && !original)) return
    const base = start === 'copy' && original ? original.toml : BLANK_FLOW
    openFlowDraft({
      toml: setFlowText(base, 'name', trimmed),
      ...(start === 'describe' ? { describe: true } : {}),
      ...(start === 'copy' && original ? { notes: [t('flowStudio.copyNote', { name: flowTitle(original, t) })] } : {})
    })
    onClose()
  }

  return (
    <Dialog
      title={t('automations.flows.new')}
      onClose={onClose}
      footer={
        <>
          <span className="faint small new-flow-note">{t('automations.flows.newNote')}</span>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!trimmed || (start === 'copy' && !original)} onClick={create}>
            {t('automations.flows.create')}
          </Button>
        </>
      }
    >
      <div className="new-flow-form">
        <Field label={t('automations.flows.newName')}>
          {(c) => (
            <TextInput
              {...c}
              autoFocus
              value={name}
              placeholder={t('flowStudio.untitled')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                create()
              }}
            />
          )}
        </Field>
        {taken && (
          <Callout tone="warn" role="status">
            {t('automations.flows.newNameTaken')}
          </Callout>
        )}
        <RadioCards<Start>
          legend={t('automations.flows.startFrom')}
          value={start}
          onChange={setStart}
          columns={3}
          options={[
            { value: 'blank', label: t('automations.flows.blank'), description: t('automations.flows.blankBody') },
            { value: 'describe', label: t('automations.flows.describe'), description: t('automations.flows.describeBody') },
            { value: 'copy', label: t('automations.flows.copyFlow'), description: t('automations.flows.copyFlowBody'), disabled: copyable.length === 0 }
          ]}
        />
        {start === 'copy' && original && (
          <Field label={t('automations.flows.copyWhich')}>
            {(c) => <Select {...c} value={from} onChange={setFrom} options={copyable.map((f) => ({ value: f.id, label: `${flowTitle(f, t)} · ${where(f)}` }))} />}
          </Field>
        )}
      </div>
    </Dialog>
  )
}
