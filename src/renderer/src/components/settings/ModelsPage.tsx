import { ChevronDown, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { HAND_OFF_BUDGET } from '../../../../shared/chatHandOff'
import { effortLabel, modelInfo, type Loadout } from '../../../../shared/agents'
import { useT } from '../../i18n'
import { showToast, useStore } from '../../store'
import { AgentIcon, ModelChooser, modelName } from '../composer/AgentPicker'
import { ChipButton, Popover, Range, Select } from '../../ui'
import { ExternalLink } from './AgentAuth'
import { Page, resetSettings, Row, saveSettings, Section, ToggleRow, useSettings } from './controls'
import { LoadoutEditor } from './ModelsLoadout'
import './agents.css'

const FALLBACK_STYLES = ['default', 'Proactive', 'Concise', 'Explanatory', 'Learning']

export function ModelsPage() {
  const t = useT()
  const settings = useSettings()
  const platform = useStore((s) => s.snapshot!.platform)
  const outputStyles = useStore((s) => s.snapshot!.catalog.outputStyles)
  const keys = platform === 'darwin' ? '⌘⌃1–5' : 'Ctrl+Shift+1–5'

  const styles = outputStyles.length ? outputStyles : FALLBACK_STYLES
  // Keep a saved style selectable even if Claude Code no longer lists it.
  const styleOptions = (styles.includes(settings.claudeOutputStyle) ? styles : [settings.claudeOutputStyle, ...styles]).map((style) => ({
    value: style,
    label: style === 'default' ? t('common.default') : style
  }))

  const setOutputStyle = async (claudeOutputStyle: string) => {
    if (await saveSettings({ claudeOutputStyle })) showToast(t('modelsPage.outputStyle.updated'))
  }

  return (
    <Page title={t('settings.page.models')}>
      <div className="ml-bare">
        <Row
          id="loadout"
          label={t('settings.row.loadout')}
          help={t('modelsPage.loadout.help', { keys })}
          onReset={() => void resetSettings(['loadouts'])}
          stacked
        >
          <LoadoutEditor />
        </Row>
      </div>

      <Section>
        <Row
          id="claude-output-style"
          label={t('settings.row.claudeOutputStyle')}
          help={
            <>
              {t.rich('modelsPage.outputStyle.help', { link: <ExternalLink key="link" href="https://code.claude.com/docs/en/output-styles">{t('modelsPage.outputStyle.link')}</ExternalLink> })}
            </>
          }
          onReset={settings.claudeOutputStyle !== 'default' ? () => void setOutputStyle('default') : undefined}
        >
          <Select label={t('settings.row.claudeOutputStyle')} width={180} value={settings.claudeOutputStyle} options={styleOptions} onChange={(style) => void setOutputStyle(style)} />
        </Row>
        <Row
          id="review-model"
          label={t('settings.row.reviewModel')}
          help={t('modelsPage.reviewModel.help')}
          onReset={() => void resetSettings(['reviewModel'])}
        >
          <CompactChooser label={t('settings.row.reviewModel')} value={settings.reviewModel} onChange={(reviewModel) => void saveSettings({ reviewModel })} />
        </Row>
        <ToggleRow
          id="default-plan-mode"
          label={t('settings.row.defaultPlanMode')}
          help={t('modelsPage.defaultPlanMode.help')}
          checked={settings.defaultPlanMode}
          onChange={(defaultPlanMode) => void saveSettings({ defaultPlanMode })}
        />
      </Section>
      <Section title={t('modelsPage.switching.section')}>
        <SwitchHistoryRow />
      </Section>
    </Page>
  )
}

/** How much of a chat the next agent is given on a switch (docs/agents.md 5.2): the slider moves locally and saves when it settles. */
function SwitchHistoryRow() {
  const t = useT()
  const settings = useSettings()
  const saved = settings.handOffTokenBudget ?? HAND_OFF_BUDGET.default
  const [value, setValue] = useState(saved)
  const pending = useRef<number | null>(null)
  useEffect(() => setValue(saved), [saved])
  useEffect(() => {
    if (value === saved) return
    pending.current = value
    const timer = setTimeout(() => {
      pending.current = null
      void saveSettings({ handOffTokenBudget: value })
    }, 300)
    return () => clearTimeout(timer)
    // Only a slider move schedules a save.
  }, [value])
  useEffect(
    () => () => {
      if (pending.current !== null) void saveSettings({ handOffTokenBudget: pending.current })
    },
    []
  )
  const words = t('modelsPage.switching.value', { count: value.toLocaleString(t.locale) })
  return (
    <Row
      id="switch-history-tokens"
      label={t('settings.row.switchHistory')}
      help={t('settings.row.switchHistory.desc')}
      onReset={saved === HAND_OFF_BUDGET.default ? undefined : () => void resetSettings(['handOffTokenBudget'])}
    >
      {(control) => (
        <div className="set-range-stack">
          <div className="set-range-wrap">
            <Range
              {...control}
              className="set-range set-range--wide"
              aria-label={t('settings.row.switchHistory')}
              valueText={words}
              min={HAND_OFF_BUDGET.min}
              max={HAND_OFF_BUDGET.max}
              step={64}
              value={value}
              onChange={(e) => setValue(Number(e.target.value))}
            />
            <span className="set-range-value set-range-value--wide" aria-hidden>
              {words}
            </span>
          </div>
          <div className="set-range-scale faint small" aria-hidden>
            <span>{HAND_OFF_BUDGET.min.toLocaleString(t.locale)}</span>
            <span>{HAND_OFF_BUDGET.max.toLocaleString(t.locale)}</span>
          </div>
        </div>
      )}
    </Row>
  )
}

/** A small trigger showing the model, opening the model chooser below it. */
function CompactChooser({ label, value, onChange }: { label: string; value: Loadout; onChange: (next: Loadout) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  // Opens upwards when there isn't room below.
  const [above, setAbove] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const onOpenChange = (next: boolean) => {
    const rect = ref.current?.getBoundingClientRect()
    if (next && rect) {
      const below = window.innerHeight - rect.bottom
      setAbove(below < 440 && rect.top > below)
    }
    setOpen(next)
  }

  const info = modelInfo(value.agent, value.model, t)
  const name = modelName(info)
  const effort = info.efforts.length > 0 ? effortLabel(value.effort ?? info.defaultEffort, t) : ''

  return (
    <div className="ml-compact" ref={ref}>
      <Popover
        open={open}
        onOpenChange={onOpenChange}
        side={above ? 'top' : 'bottom'}
        align="end"
        label={label}
        trigger={(pop) => (
          <ChipButton {...pop} className="ml-compact-trigger" aria-label={t('modelsPage.chooser.label', { label, model: name })}>
            <AgentIcon agent={value.agent} />
            <span className="ml-compact-name">{name}</span>
            {effort && <span className="faint">{effort}</span>}
            {value.fast && <Zap size={12} className="fast-on" aria-hidden />}
            <ChevronDown size={12} className="faint" aria-hidden />
          </ChipButton>
        )}
      >
        <ModelChooser
          inPopover
          label={label}
          value={value}
          onChoose={(choice) => {
            setOpen(false)
            onChange(choice)
          }}
          onEffort={(effort) => onChange({ ...value, effort })}
          onFast={(fast) => onChange({ ...value, fast })}
          onClose={() => setOpen(false)}
        />
      </Popover>
    </div>
  )
}
