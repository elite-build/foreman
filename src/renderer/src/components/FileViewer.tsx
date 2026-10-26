import { Code2, Eye, Globe, Image as ImageIcon, Pencil, RotateCw, Save, ShieldCheck } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { formatImageBytes, imageFormatName, imageMetaLabel, MAX_IMAGE_PREVIEW_BYTES, previewFormat, type ImagePreview } from '../../../shared/imageInfo'
import { framePreview, type FramePreview } from '../../../shared/preview'
import type { FileContent } from '../../../shared/types'
import { useT } from '../i18n'
import { api, attempt, modKey, useStore } from '../store'
import { Button, Callout, Segmented, Status, TextArea } from '../ui'
import { Markdown } from './Markdown'
import { OpenInViewerButton } from './OpenIn'
import { isRichMarkdownPath, loadMarkdownMode, RichMarkdown, saveMarkdownMode, type MarkdownEditorMode } from './RichMarkdown'
import './files.css'

export function FileViewer({ workspaceId, workspacePath, path, line }: { workspaceId: string; workspacePath: string; path: string; line?: number }) {
  const platform = useStore((s) => s.snapshot!.platform)
  const t = useT()
  const [file, setFile] = useState<FileContent | null>(null)
  const [image, setImage] = useState<ImagePreview | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState(false)
  // SVGs open as a picture; Source shows their text.
  const [source, setSource] = useState(false)
  // G3 · #19: an HTML file shows as a page in a sandboxed frame when asked; a PDF always does. Reload bumps the key.
  const [framed, setFramed] = useState(false)
  const [frameKey, setFrameKey] = useState(0)
  const [error, setError] = useState('')
  // O15: Rich or Source when editing a .md file; remembered across files and restarts.
  const [mdMode, setMdMode] = useState<MarkdownEditorMode>(loadMarkdownMode)
  const target = useRef<HTMLDivElement>(null)
  const mod = modKey(platform)
  const dirty = editing && file !== null && draft !== file.content
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(path)
  // #19: PNG, JPEG, GIF, WebP and ICO show only as a picture; an SVG is also text.
  const format = previewFormat(path)
  const frame = framePreview(path)
  const hasText = (!format || format === 'svg') && frame !== 'pdf'
  const rich = editing && isRichMarkdownPath(path) && mdMode === 'rich'
  const pickMode = (mode: MarkdownEditorMode) => {
    setMdMode(mode)
    saveMarkdownMode(mode)
  }

  const loadImage = async () => {
    try {
      setImage(await api.readImage(workspaceId, path))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const load = async () => {
    if (format) void loadImage()
    if (!hasText) return
    try {
      const content = await api.readFile(workspaceId, path)
      setFile(content)
      setDraft(content.content)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    setEditing(false)
    setPreview(false)
    setSource(false)
    setFramed(false)
    setFile(null)
    setImage(null)
    setError('')
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, path])

  useLayoutEffect(() => {
    target.current?.scrollIntoView({ block: 'center' })
  }, [file, line])

  const save = async () => {
    if (!dirty) return
    const ok = await attempt(async () => (await api.writeFile(workspaceId, path, draft), true))
    if (ok) {
      setFile({ content: draft, binary: false, tooLarge: false })
      if (format) void loadImage()
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const modDown = platform === 'darwin' ? e.metaKey : e.ctrlKey
      if (!modDown || e.shiftKey || e.altKey) return
      if (e.code === 'KeyE' && file && !file.binary && !file.tooLarge) {
        e.preventDefault()
        setEditing((v) => !v)
        setPreview(false)
      } else if (e.code === 'KeyS' && editing) {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const showImage = Boolean(format) && !editing && !source
  const showFrame = frame === 'pdf' || (frame === 'html' && framed && !editing)
  const lines = (file?.content ?? '').split('\n')
  return (
    <div className="file-viewer">
      <div className="file-diff-head">
        <span className="mono">{path}</span>
        {showImage && image && <span className="preview-meta">{imageMetaLabel(image, t)}</span>}
        {dirty && <Status tone="warn" compact title={t('files.viewer.unsaved')} label={t('files.viewer.unsaved')} />}
        <span className="spacer" />
        {isMarkdown && !editing && (
          <Button size="sm" variant="ghost" icon={preview ? <Code2 size={12} /> : <Eye size={12} />} onClick={() => setPreview(!preview)}>
            {preview ? t('files.preview.source') : t('files.frame.page')}
          </Button>
        )}
        {frame === 'html' && !editing && (
          <Button size="sm" variant="ghost" icon={framed ? <Code2 size={12} /> : <Globe size={12} />} title={framed ? undefined : t('files.frame.pageTitle')} onClick={() => setFramed(!framed)}>
            {framed ? t('files.preview.source') : t('files.frame.page')}
          </Button>
        )}
        {showFrame && (
          <Button size="sm" variant="ghost" icon={<RotateCw size={12} />} title={t('files.frame.reloadTitle')} onClick={() => setFrameKey((k) => k + 1)}>
            {t('files.frame.reload')}
          </Button>
        )}
        {format === 'svg' && !editing && (
          <Button size="sm" variant="ghost" icon={source ? <ImageIcon size={12} /> : <Code2 size={12} />} onClick={() => setSource(!source)}>
            {source ? t('files.preview.image') : t('files.preview.source')}
          </Button>
        )}
        {editing && isRichMarkdownPath(path) && (
          <Segmented
            small
            label={t('files.md.mode')}
            value={mdMode}
            onChange={pickMode}
            options={[
              { value: 'rich', label: t('files.md.rich'), title: t('files.md.richTitle') },
              { value: 'source', label: t('files.md.source'), title: t('files.md.sourceTitle') }
            ]}
          />
        )}
        {file && !file.binary && !file.tooLarge && (
          <Button size="sm" variant="ghost" icon={<Pencil size={12} />} onClick={() => setEditing(!editing)} title={`${mod}E`}>
            {editing ? t('common.done') : t('common.edit')}
          </Button>
        )}
        {editing && (
          <Button size="sm" variant="primary" icon={<Save size={12} />} onClick={() => void save()} disabled={!dirty} title={`${mod}S`}>
            {t('common.save')}
          </Button>
        )}
        <OpenInViewerButton workspaceId={workspaceId} workspacePath={workspacePath} path={path} line={line} />
      </div>
      {error && (
        <Callout tone="error" role="alert" banner>
          {error}
        </Callout>
      )}
      {showFrame ? (
        <PreviewFrame key={`${path}:${frameKey}`} workspaceId={workspaceId} path={path} kind={frame!} />
      ) : showImage ? (
        image && <ImageView image={image} path={path} />
      ) : (
        <>
          {file?.binary && <div className="panel-empty faint">{t('files.viewer.binary')}</div>}
          {file?.tooLarge && <div className="panel-empty faint">{t('files.viewer.tooLarge')}</div>}
          {file && !file.binary && !file.tooLarge && (
            rich ? (
              <RichMarkdown draft={draft} saved={file.content} onChange={setDraft} />
            ) : editing ? (
              <div className="file-editor-box">
                <TextArea bare mono className="file-editor" aria-label={path} value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} autoFocus />
              </div>
            ) : preview ? (
              <div className="file-preview">
                <Markdown text={file.content} workspaceId={workspaceId} />
              </div>
            ) : (
              <div className="file-lines">
                {lines.map((text, n) => (
                  <div key={n} className={`file-line ${line === n + 1 ? 'target' : ''}`} ref={line === n + 1 ? target : undefined}>
                    <span className="ln">{n + 1}</span>
                    <span className="code">{text || ' '}</span>
                  </div>
                ))}
              </div>
            )
          )}
        </>
      )}
    </div>
  )
}

/**
 * G3 · #19: an HTML page or a PDF from the worktree, through foreman-preview:// (main/previewProtocol.ts). A page's
 * frame is sandbox="" (no scripts, an origin of its own) and its CSP allows only this worktree's files, so nothing is
 * fetched from the network. Chromium won't show a PDF in a sandboxed frame, so a PDF's frame has no sandbox attribute:
 * it stays isolated by its own origin, the CSP, and main refusing any navigation out of the preview.
 */
function PreviewFrame({ workspaceId, path, kind }: { workspaceId: string; path: string; kind: FramePreview }) {
  const t = useT()
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    api.previewUrl(workspaceId, path).then(
      (next) => live && setUrl(next),
      (err: unknown) => live && setError(err instanceof Error ? err.message : String(err))
    )
    return () => {
      live = false
    }
  }, [workspaceId, path])
  return (
    <>
      <div className="preview-safe">
        <ShieldCheck size={13} /> {t(kind === 'pdf' ? 'files.frame.pdfSafe' : 'files.frame.htmlSafe')}
      </div>
      {error ? (
        <div className="panel-empty faint">{t('files.frame.failed', { error })}</div>
      ) : (
        url &&
        (kind === 'html' ? (
          <iframe className="preview-frame page" sandbox="" src={url} title={path} referrerPolicy="no-referrer" />
        ) : (
          <iframe className="preview-frame" src={url} title={path} referrerPolicy="no-referrer" />
        ))
      )}
    </>
  )
}

/**
 * The picture, at its own size or scaled down to fit (never up), on a
 * checkerboard so transparency shows. Always an <img> with a data URL, so an
 * SVG's scripts never run and nothing it links to is fetched.
 */
function ImageView({ image, path }: { image: ImagePreview; path: string }) {
  const t = useT()
  const stage = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [room, setRoom] = useState<{ width: number; height: number } | null>(null)
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    setNatural(null)
    setBroken(false)
  }, [image.dataUrl])

  useEffect(() => {
    const el = stage.current
    if (!el) return
    // The stage's padding (24px each side) and the checkerboard's border stay clear.
    const measure = () => el.clientWidth > 0 && setRoom({ width: el.clientWidth - 50, height: el.clientHeight - 50 })
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [image.tooLarge])

  if (image.tooLarge) return <div className="panel-empty faint">{t('files.preview.tooLarge', { size: formatImageBytes(MAX_IMAGE_PREVIEW_BYTES, t) })}</div>
  if (broken) return <div className="panel-empty faint">{t('files.preview.broken', { format: imageFormatName(image.format) })}</div>

  // The header's size wins (an icon names its largest image); a browser-decoded size fills in when the header didn't say.
  const size = image.width && image.height ? { width: image.width, height: image.height } : natural
  const scale = size && room ? Math.min(1, room.width / size.width, room.height / size.height) : null
  const shown = size && scale !== null ? { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) } : undefined
  return (
    <>
      {image.format === 'svg' && (
        <div className="preview-safe">
          <ShieldCheck size={13} /> {t('files.preview.svgSafe')}
        </div>
      )}
      <div className="preview-stage" ref={stage}>
        <div className="preview-checker">
          <img
            src={image.dataUrl}
            alt={path}
            draggable={false}
            style={shown}
            onLoad={(e) => e.currentTarget.naturalWidth > 0 && setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
            onError={() => setBroken(true)}
          />
        </div>
      </div>
      <div className="preview-foot">
        <ImageIcon size={12} />
        <span>
          {scale === null ? '' : `${scale >= 1 ? t('files.preview.actual') : t('files.preview.fit', { percent: Math.max(1, Math.round(scale * 100)) })} · `}
          {t('files.preview.where')}
        </span>
      </div>
    </>
  )
}
