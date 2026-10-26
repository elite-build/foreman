// O15: Rich mode for editing a Markdown file. Each top-level block is its own
// small contenteditable, rendered from the parse (markdownBlocks.ts). Typing in
// one rewrites only that block's range of the draft; nothing else is ever
// re-serialized, so the rest of the file saves byte for byte. Blocks Rich mode
// can't edit faithfully (raw HTML, front matter, tables, reference links…)
// show their source, "kept as written", and can be edited as text in place.
import { Bold, Code, FileText, Heading, Link, List } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react'
import type { PlainKey } from '../../../shared/i18n'
import { useT } from '../i18n'
import { modKey, useStore } from '../store'
import { IconButton, TextInput } from '../ui'
import {
  appendedText,
  baselineOf,
  changedLineCount,
  editedBlocks,
  editedText,
  escapeHtml,
  firstBlockTag,
  parseDoc,
  plainText,
  richToHtml,
  serializeBlocks,
  setBlockType,
  type BlockKind,
  type MdBlock,
  type RichNode
} from './markdownBlocks'

export type MarkdownEditorMode = 'source' | 'rich'

const MODE_KEY = 'switchyard:markdownEditor'

// Source by default (today's plain editor), with Rich one click away; the choice is remembered.
export function loadMarkdownMode(): MarkdownEditorMode {
  try {
    return JSON.parse(localStorage.getItem(MODE_KEY) ?? '""') === 'rich' ? 'rich' : 'source'
  } catch {
    return 'source'
  }
}

export function saveMarkdownMode(mode: MarkdownEditorMode): void {
  try {
    localStorage.setItem(MODE_KEY, JSON.stringify(mode))
  } catch {
    // Not persisted; fine.
  }
}

/** Only these get Rich mode; MDX has JSX that a Markdown parse would misread. */
export const isRichMarkdownPath = (path: string): boolean => /\.(md|markdown)$/i.test(path)

// The empty paragraph below the last block, for adding to the end.
const TAIL = 'tail'

const KEPT_LABEL: Record<BlockKind, PlainKey> = {
  frontmatter: 'files.md.kind.frontmatter',
  html: 'files.md.kind.html',
  table: 'files.md.kind.table',
  definition: 'files.md.kind.definition',
  code: 'files.md.kind.code',
  heading: 'files.md.kind.markdown',
  paragraph: 'files.md.kind.markdown',
  list: 'files.md.kind.markdown',
  blockquote: 'files.md.kind.markdown',
  thematicBreak: 'files.md.kind.markdown',
  other: 'files.md.kind.markdown'
}

/** An editable block's DOM as markdownBlocks' tree. Chromium's styled spans count as bold or italic. */
function domToRich(parent: Node): RichNode[] {
  const out: RichNode[] = []
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) out.push({ type: 'text', value: node.nodeValue ?? '' })
    else if (node instanceof HTMLElement) {
      const attrs: Record<string, string> = {}
      for (const a of Array.from(node.attributes)) attrs[a.name] = a.value
      let tag = node.tagName.toLowerCase()
      if (tag === 'span' && attrs.class !== 'md-check') {
        if (/bold|[6-9]00/.test(node.style.fontWeight)) tag = 'strong'
        else if (node.style.fontStyle === 'italic') tag = 'em'
      }
      out.push({ type: 'el', tag, attrs, children: domToRich(node) })
    }
  }
  return out
}

// The block being typed in: the draft around it is fixed while it's edited.
interface Session {
  key: string
  prefix: string
  suffix: string
  original: string
  baseline: string
}

interface HostEvents {
  ref: (key: string, el: HTMLElement | null) => void
  onFocus: (e: FocusEvent<HTMLElement>) => void
  onBlur: (e: FocusEvent<HTMLElement>) => void
  onInput: (e: { currentTarget: HTMLElement }) => void
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
  onPaste: (e: ClipboardEvent<HTMLElement>) => void
  onMouseDown: (e: MouseEvent<HTMLElement>) => void
}

type Focus = 'rich' | 'plain' | null

