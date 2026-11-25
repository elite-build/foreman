import { ChevronDown, ChevronUp, Code2, Eye, Globe, Image as ImageIcon, Pencil, RotateCw, Save, ShieldCheck, X } from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { formatImageBytes, imageFormatName, imageMetaLabel, MAX_IMAGE_PREVIEW_BYTES, previewFormat, type ImagePreview } from '../../../shared/imageInfo'
import { framePreview, type FramePreview } from '../../../shared/preview'
import { baseText, changeBlocks, mergeEdits, revertBlock, type ChangeBlock } from '../../../shared/fileChanges'
import { linesAt, SELECTION_PREFIX } from '../../../shared/diffSelection'
import type { DiffSelection, FileContent } from '../../../shared/types'
import { useT } from '../i18n'
import { highlightLines } from '../highlight'
import { api, attempt, modKey, useStore } from '../store'
import { Button, Callout, CodeEditor, IconButton, Segmented, Status, Tag, type CodeEditorChange, type CodeEditorMark } from '../ui'
import { InlineComment } from './Changes'
import { Quote, reportSend, SelectionBar, SelectionDraftBox, tabName, useDefaultTab, type BarAction } from './DiffSelection'
import { Markdown } from './Markdown'
import { OpenInViewerButton } from './OpenIn'
import { isRichMarkdownPath, loadMarkdownMode, RichMarkdown, saveMarkdownMode, type MarkdownEditorMode } from './RichMarkdown'
import { useWorkspaceDiff } from './workspaceDiff'
import './files.css'

// The 1-based line an offset falls on, and the offset where a 1-based line starts.
const lineOf = (text: string, offset: number) => text.slice(0, offset).split('\n').length
function offsetOf(text: string, line: number): number {
  let offset = 0
  for (let n = 1; n < line; n++) {
    const next = text.indexOf('\n', offset)
    if (next < 0) break
    offset = next + 1
  }
  return offset
}
// A block's identity, for hiding its peek: it holds while the text around it changes.
const blockKey = (b: ChangeBlock) => `${b.kind}:${b.start}:${b.oldStart}`
// The first line a block shows on: a removal at the top of the file shows on line 1.
const firstLine = (b: ChangeBlock) => Math.max(1, b.start)
// The change under a line: an added or changed line's block, or a removal drawn at the line after it.
function blockAt(blocks: ChangeBlock[], line: number): ChangeBlock | undefined {
  return blocks.find((b) => b.kind !== 'removed' && line >= b.start && line <= b.end) ?? blocks.find((b) => b.kind === 'removed' && line === firstLine(b))
}

