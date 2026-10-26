import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { TFunction } from '../../../../shared/i18n'
import type { ColorVision, PaneSide, Settings, TerminalPlacement, ThemeSetting, WindowLayout } from '../../../../shared/types'
import { useT } from '../../i18n'
import { resetPanelSizes } from '../resize'
import { useStore } from '../../store'
import { Button, Range, Select, TextInput, type SelectOption } from '../../ui'
import { Page, resetSettings, Row, saveSettings, Section, ToggleRow, useDraft, useSettings } from './controls'
import { HomeSection } from './HomeSection'

const DEFAULTS = {
  theme: 'system',
  zoom: 1,
  coloredSidebarDiffs: false,
  colorVision: 'default',
  monoFont: 'Geist Mono',
  codeLigatures: true,
  terminalFont: '',
  terminalFontSize: 12,
  windowLayout: 'panes',
  sidebarSide: 'left',
  sidePanelSide: 'right',
  terminalPlacement: 'panel-bottom'
} satisfies Partial<Settings>

const windowLayouts = (t: TFunction): SelectOption<WindowLayout>[] => [
  { value: 'panes', label: t('settings.appearance.windowLayout.panes') },
  { value: 'tiles', label: t('settings.appearance.windowLayout.tiles') }
]

const sides = (t: TFunction): SelectOption<PaneSide>[] => [
  { value: 'left', label: t('settings.appearance.side.left') },
  { value: 'right', label: t('settings.appearance.side.right') }
]

const terminalPlacements = (t: TFunction): SelectOption<TerminalPlacement>[] => [
  { value: 'panel-bottom', label: t('settings.appearance.terminalPanel.panelBottom') },
  { value: 'panel-top', label: t('settings.appearance.terminalPanel.panelTop') },
  { value: 'below-chat', label: t('settings.appearance.terminalPanel.belowChat') }
]

// 50% to 200% in 10% steps, stored as a factor.
const ZOOM_OPTIONS: SelectOption<string>[] = Array.from({ length: 16 }, (_, i) => {
  const percent = 50 + i * 10
  return { value: (percent / 100).toFixed(1), label: `${percent}%` }
})

const MONO_FONTS = ['Geist Mono', 'SF Mono', 'Menlo', 'JetBrains Mono', 'Fira Code']
const CUSTOM = 'custom'
// What the terminal uses when no font is set.
const TERMINAL_STACK = '"Geist Mono Variable", ui-monospace, Menlo, Consolas, monospace'

/** CSS font-family for a mono font name (Geist Mono ships with the app as a variable font). */
function monoStack(font: string): string {
  const name = font.trim() || DEFAULTS.monoFont
  return name === 'Geist Mono' ? '"Geist Mono Variable", "Geist Mono", monospace' : `"${name}", monospace`
}

