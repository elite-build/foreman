import { Eye, EyeOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Settings } from '../../../../shared/types'
import { announce } from '../../announce'
import { useT } from '../../i18n'
import { shortcutHint } from '../../shortcuts'
import { speech, useVoices } from '../../speech'
import { api, attempt, recordMilestone, showToast, useStore } from '../../store'
import { downloadSttModel, useSttModel } from '../../stt'
import { Button, Callout, Dialog, IconButton, Range, Segmented, Select, Spinner, Tag, TextInput } from '../../ui'
import { announcePolicy } from '../../agentStatus'
import { Page, resetSettings, Row, saveSettings, Section, TextRow, ToggleRow, useSettings } from './controls'

const DEFAULT_CONTENT_SIZE = 13
const DEFAULT_TERMINAL_SIZE = 12
const MIN_CONTENT_SIZE = 12
const MAX_CONTENT_SIZE = 24

/** Settings → Accessibility: low vision (text size, motion) and the terminal's screen reader support. */
export function AccessibilityPage() {
  const t = useT()
  const settings = useSettings()
  const followsContent = settings.terminalFontSize === 'content'
  // Get started: opening this page is how the checklist's "Make Foreman comfortable" ticks.
  useEffect(() => recordMilestone('comfortable'), [])

  return (
    <Page title={t('settings.page.accessibility')}>
      <Section title={t('settings.accessibility.section.vision')}>
        <ContentSizeRow />
        <ToggleRow
          id="terminal-font-content"
          label={t('settings.accessibility.terminalFollows.label')}
          help={t('settings.accessibility.terminalFollows.help')}
          checked={followsContent}
          onChange={(follow) => void saveSettings({ terminalFontSize: follow ? 'content' : DEFAULT_TERMINAL_SIZE })}
        />
        <Row
          id="reduce-motion"
          label={t('settings.accessibility.reduceMotion.label')}
          help={t('settings.accessibility.reduceMotion.help')}
          onReset={settings.reduceMotion === 'auto' ? undefined : () => void resetSettings(['reduceMotion'])}
        >
          {(control) => (
            <Segmented<Settings['reduceMotion']>
              {...control}
              label={t('settings.accessibility.reduceMotion.label')}
              value={settings.reduceMotion}
              options={[
                { value: 'auto', label: t('settings.accessibility.reduceMotion.auto') },
                { value: 'on', label: t('common.on') },
                { value: 'off', label: t('common.off') }
              ]}
              onChange={(reduceMotion) => void saveSettings({ reduceMotion })}
            />
          )}
        </Row>
      </Section>

      <Section title={t('settings.accessibility.section.screenReader')}>
        <ScreenReaderRow />
        <ScreenReaderDetected />
      </Section>

      <Section title={t('settings.accessibility.section.announcements')}>
        <Row
          id="announce"
          label={t('settings.accessibility.announce.label')}
          help={t('settings.accessibility.announce.help')}
          onReset={settings.announce === 'my-chat' ? undefined : () => void resetSettings(['announce'])}
        >
          {(control) => (
            <Segmented<Settings['announce']>
              {...control}
              label={t('settings.accessibility.announce.label')}
              value={announcePolicy(settings.announce)}
              options={[
                { value: 'needs-me', label: t('settings.accessibility.announce.needsMe') },
                { value: 'my-chat', label: t('settings.accessibility.announce.myChat') },
                { value: 'all', label: t('settings.accessibility.announce.all') }
              ]}
              onChange={(announce) => void saveSettings({ announce })}
            />
          )}
        </Row>
        <ToggleRow
          id="announce-summary"
          label={t('settings.accessibility.announceSummary.label')}
          help={t('settings.accessibility.announceSummary.help')}
          checked={settings.announceSummary}
          onChange={(announceSummary) => void saveSettings({ announceSummary })}
          onReset={settings.announceSummary ? undefined : () => void resetSettings(['announceSummary'])}
        />
        <ToggleRow
          id="earcons"
          label={t('settings.accessibility.earcons.label')}
          help={t('settings.accessibility.earcons.help')}
          checked={settings.earcons}
          onChange={(earcons) => void saveSettings({ earcons })}
          onReset={settings.earcons ? () => void resetSettings(['earcons']) : undefined}
        />
      </Section>

      <VoiceSection />

      <SpeechInputSection />
    </Page>
  )
}