export function RichMarkdown({ draft, saved, onChange, compact }: { draft: string; saved: string; onChange: (next: string) => void; compact?: boolean }) {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  const mod = modKey(platform)
  const alt = platform === 'darwin' ? '⌥' : 'Alt+'
  const shift = platform === 'darwin' ? '⇧' : 'Shift+'
  const [doc, setDoc] = useState(() => parseDoc(draft))
  const latest = useRef(draft)
  const session = useRef<Session | null>(null)
  const hosts = useRef(new Map<string, HTMLElement>())
  const focused = useRef<HTMLElement | null>(null)
  const refocus = useRef<number | null>(null)
  const [focus, setFocus] = useState<Focus>(null)
  // The block being typed in, once it differs from the file: marked in the margin before it's re-read.
  const [live, setLive] = useState<string | null>(null)
  const [active, setActive] = useState({ heading: false, list: false, bold: false, code: false })
  const [link, setLink] = useState<{ host: HTMLElement; range: Range } | null>(null)
  const [url, setUrl] = useState('')

  // Edits from elsewhere (Source mode, a reload) are read again while nothing is being typed.
  useEffect(() => {
    if (session.current) return
    latest.current = draft
    if (draft !== doc.source) setDoc(parseDoc(draft))
  }, [draft, doc.source])

  useEffect(() => {
    document.execCommand('defaultParagraphSeparator', false, 'p')
  }, [])

  const begin = (host: HTMLElement): Session | null => {
    const key = host.dataset.block ?? ''
    if (session.current?.key === key) return session.current
    const source = latest.current
    if (key === TAIL) return (session.current = { key, prefix: source, suffix: '', original: '', baseline: '' })
    // Found by its text, so a block keeps its range even if the doc moved under it.
    const fresh = source === doc.source ? doc : parseDoc(source)
    const block = fresh.blocks.find((b) => b.key === key)
    if (!block) return null
    return (session.current = {
      key,
      prefix: source.slice(0, block.start),
      suffix: source.slice(block.end),
      original: block.text,
      baseline: baselineOf(block, fresh.style)
    })
  }

  const serialize = (host: HTMLElement): string =>
    host.dataset.kept ? plainText(domToRich(host)).replace(/\xa0/g, ' ') : serializeBlocks(domToRich(host), doc.style)

  const commit = (host: HTMLElement, markdown = serialize(host)) => {
    const s = begin(host)
    if (!s) return null
    const text = s.key === TAIL ? appendedText(s.prefix, markdown, doc.eol) : editedText(s.original, s.baseline, markdown, doc.eol)
    const next = s.prefix + text + s.suffix
    latest.current = next
    onChange(next)
    setLive(text !== s.original ? s.key : null)
    return { start: s.prefix.length, text, next }
  }

  // Leaving a block re-reads the file, so Markdown typed into it becomes formatting.
  const finish = () => {
    if (!session.current) return
    session.current = null
    setLive(null)
    if (latest.current !== doc.source) setDoc(parseDoc(latest.current))
  }

  const richHost = (): HTMLElement | null => {
    const host = focused.current
    return host && !host.dataset.kept && !host.dataset.code ? host : null
  }

  const run = (command: string, value?: string) => {
    const host = richHost()
    if (!host) return
    document.execCommand(command, false, value)
    commit(host)
  }

  const turnInto = (kind: 'heading' | 'list') => {
    const host = richHost()
    if (!host) return
    const nodes = domToRich(host)
    const first = firstBlockTag(nodes) ?? 'p'
    const type = kind === 'heading' ? (/^h\d$/.test(first) ? 'p' : 'h2') : first === 'ul' || first === 'ol' ? 'p' : 'ul'
    const done = commit(host, serializeBlocks(setBlockType(nodes, type), doc.style))
    if (!done) return
    session.current = null
    setLive(null)
    refocus.current = done.start + (done.text.length - done.text.trimStart().length)
    setDoc(parseDoc(done.next))
  }

  const toggleCode = () => {
    const host = richHost()
    const sel = getSelection()
    if (!host || !sel?.rangeCount) return
    const range = sel.getRangeAt(0)
    const at = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
    const code = at?.closest('code')
    if (code && host.contains(code)) code.replaceWith(document.createTextNode(code.textContent ?? ''))
    else if (!range.collapsed) document.execCommand('insertHTML', false, `<code>${escapeHtml(range.toString())}</code>`)
    commit(host)
  }

  const openLink = () => {
    const host = richHost()
    const sel = getSelection()
    if (!host || !sel?.rangeCount) return
    setUrl('')
    setLink({ host, range: sel.getRangeAt(0).cloneRange() })
  }

  const closeLink = (apply: boolean) => {
    if (!link) return
    const { host, range } = link
    setLink(null)
    host.focus()
    const sel = getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    const href = url.trim()
    if (!apply || !href) return
    if (range.collapsed) document.execCommand('insertHTML', false, `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`)
    else document.execCommand('createLink', false, href)
    commit(host)
  }

  // Put the caret back after a block was turned into a heading or list (it was drawn again).
  useLayoutEffect(() => {
    const at = refocus.current
    if (at === null) return
    refocus.current = null
    const block = doc.blocks.find((b) => b.end > at) ?? doc.blocks[doc.blocks.length - 1]
    const host = block && hosts.current.get(block.key)
    if (!host) return
    host.focus()
    getSelection()?.selectAllChildren(host)
    getSelection()?.collapseToEnd()
  }, [doc])

  // The toolbar shows what's under the caret.
  useEffect(() => {
    const onSelection = () => {
      const host = focused.current
      const node = getSelection()?.anchorNode
      if (!host || !node || !host.contains(node)) return
      const el = node instanceof Element ? node : node.parentElement
      const top = Array.from(host.children).find((c) => c.contains(node))?.tagName.toLowerCase() ?? 'p'
      const plain = Boolean(host.dataset.kept || host.dataset.code)
      const next = {
        heading: !plain && /^h\d$/.test(top),
        list: !plain && Boolean(el?.closest('ul,ol')),
        bold: !plain && document.queryCommandState('bold'),
        code: !plain && Boolean(el?.closest('code'))
      }
      setActive((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    }
    document.addEventListener('selectionchange', onSelection)
    return () => document.removeEventListener('selectionchange', onSelection)
  }, [])

  // Hosts get stable handlers (so unchanged blocks never redraw) that call the latest closures.
  const impl = useRef<HostEvents>(null!)
  impl.current = {
    ref: (key, el) => {
      if (el) hosts.current.set(key, el)
      else hosts.current.delete(key)
    },
    onFocus: (e) => {
      focused.current = e.currentTarget
      setFocus(e.currentTarget.dataset.kept || e.currentTarget.dataset.code ? 'plain' : 'rich')
    },
    onBlur: (e) => {
      // The link field keeps the block's edit going.
      if ((e.relatedTarget as Element | null)?.closest?.('.md-toolbar')) return
      focused.current = null
      setFocus(null)
      finish()
    },
    onInput: (e) => void commit(e.currentTarget),
    onKeyDown: (e) => {
      const host = e.currentTarget
      const plain = Boolean(host.dataset.kept || host.dataset.code)
      const modDown = platform === 'darwin' ? e.metaKey : e.ctrlKey
      if (e.key === 'Tab' && !modDown && !plain) {
        const node = getSelection()?.anchorNode
        const el = node instanceof Element ? node : node?.parentElement
        if (el?.closest('li')) {
          e.preventDefault()
          document.execCommand(e.shiftKey ? 'outdent' : 'indent')
          commit(host)
        }
        return
      }
      if (!modDown) return
      const code = e.code
      const handled =
        (!e.shiftKey && !e.altKey && (code === 'KeyB' || code === 'KeyI' || code === 'KeyU')) ||
        (e.altKey && !e.shiftKey && code === 'Digit2') ||
        (e.shiftKey && !e.altKey && code === 'Digit8')
      if (!handled) return
      // Not the app's shortcuts (⌘B hides the sidebar), and no underline: Markdown has none.
      e.preventDefault()
      e.stopPropagation()
      if (plain) return
      if (code === 'KeyB') run('bold')
      else if (code === 'KeyI') run('italic')
      else if (code === 'Digit2') turnInto('heading')
      else if (code === 'Digit8') turnInto('list')
    },
    // Pasted as plain text: Markdown in it becomes formatting once the block is re-read.
    onPaste: (e) => {
      e.preventDefault()
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
    },
    onMouseDown: (e) => {
      const box = (e.target as Element).closest?.('.md-check')
      if (!box) return
      e.preventDefault()
      const host = e.currentTarget
      host.focus()
      box.setAttribute('data-checked', box.getAttribute('data-checked') === 'true' ? 'false' : 'true')
      commit(host)
    }
  }
  const events = useMemo<HostEvents>(
    () => ({
      ref: (key, el) => impl.current.ref(key, el),
      onFocus: (e) => impl.current.onFocus(e),
      onBlur: (e) => impl.current.onBlur(e),
      onInput: (e) => impl.current.onInput(e),
      onKeyDown: (e) => impl.current.onKeyDown(e),
      onPaste: (e) => impl.current.onPaste(e),
      onMouseDown: (e) => impl.current.onMouseDown(e)
    }),
    []
  )

  const marked = useMemo(() => editedBlocks(saved, doc), [saved, doc])
  const changed = useMemo(() => changedLineCount(saved, draft), [saved, draft])
  const off = focus !== 'rich'
  const keep = (e: MouseEvent) => e.preventDefault()
  // `on` is undefined for a plain action (Link), true or false for a format that toggles.
  const tool = (title: string, on: boolean | undefined, icon: React.ReactNode, action: () => void) => (
    <IconButton label={title} pressed={on} disabled={off} onMouseDown={keep} onClick={action}>
      {icon}
    </IconButton>
  )

  return (
    <>
      <div className="md-toolbar">
        {tool(`${t('files.md.heading')} (${mod}${alt}2)`, active.heading, <Heading size={14} />, () => turnInto('heading'))}
        {tool(`${t('files.md.bold')} (${mod}B)`, active.bold, <Bold size={14} />, () => run('bold'))}
        {tool(`${t('files.md.list')} (${mod}${shift}8)`, active.list, <List size={14} />, () => turnInto('list'))}
        {tool(t('files.md.link'), undefined, <Link size={14} />, openLink)}
        {tool(t('files.md.code'), active.code, <Code size={14} />, toggleCode)}
        <span className="sep" />
        {link ? (
          <TextInput
            className="md-link-input"
            autoFocus
            value={url}
            placeholder={t('files.md.linkPlaceholder')}
            aria-label={t('files.md.link')}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault()
                closeLink(e.key === 'Enter')
              }
            }}
            onBlur={(e) => {
              if (e.relatedTarget === link.host) return
              setLink(null)
              focused.current = null
              setFocus(null)
              finish()
            }}
          />
        ) : (
          <span className="hint">{t('files.md.hint')}</span>
        )}
      </div>
      <div className="file-preview md-rich">
        <div className="markdown">
          {doc.blocks.map((block, i) => (
            <Block key={block.key} block={block} edited={marked.has(i) || live === block.key} label={t('files.md.kept', { what: t(KEPT_LABEL[block.kind]) })} events={events} />
          ))}
          <div
            key={`${TAIL}:${doc.source.length}`}
            ref={(el) => events.ref(TAIL, el)}
            data-block={TAIL}
            className={`md-block md-tail ${live === TAIL ? 'md-edited' : ''}`}
            contentEditable
            suppressContentEditableWarning
            data-placeholder={t('files.md.addHere')}
            onFocus={events.onFocus}
            onBlur={events.onBlur}
            onInput={events.onInput}
            onKeyDown={events.onKeyDown}
            onPaste={events.onPaste}
          />
        </div>
      </div>
      {/* G4: a short field (a template, the note) has no file to talk about. */}
      {!compact && <div className="md-foot">
        <FileText size={12} />
        <span>{t('files.md.footer')}</span>
        <span className="spacer" />
        {changed > 0 && <span>{t('files.md.changed', { count: changed })}</span>}
      </div>}
    </>
  )
}