export function AppearancePage() {
  const t = useT()
  const settings = useSettings()
  const mac = useStore((s) => s.snapshot!.platform) === 'darwin'
  const reset = (key: keyof typeof DEFAULTS) => (settings[key] === DEFAULTS[key] ? undefined : () => void resetSettings([key]))

  return (
    <Page title={t('settings.appearance.title')}>
      <Section title={t('settings.appearance.section.interface')}>
        <Row id="theme" label={t('settings.appearance.theme')} help={t('settings.appearance.theme.help')} detail={t('settings.appearance.theme.toggle', { keys: mac ? '⌘⌥T' : 'Ctrl+Alt+T' })} onReset={reset('theme')}>
          <Select<ThemeSetting>
            label={t('settings.appearance.theme')}
            width={140}
            value={settings.theme}
            options={[
              { value: 'light', label: t('settings.appearance.theme.light') },
              { value: 'dark', label: t('settings.appearance.theme.dark') },
              { value: 'system', label: t('settings.appearance.theme.system') }
            ]}
            onChange={(theme) => void saveSettings({ theme })}
          />
        </Row>
        <Row id="zoom" label={t('settings.appearance.zoom')} help={t('settings.appearance.zoom.help')} onReset={reset('zoom')}>
          <Select
            label={t('settings.appearance.zoom')}
            width={140}
            value={settings.zoom.toFixed(1)}
            options={ZOOM_OPTIONS}
            onChange={(value) => void saveSettings({ zoom: Number(value) })}
          />
        </Row>
        <ToggleRow
          id="colored-sidebar-diffs"
          label={t('settings.appearance.coloredDiffs')}
          help={t('settings.appearance.coloredDiffs.help')}
          checked={settings.coloredSidebarDiffs}
          onChange={(coloredSidebarDiffs) => void saveSettings({ coloredSidebarDiffs })}
          onReset={reset('coloredSidebarDiffs')}
        />
        <Row id="color-vision" label={t('settings.appearance.colorVision')} help={t('settings.appearance.colorVision.help')} onReset={reset('colorVision')}>
          <Select<ColorVision>
            label={t('settings.appearance.colorVision')}
            width={220}
            value={settings.colorVision}
            options={[
              { value: 'default', label: t('common.default') },
              { value: 'protanopia-deuteranopia', label: t('settings.appearance.colorVision.protanopia') },
              { value: 'tritanopia', label: t('settings.appearance.colorVision.tritanopia') }
            ]}
            onChange={(colorVision) => void saveSettings({ colorVision })}
          />
        </Row>
      </Section>

      {/* #21 */}
      <HomeSection />

      <Section title={t('settings.appearance.section.layout')}>
        <Row id="window-layout" label={t('settings.appearance.windowLayout')} help={t('settings.appearance.windowLayout.help')} onReset={reset('windowLayout')}>
          <Select<WindowLayout> label={t('settings.appearance.windowLayout')} width={180} value={settings.windowLayout} options={windowLayouts(t)} onChange={(windowLayout) => void saveSettings({ windowLayout })} />
        </Row>
        <Row id="sidebar-side" label={t('settings.appearance.sidebar')} help={t('settings.appearance.sidebar.help')} detail={t('settings.appearance.showHide', { keys: mac ? '⌘B' : 'Ctrl+B' })} onReset={reset('sidebarSide')}>
          <Select<PaneSide> label={t('settings.appearance.sidebar')} width={140} value={settings.sidebarSide} options={sides(t)} onChange={(sidebarSide) => void saveSettings({ sidebarSide })} />
        </Row>
        <Row id="side-panel-side" label={t('settings.appearance.sidePanel')} help={t('settings.appearance.sidePanel.help')} detail={t('settings.appearance.showHide', { keys: mac ? '⌘⌥B' : 'Ctrl+Alt+B' })} onReset={reset('sidePanelSide')}>
          <Select<PaneSide> label={t('settings.appearance.sidePanel')} width={140} value={settings.sidePanelSide} options={sides(t)} onChange={(sidePanelSide) => void saveSettings({ sidePanelSide })} />
        </Row>
        <Row id="terminal-placement" label={t('settings.appearance.terminalPanel')} help={t('settings.appearance.terminalPanel.help')} detail={t('settings.appearance.showHide', { keys: mac ? '⌘⌥J' : 'Ctrl+Alt+J' })} onReset={reset('terminalPlacement')}>
          <Select<TerminalPlacement>
            label={t('settings.appearance.terminalPanel')}
            width={220}
            value={settings.terminalPlacement}
            options={terminalPlacements(t)}
            onChange={(terminalPlacement) => void saveSettings({ terminalPlacement })}
          />
        </Row>
        <Row id="pane-sizes" label={t('settings.appearance.paneSizes')} help={t('settings.appearance.paneSizes.help')}>
          <Button size="sm" onClick={resetPanelSizes}>
            {t('settings.appearance.paneSizes.reset')}
          </Button>
        </Row>
        <div className="set-pad set-preview-row">
          <LayoutPreview sidebar={settings.sidebarSide} panel={settings.sidePanelSide} terminal={settings.terminalPlacement} />
        </div>
      </Section>

      <Section title={t('settings.appearance.section.code')}>
        <MonoFontRow onReset={reset('monoFont')} />
        <ToggleRow
          id="code-ligatures"
          label={t('settings.appearance.ligatures')}
          help={t('settings.appearance.ligatures.help')}
          checked={settings.codeLigatures}
          onChange={(codeLigatures) => void saveSettings({ codeLigatures })}
          onReset={reset('codeLigatures')}
        />
        <div className="set-pad set-preview-row">
          <CodePreview font={settings.monoFont} ligatures={settings.codeLigatures} />
        </div>
      </Section>

      <Section title={t('settings.appearance.section.terminal')}>
        <TerminalFontRow
          onReset={
            settings.terminalFont === DEFAULTS.terminalFont && settings.terminalFontSize === DEFAULTS.terminalFontSize
              ? undefined
              : () => void resetSettings(['terminalFont', 'terminalFontSize'])
          }
        />
      </Section>
    </Page>
  )
}