const DEFAULT_RATE = 1
const DEFAULT_VOLUME = 1

/** A slider that moves locally and saves once it settles (or when the page closes first), rounded to one decimal. */
function useSettledNumber(saved: number, save: (value: number) => void): [number, (value: number) => void] {
  const [value, setValue] = useState(saved)
  const pending = useRef<number | null>(null)
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => setValue(saved), [saved])
  useEffect(() => {
    if (value === saved) return
    pending.current = value
    const timer = setTimeout(() => {
      pending.current = null
      saveRef.current(value)
    }, 300)
    return () => clearTimeout(timer)
    // Only a slider move schedules a save.
  }, [value])
  useEffect(
    () => () => {
      if (pending.current !== null) saveRef.current(pending.current)
    },
    []
  )
  return [value, (next) => setValue(Math.round(next * 10) / 10)]
}

/** Foreman's own voice (phase G1): off by default; when on, announcements are spoken here and not sent to the screen reader. */
function VoiceSection() {
  const t = useT()
  const settings = useSettings()
  const screenReader = useStore((s) => s.snapshot?.screenReader === true)
  const voices = useVoices()
  const on = settings.speechOutput === 'on'
  const [rate, setRate] = useSettledNumber(settings.speechRate ?? DEFAULT_RATE, (speechRate) => void saveSettings({ speechRate }))
  const [volume, setVolume] = useSettledNumber(settings.speechVolume ?? DEFAULT_VOLUME, (speechVolume) => void saveSettings({ speechVolume }))
  const voiceOptions = [
    { value: '', label: t('settings.accessibility.voice.auto') },
    ...voices.map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` }))
  ]
  const voiceLabel = t('settings.accessibility.voice.label')

  return (
    <Section title={t('settings.accessibility.section.voice')} description={t('settings.accessibility.voice.betaDescription')}>
      <ToggleRow
        id="speech-output"
        label={t('settings.accessibility.speech.label')}
        help={t('settings.accessibility.speech.help')}
        checked={on}
        onChange={(speechOutput) => {
          void saveSettings({ speechOutput: speechOutput ? 'on' : 'off' })
          // Said through the announcer, so with the voice now on it is the first thing Foreman's own voice says.
          if (speechOutput) announce(t('settings.accessibility.voice.betaNote'), 'speech:beta')
        }}
        onReset={on ? () => void resetSettings(['speechOutput']) : undefined}
        below={
          on ? (
            <>
              <Callout tone="info">{t('settings.accessibility.voice.betaNote')}</Callout>
              {screenReader && <Callout tone="info">{t('settings.accessibility.voice.screenReaderNote')}</Callout>}
            </>
          ) : undefined
        }
      />
      <Row
        id="speech-voice"
        label={voiceLabel}
        help={t('settings.accessibility.voice.help')}
        onReset={settings.speechVoice ? () => void resetSettings(['speechVoice']) : undefined}
      >
        {(control) => <Select<string> {...control} width={260} value={settings.speechVoice ?? ''} options={voiceOptions} onChange={(speechVoice) => void saveSettings({ speechVoice })} />}
      </Row>
      <Row
        id="speech-rate"
        label={t('settings.accessibility.rate.label')}
        help={t('settings.accessibility.rate.help')}
        onReset={rate === DEFAULT_RATE ? undefined : () => void resetSettings(['speechRate'])}
      >
        {(control) => (
          <div className="set-range-wrap">
            <Range
              {...control}
              className="set-range"
              aria-label={t('settings.accessibility.rate.label')}
              valueText={t('settings.accessibility.rate.value', { rate })}
              min={0.5}
              max={2}
              step={0.1}
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
            />
            <span className="set-range-value" aria-hidden>
              {t('settings.accessibility.rate.value', { rate })}
            </span>
          </div>
        )}
      </Row>
      <Row
        id="speech-volume"
        label={t('settings.accessibility.volume.label')}
        help={t('settings.accessibility.volume.help')}
        onReset={volume === DEFAULT_VOLUME ? undefined : () => void resetSettings(['speechVolume'])}
      >
        {(control) => (
          <div className="set-range-wrap">
            <Range
              {...control}
              className="set-range"
              aria-label={t('settings.accessibility.volume.label')}
              valueText={t('settings.accessibility.volume.value', { percent: Math.round(volume * 100) })}
              min={0}
              max={1}
              step={0.1}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
            />
            <span className="set-range-value" aria-hidden>
              {t('settings.accessibility.volume.value', { percent: Math.round(volume * 100) })}
            </span>
          </div>
        )}
      </Row>
      <Row label={t('settings.accessibility.voice.test')} help={t('settings.accessibility.voice.testHelp')}>
        {(control) => (
          <Button
            {...control}
            onClick={() => {
              speech.cancel()
              speech.speak(t('settings.accessibility.voice.testSentence'))
            }}
          >
            {t('settings.accessibility.voice.test')}
          </Button>
        )}
      </Row>
    </Section>
  )
}

// Speech input (phase G2). Defaults match the settings registry: hold to talk, the model on this computer, English.
const DEFAULT_PUSH_TO_TALK = 'hold'
const DEFAULT_STT_PROVIDER = 'local'
const DEFAULT_STT_LANGUAGE = 'en'
// What main accepts for a dictation language: en, de, pt-BR.
const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/
const OPENAI_KEY = 'OPENAI_API_KEY'

/** Push-to-talk dictation: how the key behaves, which engine hears, the language, the OpenAI key, the local model. */
function SpeechInputSection() {
  const t = useT()
  const settings = useSettings()
  const platform = useStore((s) => s.snapshot?.platform)
  const mode = settings.pushToTalk ?? DEFAULT_PUSH_TO_TALK
  const provider = settings.sttProvider ?? DEFAULT_STT_PROVIDER
  const language = settings.sttLanguage ?? DEFAULT_STT_LANGUAGE
  const keys = shortcutHint('stt.pushToTalk', platform) ?? ''

  return (
    <Section title={t('settings.accessibility.section.stt')}>
      <Row
        id="push-to-talk"
        label={t('settings.accessibility.pushToTalk.label')}
        help={t('settings.accessibility.pushToTalk.help', { keys })}
        onReset={mode === DEFAULT_PUSH_TO_TALK ? undefined : () => void resetSettings(['pushToTalk'])}
      >
        {(control) => (
          <Segmented<Settings['pushToTalk']>
            {...control}
            label={t('settings.accessibility.pushToTalk.label')}
            value={mode}
            options={[
              { value: 'hold', label: t('settings.accessibility.pushToTalk.hold') },
              { value: 'toggle', label: t('settings.accessibility.pushToTalk.toggle') }
            ]}
            onChange={(pushToTalk) => void saveSettings({ pushToTalk })}
          />
        )}
      </Row>
      <Row
        id="stt-provider"
        label={t('settings.accessibility.sttProvider.label')}
        help={t('settings.accessibility.sttProvider.help')}
        onReset={provider === DEFAULT_STT_PROVIDER ? undefined : () => void resetSettings(['sttProvider'])}
        below={provider === 'openai' && settings.privacyMode ? <Callout tone="warn">{t('settings.accessibility.sttProvider.privacy')}</Callout> : undefined}
      >
        {(control) => (
          <Segmented<Settings['sttProvider']>
            {...control}
            label={t('settings.accessibility.sttProvider.label')}
            value={provider}
            options={[
              { value: 'local', label: t('settings.accessibility.sttProvider.local') },
              { value: 'openai', label: t('settings.accessibility.sttProvider.openai') }
            ]}
            onChange={(sttProvider) => void saveSettings({ sttProvider })}
          />
        )}
      </Row>
      <TextRow
        id="stt-language"
        label={t('settings.accessibility.sttLanguage.label')}
        help={t('settings.accessibility.sttLanguage.help')}
        value={language}
        mono
        onReset={language === DEFAULT_STT_LANGUAGE ? undefined : () => void resetSettings(['sttLanguage'])}
        onCommit={(next) => {
          const code = next.trim()
          if (!LANGUAGE_CODE.test(code)) {
            showToast(t('settings.accessibility.sttLanguage.invalid'), 'error')
            return false
          }
          void saveSettings({ sttLanguage: code })
        }}
      />
      {provider === 'openai' ? <OpenAiKeyRow /> : <ModelRow />}
    </Section>
  )
}

/** The OpenAI key, saved the way OpenCode's provider keys are (api.setProviderKey); never shown again once saved. */
function OpenAiKeyRow() {
  const t = useT()
  const [source, setSource] = useState<'saved' | 'shell' | null>(null)
  const [value, setValue] = useState('')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)

  const load = useCallback(async () => {
    try {
      const provider = (await api.opencodeProviders())?.find((p) => p.envVar === OPENAI_KEY)
      setSource(provider?.saved ? 'saved' : provider?.detected ? 'shell' : null)
    } catch {
      setSource(null)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const run = async (kind: 'save' | 'remove', next: string | null) => {
    setBusy(kind)
    const done = await attempt(async () => (await api.setProviderKey(OPENAI_KEY, next), true))
    setBusy(null)
    if (!done) return
    setValue('')
    showToast(t(kind === 'save' ? 'agentSettings.key.saved' : 'agentSettings.key.removed'))
    await load()
  }
  const submit = () => {
    const key = value.trim()
    if (key && !busy) void run('save', key)
  }
  const status = source === 'saved' ? t('settings.accessibility.sttKey.saved') : source === 'shell' ? t('settings.accessibility.sttKey.shell') : t('settings.accessibility.sttKey.none')

  return (
    <Row
      id="stt-openai-key"
      label={t('settings.accessibility.sttKey.label')}
      help={t('settings.accessibility.sttKey.help', { envVar: OPENAI_KEY })}
      stacked
      detail={<Tag tone={source === 'saved' ? 'ok' : 'neutral'}>{status}</Tag>}
    >
      {(control) => (
        <form
          className="ag-key-form"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="ag-secret">
            <TextInput
              {...control}
              type={visible ? 'text' : 'password'}
              mono
              placeholder={OPENAI_KEY}
              autoComplete="new-password"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <IconButton label={visible ? t('opencode.key.hide') : t('opencode.key.reveal')} onClick={() => setVisible(!visible)}>
              {visible ? <EyeOff size={13} /> : <Eye size={13} />}
            </IconButton>
          </div>
          <Button size="sm" variant="primary" icon={busy === 'save' ? <Spinner size={12} /> : undefined} disabled={!value.trim() || busy !== null} onClick={submit}>
            {t('common.save')}
          </Button>
          {source === 'saved' && (
            <Button size="sm" icon={busy === 'remove' ? <Spinner size={12} /> : undefined} disabled={busy !== null} onClick={() => void run('remove', null)}>
              {t('common.remove')}
            </Button>
          )}
        </form>
      )}
    </Row>
  )
}

const megabytes = (bytes: number) => Math.round(bytes / 1_000_000)

/** The model that runs on this computer: its name and size, whether it is there, and a download behind a consent dialog. */
function ModelRow() {
  const t = useT()
  const model = useSttModel()
  const [asking, setAsking] = useState(false)
  const stateText = !model
    ? t('settings.accessibility.sttModel.unknown')
    : model.state === 'ready'
      ? t('settings.accessibility.sttModel.ready')
      : model.state === 'downloading'
        ? t('settings.accessibility.sttModel.downloading')
        : t('settings.accessibility.sttModel.missing')
  const progress =
    model?.state === 'downloading' && model.total
      ? t('settings.accessibility.sttModel.progress', { done: megabytes(model.bytes ?? 0), total: megabytes(model.total), percent: Math.min(100, Math.round(((model.bytes ?? 0) / model.total) * 100)) })
      : null

  return (
    <>
      <Row
        id="stt-model"
        label={t('settings.accessibility.sttModel.label')}
        help={model ? t('settings.accessibility.sttModel.help', { name: model.name, size: model.sizeMb }) : undefined}
      >
        <Tag tone={model?.state === 'ready' ? 'ok' : model?.state === 'downloading' ? 'info' : 'neutral'}>{stateText}</Tag>
        {model?.state === 'downloading' && <Spinner size={12} />}
        {progress && <span className="set-help">{progress}</span>}
        {model?.state === 'missing' && <Button onClick={() => setAsking(true)}>{t('settings.accessibility.sttModel.download')}</Button>}
      </Row>
      {asking && model && (
        <Dialog
          title={t('settings.accessibility.sttModel.dialog.title')}
          onClose={() => setAsking(false)}
          closeLabel={t('common.close')}
          footer={
            <>
              <Button onClick={() => setAsking(false)}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setAsking(false)
                  void downloadSttModel()
                }}
              >
                {t('settings.accessibility.sttModel.download')}
              </Button>
            </>
          }
        >
          <p>{t('settings.accessibility.sttModel.dialog.body', { name: model.name, size: model.sizeMb, source: model.source })}</p>
        </Dialog>
      )}
    </>
  )
}

/** The slider moves locally and saves when it settles (or when the page closes first). */
function ContentSizeRow() {
  const t = useT()
  const settings = useSettings()
  const [size, setSize] = useState(settings.contentFontSize)
  const pending = useRef<number | null>(null)
  useEffect(() => setSize(settings.contentFontSize), [settings.contentFontSize])
  useEffect(() => {
    if (size === settings.contentFontSize) return
    pending.current = size
    const timer = setTimeout(() => {
      pending.current = null
      void saveSettings({ contentFontSize: size })
    }, 300)
    return () => clearTimeout(timer)
    // Only a slider move schedules a save.
  }, [size])
  useEffect(
    () => () => {
      if (pending.current !== null) void saveSettings({ contentFontSize: pending.current })
    },
    []
  )

  return (
    <Row
      id="content-font-size"
      label={t('settings.accessibility.contentSize.label')}
      help={t('settings.accessibility.contentSize.help')}
      onReset={settings.contentFontSize === DEFAULT_CONTENT_SIZE ? undefined : () => void resetSettings(['contentFontSize'])}
    >
      {(control) => (
        <div className="set-range-wrap">
          <Range
            {...control}
            className="set-range"
            aria-label={t('settings.accessibility.contentSize.label')}
            valueText={t('settings.accessibility.contentSize.value', { size })}
            min={MIN_CONTENT_SIZE}
            max={MAX_CONTENT_SIZE}
            step={1}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
          />
          <span className="set-range-value" aria-hidden>
            {t('settings.accessibility.contentSize.value', { size })}
          </span>
        </div>
      )}
    </Row>
  )
}

/** What Automatic will do: whether Electron currently reports an assistive technology attached to the window. */
function ScreenReaderDetected() {
  const t = useT()
  const detected = useStore((s) => s.snapshot?.screenReader === true)
  return (
    <p className="small faint" role="status">
      {detected ? t('settings.accessibility.screenReader.detected') : t('settings.accessibility.screenReader.notDetected')}
    </p>
  )
}

/** xterm's screen reader mode: Automatic follows the OS (Electron reports it in the snapshot). */
function ScreenReaderRow() {
  const t = useT()
  const settings = useSettings()
  return (
    <Row
      id="terminal-screen-reader"
      label={t('settings.advanced.screenReader.label')}
      help={t('settings.advanced.screenReader.help')}
      onReset={settings.terminalScreenReader === 'auto' ? undefined : () => void resetSettings(['terminalScreenReader'])}
    >
      {(control) => (
        <Select<Settings['terminalScreenReader']>
          {...control}
          width={150}
          value={settings.terminalScreenReader}
          options={[
            { value: 'auto', label: t('settings.advanced.screenReader.auto') },
            { value: 'on', label: t('common.on') },
            { value: 'off', label: t('common.off') }
          ]}
          onChange={(terminalScreenReader) => void saveSettings({ terminalScreenReader })}
        />
      )}
    </Row>
  )
}
