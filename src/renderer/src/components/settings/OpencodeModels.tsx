// OpenCode → Models: which of OpenCode's models appear in the model picker.
import { RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelInfo } from '../../../../shared/agents'
import { useT } from '../../i18n'
import { api, attempt, useStore } from '../../store'
import { opencodeModelParts } from '../composer/AgentPicker'
import { ActionRow, Button, Checkbox, Spinner } from '../../ui'
import { SearchField } from '../agents/catalogShared'
import { AgentDialog } from './AgentDialog'
import { saveSettings } from './controls'

interface Group {
  key: string
  label: string
  models: { id: string; name: string }[]
}

/** Models grouped by provider, in the order OpenCode lists them. */
function groupModels(models: Pick<ModelInfo, 'id' | 'label'>[]): Group[] {
  const groups = new Map<string, Group>()
  for (const model of models) {
    const { provider, providerLabel, name } = opencodeModelParts(model)
    const key = provider || providerLabel
    let group = groups.get(key)
    if (!group) {
      group = { key, label: providerLabel, models: [] }
      groups.set(key, group)
    }
    group.models.push({ id: model.id, name })
  }
  return [...groups.values()]
}

export function OpencodeModelsDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const entry = useStore((s) => s.snapshot!.catalog.agents.opencode)
  const saved = useStore((s) => s.snapshot!.settings.opencodeModels)
  const [selected, setSelected] = useState<string[]>(saved)
  const latest = useRef(saved)
  const [query, setQuery] = useState('')

  // Ask OpenCode for its list if it hasn't answered yet.
  useEffect(() => {
    if (!entry?.fetchedAt && !entry?.loading && !entry?.error) void api.refreshModels('opencode').catch(() => undefined)
    // Only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const models = useMemo(() => (entry?.models ?? []).filter((m) => !m.hidden), [entry])
  const groups = useMemo(() => {
    const listed = new Set(models.map((m) => m.id))
    const missing = selected.filter((id) => !listed.has(id))
    const all = groupModels(models)
    // Chosen models OpenCode no longer offers stay visible so they can be removed.
    if (missing.length) all.push({ key: '__missing', label: t('opencode.models.notOffered'), models: missing.map((id) => ({ id, name: id })) })
    return all
  }, [models, selected, t])

  const q = query.trim().toLowerCase()
  const filtered = q
    ? groups
        .map((g) => ({ ...g, models: g.models.filter((m) => g.label.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) }))
        .filter((g) => g.models.length > 0)
    : groups

  const toggle = (id: string) => {
    const current = latest.current
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
    latest.current = next
    setSelected(next)
    void saveSettings({ opencodeModels: next })
  }

  const retry = () => void attempt(() => api.refreshModels('opencode'))
  const loading = Boolean(entry?.loading)

  let body
  if (models.length === 0 && loading) {
    body = (
      <div className="ag-empty">
        <Spinner size={14} /> {t('loadout.loading')}
      </div>
    )
  } else if (models.length === 0 && entry?.error) {
    body = (
      <div className="ag-empty ag-empty-error">
        <div className="ag-empty-title">{t('opencode.models.loadFailed')}</div>
        <div>{t('opencode.models.loadFailedHint')}</div>
        <pre className="ag-error-text">{entry.error}</pre>
        <Button size="sm" icon={<RefreshCw size={12} />} onClick={retry}>
          {t('common.retry')}
        </Button>
      </div>
    )
  } else if (groups.length === 0) {
    body = <div className="ag-empty">{t('opencode.models.none')}</div>
  } else if (filtered.length === 0) {
    body = <div className="ag-empty">{t('opencode.models.noMatch')}</div>
  } else {
    body = filtered.map((group) => (
      <div key={group.key} className="ag-model-group">
        <div className="ag-model-group-label">{group.label}</div>
        {group.models.map((m) => (
          <ActionRow key={m.id} className="ag-model-row">
            <Checkbox checked={selected.includes(m.id)} onChange={() => toggle(m.id)}>
              <span className="ag-model-name">{m.name}</span>
              <span className="ag-model-id mono">{m.id}</span>
            </Checkbox>
          </ActionRow>
        ))}
      </div>
    ))
  }

  return (
    <AgentDialog
      title={t('opencode.models.title')}
      description={t('models.visibility.desc')}
      onClose={onClose}
      toolbar={<SearchField className="ag-search" autoFocus aria-label={t('opencode.models.filter')} placeholder={t('opencode.models.filter')} value={query} onChange={(e) => setQuery(e.target.value)} />}
      footer={
        <>
          <span className="ag-dialog-note">{t('opencode.models.selected', { count: selected.length })}</span>
          <Button size="sm" variant="ghost" icon={loading ? <Spinner size={12} /> : <RefreshCw size={12} />} disabled={loading} onClick={retry}>
            {t('common.refresh')}
          </Button>
          <Button size="sm" variant="primary" onClick={onClose}>
            {t('common.done')}
          </Button>
        </>
      }
    >
      {body}
    </AgentDialog>
  )
}