/** A small map of the window in the chosen layout. */
function LayoutPreview({ sidebar, panel, terminal }: { sidebar: PaneSide; panel: PaneSide; terminal: TerminalPlacement }) {
  const t = useT()
  const term = <div className="lp-pane lp-term">{t('settings.appearance.preview.terminal')}</div>
  const sidePanel = (
    <div className="lp-col">
      {terminal === 'panel-top' && term}
      <div className="lp-pane lp-fill">{t('settings.appearance.preview.changes')}</div>
      {terminal === 'panel-bottom' && term}
    </div>
  )
  const chat = (
    <div className="lp-col">
      <div className="lp-pane lp-fill lp-chat">{t('settings.appearance.preview.chat')}</div>
      {terminal === 'below-chat' && term}
    </div>
  )
  const order = ['sidebar', panel === 'left' ? 'panel' : 'chat', panel === 'left' ? 'chat' : 'panel']
  if (sidebar === 'right') order.push(order.shift()!)
  const columns: Record<string, ReactNode> = { sidebar: <div className="lp-pane lp-sidebar">{t('settings.appearance.preview.workspaces')}</div>, panel: sidePanel, chat }
  return (
    <div className="layout-preview" aria-label={t('settings.appearance.preview.layout')} role="img">
      {order.map((key) => (
        <div key={key} className={`lp-slot ${key === 'chat' ? 'lp-grow' : ''}`}>
          {columns[key]}
        </div>
      ))}
    </div>
  )
}

/** A short TypeScript sample in the code colours, mono font and ligature setting. */
function CodePreview({ font, ligatures }: { font: string; ligatures: boolean }) {
  const t = useT()
  const style: CSSProperties = { fontFamily: monoStack(font), fontVariantLigatures: ligatures ? 'normal' : 'none' }
  return (
    <pre className="set-code-preview" style={style} aria-label={t('settings.appearance.preview.code')}>
      <span className="c">{'// Load a user, using the cache when possible'}</span>
      {'\n'}
      <span className="k">export async function</span> <span className="f">getUser</span>(id: <span className="t">string</span>):{' '}
      <span className="t">Promise</span>&lt;<span className="t">User</span> | <span className="k">null</span>&gt; {'{'}
      {'\n  '}
      <span className="k">const</span> cached = cache.<span className="f">get</span>(id)
      {'\n  '}
      <span className="k">if</span> (cached !== <span className="k">undefined</span>) <span className="k">return</span> cached
      {'\n  '}
      <span className="k">const</span> res = <span className="k">await</span> <span className="f">fetch</span>(<span className="s">{'`/api/users/${id}`'}</span>, {'{'} retries:{' '}
      <span className="n">3</span> {'}'})
      {'\n  '}
      <span className="k">return</span> res.ok ? res.<span className="f">json</span>() : <span className="k">null</span>
      {'\n}'}
    </pre>
  )
}