const Block = memo(function Block({ block, edited, label, events }: { block: MdBlock; edited: boolean; label: string; events: HostEvents }) {
  const html = useMemo(() => (block.rich ? richToHtml(block.rich) : escapeHtml(block.text.replace(/\r\n?/g, '\n'))), [block.rich, block.text])
  const mark = edited ? ' md-edited' : ''
  const handlers = {
    ref: (el: HTMLElement | null) => events.ref(block.key, el),
    'data-block': block.key,
    onFocus: events.onFocus,
    onBlur: events.onBlur,
    onInput: events.onInput,
    onKeyDown: events.onKeyDown,
    onPaste: events.onPaste,
    onDrop: (e: React.DragEvent) => e.preventDefault(),
    dangerouslySetInnerHTML: { __html: html }
  }
  // A horizontal rule has nothing to type into; Source edits it.
  if (block.kind === 'thematicBreak') return <hr className={mark.trim() || undefined} />
  if (!block.rich) {
    return (
      <div className={`md-source${mark}`}>
        <span className="md-source-tag">{label}</span>
        <pre {...handlers} data-kept="1" className="mono" contentEditable="plaintext-only" spellCheck={false} />
      </div>
    )
  }
  const code = block.kind === 'code'
  return <div {...handlers} data-code={code ? '1' : undefined} className={`md-block${mark}`} contentEditable={code ? 'plaintext-only' : true} spellCheck={!code} onMouseDown={events.onMouseDown} />
})
