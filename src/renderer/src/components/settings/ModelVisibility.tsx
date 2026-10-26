// O8: Settings → Agents → <agent> → Models. One eye per model to show or hide
// it in the model picker, its context window when known, and "Show all" as the
// only reset. Hidden models stay usable from loadouts and templates; tags say so.
import { Eye, EyeOff, Info, RefreshCw } from 'lucide-react'
import { useMemo } from 'react'
import { AGENTS, modelsFor, type AgentKind, type ModelInfo } from '../../../../shared/agents'
import {
  contextSize,
  hiddenCount,
  isModelHidden,
  knownContextWindow,
  modelUses,
  setModelHidden,
  showAllModels,
  type HiddenModels
} from '../../../../shared/modelVisibility'
import { useT } from '../../i18n'
import { api, attempt, timeAgo, useStore } from '../../store'
import { Button, IconButton, LinkButton, Tag } from '../../ui'
import { saveSettings } from './controls'

const NO_HIDDEN: HiddenModels = {}

export function ModelVisibility({ agent }: { agent: AgentKind }) {
  const t = useT()
  const hidden = useStore((s) => s.snapshot!.settings.hiddenModels) ?? NO_HIDDEN
  const loadouts = useStore((s) => s.snapshot!.settings.loadouts)
  const personal = useStore((s) => s.snapshot!.settings.promptTemplates)
  const repoTemplates = useStore((s) => s.snapshot!.repoTemplates)
  const entry = useStore((s) => s.snapshot!.catalog.agents[agent])
  // modelsFor reads the catalog the store keeps current; entry changes when it does.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const models = useMemo(() => modelsFor(agent), [agent, entry])
  const templates = useMemo(() => [...personal, ...Object.values(repoTemplates).flat()], [personal, repoTemplates])
  const count = hiddenCount(models, hidden)
  const label = AGENTS[agent].label

  const save = (next: HiddenModels) => void saveSettings({ hiddenModels: next })

  return (
    <section className="set-section" id={`setting-models-${agent}`}>
      <div className="mv-head">
        <h2>{t('models.visibility.title')}</h2>
        <span className="mv-count">
          {count ? t('models.visibility.count', { shown: models.length - count, hidden: count }) : t('models.visibility.allShown', { count: models.length })}
        </span>
        <span className="spacer" />
        {count > 0 && (
          <LinkButton size="sm" onClick={() => save(showAllModels(hidden, agent))}>
            {t('models.visibility.showAll')}
          </LinkButton>
        )}
      </div>
      <p className="set-section-desc">{t('models.visibility.desc')}</p>
      <div className="set-card">
        {models.length === 0 && (
          <div className="mv-foot">{entry?.loading ? t('models.visibility.loading', { agent: label }) : t('models.visibility.none')}</div>
        )}
        {models.map((m) => (
          <ModelRow
            key={m.id}
            model={m}
            hidden={isModelHidden(hidden, agent, m.id)}
            uses={modelUses(agent, m.id, loadouts, templates)}
            onToggle={(hide) => save(setModelHidden(hidden, agent, m.id, hide))}
          />
        ))}
        <div className="mv-foot">
          <span className="mv-source">
            {entry?.error
              ? t('models.visibility.error', { error: entry.error })
              : entry?.fetchedAt
                ? t('models.visibility.listedBy', { agent: label, when: timeAgo(entry.fetchedAt) })
                : t('models.visibility.builtIn', { agent: label })}
          </span>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} disabled={entry?.loading} onClick={() => void attempt(() => api.refreshModels(agent))}>
            {t('models.visibility.refresh')}
          </Button>
        </div>
      </div>
      <p className="mv-note">
        <Info size={13} />
        {t('models.visibility.note')}
      </p>
    </section>
  )
}

function ModelRow({ model, hidden, uses, onToggle }: { model: ModelInfo; hidden: boolean; uses: ReturnType<typeof modelUses>; onToggle: (hide: boolean) => void }) {
  const t = useT()
  const context = knownContextWindow(model)
  const action = hidden ? t('models.visibility.show', { name: model.label }) : t('models.visibility.hide', { name: model.label })
  return (
    <div className={`mv-row ${hidden ? 'hidden' : ''}`}>
      <IconButton label={action} pressed={!hidden} onClick={() => onToggle(!hidden)}>
        {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
      </IconButton>
      <span className="mv-name">{model.label}</span>
      {model.label !== model.id && <span className="mv-id mono">{model.id}</span>}
      {uses.loadouts.map((n) => (
        <Tag key={n} tone={hidden ? 'outline' : 'neutral'}>
          {t('models.visibility.loadout', { n })}
        </Tag>
      ))}
      {uses.template && <Tag tone={hidden ? 'outline' : 'neutral'}>{t('models.visibility.template')}</Tag>}
      <span className="spacer" />
      {context ? (
        <span className="mv-ctx">{t('models.visibility.context', { size: contextSize(context) })}</span>
      ) : (
        <span className="mv-ctx unknown">{t('models.visibility.contextUnknown')}</span>
      )}
    </div>
  )
}