function MonoFontRow({ onReset }: { onReset?: () => void }) {
  const t = useT()
  const settings = useSettings()
  const isPreset = MONO_FONTS.includes(settings.monoFont)
  // Custom stays open while the user types a name, even before it's saved.
  const [customOpen, setCustomOpen] = useState(!isPreset)
  const custom = customOpen || !isPreset
  const inputId = useId()
  const draft = useDraft(isPreset ? '' : settings.monoFont, (value) => {
    const font = value.trim()
    if (!font) return false
    if (MONO_FONTS.includes(font)) setCustomOpen(false)
    void saveSettings({ monoFont: font })
  })

  const options: SelectOption<string>[] = [...MONO_FONTS.map((font) => ({ value: font, label: font })), { value: CUSTOM, label: t('settings.appearance.monoFont.custom') }]

  return (
    <Row id="mono-font" label={t('settings.appearance.monoFont')} help={t('settings.appearance.monoFont.help')} onReset={onReset}>
      <div className="set-font-picker">
        <Select
          label={t('settings.appearance.monoFont')}
          width={180}
          value={custom ? CUSTOM : settings.monoFont}
          options={options}
          onChange={(value) => {
            if (value === CUSTOM) {
              setCustomOpen(true)
              // Focus the name field once it renders.
              requestAnimationFrame(() => document.getElementById(inputId)?.focus())
              return
            }
            setCustomOpen(false)
            void saveSettings({ monoFont: value })
          }}
        />
        {custom && (
          <>
            <TextInput
              id={inputId}
              width={220}
              aria-label={t('settings.appearance.monoFont.customLabel')}
              placeholder={t('settings.appearance.monoFont.placeholder')}
              spellCheck={false}
              autoComplete="off"
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              {...draft}
            />
            <span className="set-help">{t('settings.appearance.monoFont.exact')}</span>
          </>
        )}
      </div>
    </Row>
  )
}

function TerminalFontRow({ onReset }: { onReset?: () => void }) {
  const t = useT()
  const settings = useSettings()
  const draft = useDraft(settings.terminalFont,(value) => void saveSettings({ terminalFont: value.trim() }))
  // The slider moves locally and saves when it settles (or when the page closes first).
  // 'content' (Settings → Accessibility) hands the size to the content text size: the slider rests at the default until it is turned off.
  const followsContent = settings.terminalFontSize === 'content'
  const ownSize = typeof settings.terminalFontSize === 'number' ? settings.terminalFontSize : DEFAULTS.terminalFontSize
  const [size, setSize] = useState(ownSize)
  const pending = useRef<number | null>(null)
  useEffect(() => setSize(ownSize), [ownSize])
  useEffect(() => {
    if (followsContent || size === ownSize) return
    pending.current = size
    const timer = setTimeout(() => {
      pending.current = null
      void saveSettings({ terminalFontSize: size })
    }, 300)
    return () => clearTimeout(timer)
    // Only a slider move schedules a save.
  }, [size, followsContent])
  useEffect(
    () => () => {
      if (pending.current !== null) void saveSettings({ terminalFontSize: pending.current })
    },
    []
  )

  const family = draft.value.trim() ? `"${draft.value.trim()}", ${TERMINAL_STACK}` : TERMINAL_STACK

  return (
    <Row id="terminal-font" label={t('settings.appearance.terminalFont')} help={t('settings.appearance.terminalFont.help')} stacked onReset={onReset}>
      {(control) => (
        <div className="set-terminal-font">
          <div className="set-terminal-controls">
            <TextInput
              {...control}
              className="set-terminal-input"
              placeholder={t('settings.appearance.terminalFont.placeholder')}
              spellCheck={false}
              autoComplete="off"
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              {...draft}
            />
            <label className="set-range-wrap">
              <Range
                className="set-range"
                aria-label={t('settings.appearance.terminalFont.size')}
                valueText={`${size}px`}
                min={10}
                max={20}
                step={1}
                value={size}
                disabled={followsContent}
                onChange={(e) => setSize(Number(e.target.value))}
              />
              <span className="set-range-value">{size}px</span>
            </label>
          </div>
          <span className="set-help">{t('settings.appearance.terminalFont.exact')}</span>
          <pre className="set-term-preview" style={{ fontFamily: family, fontSize: size }} aria-label={t('settings.appearance.preview.terminalFont')}>
            <span className="path">~/project</span> <span className="branch">main</span> <span className="faint">±3 ?2</span>
            {'\n'}
            <span className="prompt">❯</span> npm test <span className="ok">✓</span>
            {'\n'}
            {'└── '}
            <span className="ok">▶ All tests passed</span>
          </pre>
        </div>
      )}
    </Row>
  )
}
