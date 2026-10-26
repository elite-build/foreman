import { Copy, ImageDown, TriangleAlert } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useT } from '../i18n'
import { showToast } from '../store'
import { onAppearanceChange } from '../theme'
import { cachedRender, readThemeTokens, renderMermaid, svgElement, type RenderResult } from './mermaidRender'
import {
  checkMermaidSource,
  MERMAID_MAX_CHARS,
  MERMAID_RENDER_TIMEOUT_MS,
  MERMAID_VIEW_KEY,
  mermaidErrorDetail,
  parseMermaidView,
  standaloneSvg,
  themeKey,
  type MermaidView
} from './mermaidSource'
import { IconButton, Segmented } from '../ui'

type View = MermaidView

// G4 #18: the last Diagram / Code choice is remembered for every block that opens after it.
function loadView(): View {
  try {
    return parseMermaidView(localStorage.getItem(MERMAID_VIEW_KEY))
  } catch {
    return 'diagram'
  }
}

function saveView(view: View): void {
  try {
    localStorage.setItem(MERMAID_VIEW_KEY, JSON.stringify(view))
  } catch {
    // Not remembered; the block still switches.
  }
}

/** G4 #18: the diagram as SVG markup (as text, plus as an SVG image where the clipboard takes one). */
async function copySvg(svg: string): Promise<void> {
  const el = svgElement(svg)
  if (!el) throw new Error('no svg')
  const text = standaloneSvg(new XMLSerializer().serializeToString(el))
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'image/svg+xml': new Blob([text], { type: 'image/svg+xml' }) })])
  } catch {
    await navigator.clipboard.writeText(text)
  }
}

/** The theme tokens while `enabled`, re-read when light/dark or the colour-vision mode changes. */
function useDiagramTheme(enabled: boolean): ReturnType<typeof readThemeTokens> | null {
  const [theme, setTheme] = useState(() => (enabled ? readThemeTokens() : null))
  useEffect(() => {
    if (!enabled) return
    const read = () => {
      const next = readThemeTokens()
      setTheme((prev) => (prev && themeKey(prev.tokens, prev.dark) === themeKey(next.tokens, next.dark) ? prev : next))
    }
    read()
    return onAppearanceChange(read)
  }, [enabled])
  return enabled ? theme : null
}

/**
 * A ```mermaid block (#18): the diagram, or the source one click away. It renders once,
 * after the fence closes (`complete`), never per streamed token; until then, and if
 * rendering fails, it shows the code (`children`, the highlighted <pre>).
 */
export function MermaidBlock({ source, complete, children }: { source: string; complete: boolean; children: ReactNode }) {
  const t = useT()
  const [choice, setChoice] = useState<View>(loadView)
  const choose = (view: View) => {
    setChoice(view)
    saveView(view)
  }
  const theme = useDiagramTheme(complete)
  const key = theme ? themeKey(theme.tokens, theme.dark) : ''
  const check = checkMermaidSource(source)
  // Seeded from the cache, so a remounted chat shows its diagrams without a "Rendering" flash.
  const [rendered, setRendered] = useState<{ source: string; key: string; result: RenderResult } | null>(() => {
    const hit = key ? cachedRender(source, key) : undefined
    return hit ? { source, key, result: hit } : null
  })

  useEffect(() => {
    if (!complete || !theme || !check.ok) return
    const hit = cachedRender(source, key)
    if (hit) return setRendered({ source, key, result: hit })
    let live = true
    void renderMermaid(source, theme.tokens, theme.dark).then((result) => live && setRendered({ source, key, result }))
    return () => {
      live = false
    }
    // `theme` changes exactly when `key` does.
  }, [complete, source, key, check.ok])

  // A theme change keeps the old picture up until the new one is ready.
  const result = rendered?.source === source ? rendered.result : undefined
  const failure: string | null = !complete
    ? null
    : !check.ok
      ? check.reason === 'empty'
        ? t('mermaid.empty')
        : t('mermaid.tooBig', { chars: check.chars.toLocaleString(t.locale), max: MERMAID_MAX_CHARS.toLocaleString(t.locale) })
      : result && !result.ok
        ? result.kind === 'timeout'
          ? t('mermaid.timeout', { seconds: MERMAID_RENDER_TIMEOUT_MS / 1000 })
          : result.kind === 'load'
            ? t('mermaid.loadFailed')
            : mermaidErrorDetail(result.error)
        : null
  const canShowDiagram = complete && failure === null
  const view: View = canShowDiagram ? choice : 'code'
  const svg = result?.ok ? result.svg : null

  const copy = () =>
    navigator.clipboard.writeText(source).then(
      () => showToast(t('mermaid.copied')),
      () => showToast(t('mermaid.copyFailed'), 'error')
    )

  return (
    <div className="mmd">
      <div className="snippet-toolbar" data-search-ignore>
        <span className="faint small">Mermaid</span>
        {!complete && <span className="small mmd-wait">· {t('mermaid.waiting')}</span>}
        <span className="spacer" />
        <Segmented<View>
          plain
          small
          label={t('mermaid.show')}
          value={view}
          onChange={choose}
          options={[
            {
              value: 'diagram',
              label: t('mermaid.diagram'),
              title: !complete ? t('mermaid.waiting') : failure !== null ? t('mermaid.failedShort') : t('mermaid.showDiagram'),
              disabled: !canShowDiagram
            },
            { value: 'code', label: t('mermaid.code'), title: t('mermaid.showCode') }
          ]}
        />
        <IconButton
          label={svg ? t('mermaid.copySvg') : t('mermaid.copySvgUnavailable')}
          disabled={!svg}
          onClick={() => svg && void copySvg(svg).then(() => showToast(t('mermaid.svgCopied')), () => showToast(t('mermaid.copySvgFailed'), 'error'))}
        >
          <ImageDown size={13} />
        </IconButton>
        <IconButton label={t('mermaid.copy')} onClick={() => void copy()}>
          <Copy size={13} />
        </IconButton>
      </div>
      {failure !== null && (
        <div className="mmd-fail" role="status" data-search-ignore>
          <span className="mmd-fail-title">
            <TriangleAlert size={13} /> {t('mermaid.failed')}
          </span>
          <pre className="mmd-fail-detail">{failure}</pre>
        </div>
      )}
      {view === 'diagram' ? svg ? <DiagramView svg={svg} label={t('mermaid.diagramLabel')} /> : <div className="mmd-view mmd-pending">{t('mermaid.rendering')}</div> : children}
    </div>
  )
}

/** The sanitised SVG, put in as DOM nodes (never as an HTML string). */
function DiagramView({ svg, label }: { svg: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = svgElement(svg)
    ref.current?.replaceChildren(...(el ? [el] : []))
  }, [svg])
  return <div ref={ref} className="mmd-view" role="img" aria-label={label} />
}