// `hasGit`: the workspace is a git worktree (not a plain folder), so the branch diff can be read for the change bars.
export function FileViewer({ workspaceId, workspacePath, path, line, hasGit }: { workspaceId: string; workspacePath: string; path: string; line?: number; hasGit: boolean }) {
  const platform = useStore((s) => s.snapshot!.platform)
  const t = useT()
  const allSessions = useStore((s) => s.snapshot!.sessions)
  const allComments = useStore((s) => s.snapshot!.comments)
  const running = allSessions.some((s) => s.workspaceId === workspaceId && s.status === 'running')
  const openTabs = allSessions.filter((x) => x.workspaceId === workspaceId && !x.closedAt)
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
  // The agent changed the file on disk while there were unsaved edits: its text, until the user picks what to keep.
  const [conflict, setConflict] = useState<{ theirs: string } | null>(null)
  const [caretLine, setCaretLine] = useState(1)
  // The selected lines (1-based, both included), or null when nothing is selected.
  const [range, setRange] = useState<{ start: number; end: number } | null>(null)
  // A line the header's Previous or Next moved to, revealed once; the `line` prop wins again after it changes.
  const [jump, setJump] = useState<number | undefined>(undefined)
  const [hiddenPeek, setHiddenPeek] = useState<string | null>(null)
  // A selection action waiting for its text (Comment, Change this, Ask).
  const [selDraft, setSelDraft] = useState<{ action: BarAction; selection: DiffSelection } | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const editor = useRef<HTMLTextAreaElement>(null)
  const fallbackTab = useDefaultTab(workspaceId)
  const { diff, refresh } = useWorkspaceDiff(workspaceId, running, hasGit, 'all')
  const target = picked && (picked === 'new' || openTabs.some((x) => x.id === picked)) ? picked : fallbackTab
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

  // The text on screen: the draft while editing (its colours and changes follow it a moment late, so typing stays quick).
  const deferredDraft = useDeferredValue(draft)
  const text = file ? (editing ? deferredDraft : file.content) : ''
  const tokenLines = useMemo(() => highlightLines(text, path) ?? undefined, [text, path])
  // The branch's text of this file, from the diff: null when the diff is unknown or no longer matches the file.
  const diffFile = diff?.files.find((f) => f.path === path)
  const base = useMemo(() => {
    if (!file || !diff) return null
    return diffFile ? baseText(file.content, diffFile) : file.content
  }, [file, diff, diffFile])
  const blocks = useMemo(() => (base === null ? [] : changeBlocks(base, text)), [base, text])
  const changes = useMemo(() => {
    const out: CodeEditorChange[] = []
    for (const b of blocks) {
      if (b.kind === 'removed') out.push({ line: b.start, kind: 'removed' })
      else for (let n = b.start; n <= b.end; n++) out.push({ line: n, kind: b.kind })
    }
    return out
  }, [blocks])
  const comments = useMemo(
    () => allComments.filter((c) => c.workspaceId === workspaceId && c.file === path && c.state !== 'resolved'),
    [allComments, workspaceId, path]
  )
  const marks = useMemo<CodeEditorMark[]>(() => comments.map((c) => ({ line: c.line, tone: 'info', message: c.body })), [comments])
  // The editor's marks come with their label, or not at all (the editor's props are one or the other).
  const commentMarks: { marks: CodeEditorMark[]; markLabel: (m: CodeEditorMark) => string } | { marks?: undefined; markLabel?: undefined } =
    marks.length > 0 ? { marks, markLabel: (m) => t('files.comment.mark', { line: m.line, message: m.message }) } : {}
  const caretComments = comments.filter((c) => c.line === caretLine)
  const caretBlock = blockAt(blocks, caretLine)
  const peek = !range && caretBlock && blockKey(caretBlock) !== hiddenPeek ? caretBlock : null
  // The merge of the user's edits with the agent's, when they don't touch the same lines.
  const merged = useMemo(() => (conflict && file ? mergeEdits(file.content, draft, conflict.theirs) : null), [conflict, file, draft])

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
    setConflict(null)
    setRange(null)
    setJump(undefined)
    setHiddenPeek(null)
    setSelDraft(null)
    setCaretLine(1)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, path])

  // A new line from the caller (a link to another line of this file) is revealed, not the last one jumped to.
  useEffect(() => {
    setJump(undefined)
  }, [line])

  // Editing starts with the caret in the text.
  useEffect(() => {
    if (editing) editor.current?.focus()
  }, [editing])

  // The agent's tools may have changed the file: when the diff is read again, so is the file. Without unsaved edits the
  // viewer follows the disk; with them, the agent's text waits as a conflict.
  const latest = useRef({ file, dirty })
  latest.current = { file, dirty }
  useEffect(() => {
    if (!diff || !hasText) return
    let live = true
    api.readFile(workspaceId, path).then(
      (disk) => {
        const now = latest.current
        if (!live || !now.file || disk.binary || disk.tooLarge || disk.content === now.file.content) return
        if (now.dirty) setConflict({ theirs: disk.content })
        else {
          setFile(disk)
          setDraft(disk.content)
        }
      },
      // A file that can't be read now is shown as it was; the next diff read tries again.
      () => undefined
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff])

  const save = async () => {
    if (!dirty || !file) return
    const refused = await attempt(() => api.writeFile(workspaceId, path, draft, file.content))
    // Undefined: the write failed, and attempt has said why.
    if (refused === undefined) return
    // The disk changed since the file was read: keep the user's text and show the conflict.
    if (refused) return setConflict({ theirs: refused.current })
    setConflict(null)
    setFile({ content: draft, binary: false, tooLarge: false })
    if (format) void loadImage()
    void refresh()
  }

  const keepMine = async () => {
    if (!conflict) return
    const theirs = conflict.theirs
    const refused = await attempt(() => api.writeFile(workspaceId, path, draft, theirs))
    if (refused === undefined) return
    if (refused) return setConflict({ theirs: refused.current })
    setConflict(null)
    setFile({ content: draft, binary: false, tooLarge: false })
    void refresh()
  }

  const useTheirs = () => {
    if (!conflict || !file) return
    setFile({ ...file, content: conflict.theirs })
    setDraft(conflict.theirs)
    setConflict(null)
  }

  const mergeBoth = () => {
    if (!conflict || !file || merged === null) return
    // The file on disk is the agent's text now, so the merged draft is what the next save writes.
    setFile({ ...file, content: conflict.theirs })
    setDraft(merged)
    setConflict(null)
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

  // The caret's line, and whether the peek of its change is hidden for good until the caret leaves it.
  const moveCaret = (line: number) => {
    setCaretLine(line)
    const here = blockAt(blocks, line)
    if (hiddenPeek !== null && (!here || blockKey(here) !== hiddenPeek)) setHiddenPeek(null)
  }

  // The selected lines, read from the editor: a selection that ends at the start of a line stops at the line before it.
  const readRange = () => {
    const area = editor.current
    if (!area || area.selectionStart === area.selectionEnd) {
      setRange(null)
      return
    }
    const { value, selectionStart, selectionEnd } = area
    const endsAtLineStart = value[selectionEnd - 1] === '\n'
    setRange({ start: lineOf(value, selectionStart), end: lineOf(value, selectionEnd) - (endsAtLineStart ? 1 : 0) })
  }
  const restoreFocus = () => editor.current?.focus()
  const clearRange = () => {
    const area = editor.current
    if (area) area.setSelectionRange(area.selectionEnd, area.selectionEnd)
    setRange(null)
  }

  const goTo = (to: number) => {
    const area = editor.current
    if (!area) return
    const offset = offsetOf(area.value, to)
    area.setSelectionRange(offset, offset)
    area.focus()
    moveCaret(to)
    setRange(null)
    setJump(to)
  }
  // Previous and Next: the change starts before or after the caret's line.
  const starts = blocks.map(firstLine)
  const previousStart = [...starts].reverse().find((n) => n < caretLine)
  const nextStart = starts.find((n) => n > caretLine)

  const sendSelection = async (body: string, selection: DiffSelection) => {
    setSending(true)
    const result = await attempt(() => api.sendDiffSelection(workspaceId, { file: path, body, selection }, target))
    setSending(false)
    if (!result) return
    reportSend(t, workspaceId, result)
    setPicked(null)
    clearRange()
    restoreFocus()
  }
  // The bar's action on the selected lines. Explain goes at once; the others open a box for the text first.
  const act = (action: BarAction) => {
    if (!range) return
    const selected = linesAt(text, range.start, range.end)
    if (!selected) return
    const selection: DiffSelection = {
      action,
      side: 'new',
      start: range.start,
      end: range.end,
      lines: selected,
      scope: 'all',
      oldPath: diffFile?.oldPath && diffFile.oldPath !== path ? diffFile.oldPath : undefined,
      blobId: diffFile?.blobId,
      mergeBase: diff?.mergeBase,
      at: new Date().toISOString()
    }
    if (action === 'explain') void sendSelection(SELECTION_PREFIX.explain, selection)
    else setSelDraft({ action, selection })
  }
  const finishDraft = (body: string) => {
    if (!selDraft) return
    const { action, selection } = selDraft
    setSelDraft(null)
    if (action !== 'comment') {
      void sendSelection(body, selection)
      return
    }
    // Comment is a review comment on the selection's last line, quoting the lines.
    clearRange()
    restoreFocus()
    if (body.trim()) void attempt(() => api.addComment(workspaceId, path, selection.end, body, selection))
  }
  const cancelDraft = () => {
    setSelDraft(null)
    clearRange()
    restoreFocus()
  }
  const revert = (block: ChangeBlock) => {
    if (!file) return
    // The text as it is on screen, so the revert keeps anything typed since the last read.
    setDraft(revertBlock(editing ? draft : file.content, block))
    setEditing(true)
    setPreview(false)
  }

  const showImage = Boolean(format) && !editing && !source
  const showFrame = frame === 'pdf' || (frame === 'html' && framed && !editing)
  const selectionTab = tabName(t, openTabs, target)
  return (
    <div className="file-viewer">
      <div className="file-diff-head">
        <span className="mono">{path}</span>
        {showImage && image && <span className="preview-meta">{imageMetaLabel(image, t)}</span>}
        {dirty && <Status tone="warn" compact title={t('files.viewer.unsaved')} label={t('files.viewer.unsaved')} />}
        {file && !file.binary && !file.tooLarge && !rich && blocks.length > 0 && (
          <>
            <Tag>{t('files.changes.count', { count: blocks.length })}</Tag>
            <IconButton label={t('files.changes.prev')} disabled={previousStart === undefined} onClick={() => previousStart !== undefined && goTo(previousStart)}>
              <ChevronUp size={12} />
            </IconButton>
            <IconButton label={t('files.changes.next')} disabled={nextStart === undefined} onClick={() => nextStart !== undefined && goTo(nextStart)}>
              <ChevronDown size={12} />
            </IconButton>
          </>
        )}
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
      {conflict && (
        <Callout
          tone="warn"
          role="alert"
          banner
          actions={
            <>
              {merged !== null && (
                <Button size="sm" onClick={mergeBoth}>
                  {t('files.conflict.merge')}
                </Button>
              )}
              <Button size="sm" onClick={useTheirs}>
                {t('files.conflict.theirs')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => void keepMine()}>
                {t('files.conflict.mine')}
              </Button>
            </>
          }
        >
          {t('files.conflict.body')}
          {merged === null ? ` ${t('files.conflict.overlap')}` : ''}
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
            ) : preview ? (
              <div className="file-preview">
                <Markdown text={file.content} workspaceId={workspaceId} />
              </div>
            ) : (
              <div className="file-code">
                <CodeEditor
                  className="file-code-editor"
                  aria-label={path}
                  ref={editor}
                  value={editing ? draft : file.content}
                  onChange={setDraft}
                  readOnly={!editing}
                  spellCheck={false}
                  tokenLines={tokenLines}
                  changes={changes}
                  highlight={line ? { from: line, to: line } : null}
                  revealLine={jump ?? line}
                  onCaretLine={moveCaret}
                  onSelect={readRange}
                  {...commentMarks}
                />
                {(selDraft || range || peek || caretComments.length > 0) && (
                  <div className="file-strip">
                    {selDraft ? (
                      <SelectionDraftBox
                        key={`${selDraft.action}:${selDraft.selection.start}`}
                        initial={selDraft.action === 'comment' ? '' : SELECTION_PREFIX[selDraft.action]}
                        sendLabel={selDraft.action === 'comment' ? t('diffSel.comment') : t('diffSel.send', { tab: selectionTab })}
                        placeholder={selDraft.action === 'comment' ? t('changes.comment.placeholder') : t('diffSel.placeholder', { tab: selectionTab })}
                        onSend={finishDraft}
                        onCancel={cancelDraft}
                      />
                    ) : range ? (
                      dirty ? (
                        <div className="faint small">{t('files.sel.saveFirst')}</div>
                      ) : (
                        <SelectionBar
                          workspaceId={workspaceId}
                          count={range.end - range.start + 1}
                          target={target}
                          onTarget={setPicked}
                          onAction={act}
                          busy={sending}
                        />
                      )
                    ) : (
                      <>
                        {caretComments.map((c) => (
                          <InlineComment key={c.id} comment={c} />
                        ))}
                        {peek && (
                          <ChangePeek
                            block={peek}
                            onRevert={() => revert(peek)}
                            onHide={() => setHiddenPeek(blockKey(peek))}
                          />
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          )}
        </>
      )}
    </div>
  )
}

/** The change under the caret: what the branch did here, as a mini diff, with a way to put it back. */
function ChangePeek({ block, onRevert, onHide }: { block: ChangeBlock; onRevert: () => void; onHide: () => void }) {
  const t = useT()
  const rows = [
    ...block.oldLines.map((text, i) => ({ kind: 'del', no: block.oldStart + i, text })),
    ...block.newLines.map((text, i) => ({ kind: 'add', no: block.start + i, text }))
  ]
  return (
    <div className="file-peek">
      <div className="file-peek-head">
        <Tag>{t(block.kind === 'added' ? 'files.changes.added' : block.kind === 'modified' ? 'files.changes.modified' : 'files.changes.removed')}</Tag>
        <span className="spacer" />
        <Button size="sm" title={t('files.changes.revertTitle')} onClick={onRevert}>
          {t('files.changes.revert')}
        </Button>
        <IconButton label={t('files.changes.hide')} onClick={onHide}>
          <X size={12} />
        </IconButton>
      </div>
      <Quote rows={rows} />
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
