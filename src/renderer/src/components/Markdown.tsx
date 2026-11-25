import { Copy, WrapText } from 'lucide-react'
import { memo, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import type { Components, UrlTransform } from 'react-markdown'
import { fileLinkPath, looksLikeFileLink } from '../../../shared/fileLink'
import { MermaidBlock } from './MermaidBlock'
import { isMermaidClass, rehypeMermaidFences } from './mermaidSource'
import { ShellSnippet } from './ShellSnippet'
import { useT } from '../i18n'
import { api, attempt, showToast } from '../store'
import { Card, IconButton } from '../ui'

// A link to a file (`file:///C:/…`, `C:\…`) keeps its target, which Markdown would drop as an unsafe scheme; images don't.
const urlTransform: UrlTransform = (url, key) => (key === 'href' && looksLikeFileLink(url) ? url : defaultUrlTransform(url))

function codeText(node: { type: string; value?: string; children?: unknown[] }): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map((child) => codeText(child as Parameters<typeof codeText>[0])).join('')
}

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

// Whether code blocks wrap their long lines: one choice for every block, kept in localStorage (like the diff's wrap).
const WRAP_KEY = 'foreman:codeWrap'
let wrapCodeLines = (() => {
  try {
    return localStorage.getItem(WRAP_KEY) === '1'
  } catch {
    return false
  }
})()
const wrapListeners = new Set<() => void>()
function setWrapCodeLines(wrap: boolean): void {
  wrapCodeLines = wrap
  try {
    localStorage.setItem(WRAP_KEY, wrap ? '1' : '0')
  } catch {
    // Not kept; fine.
  }
  for (const listener of wrapListeners) listener()
}
const subscribeWrap = (listener: () => void) => {
  wrapListeners.add(listener)
  return () => void wrapListeners.delete(listener)
}

/** A code block in a reply, with its language, Copy and Wrap in a small header (the snippet toolbar). */
function CodeBlock({ language, code, children }: { language: string; code: string; children: ReactNode }) {
  const t = useT()
  const wrap = useSyncExternalStore(subscribeWrap, () => wrapCodeLines)
  const copy = () =>
    attempt(async () => {
      await navigator.clipboard.writeText(code)
      showToast(t('common.copied'))
    })
  return (
    <Card size="sm" className="code-block" data-wrap={wrap ? '' : undefined}>
      <div className="snippet-toolbar" data-search-ignore>
        {language && <span className="faint small">{language}</span>}
        <span className="spacer" />
        <IconButton label={t('markdown.code.copy')} onClick={() => void copy()}>
          <Copy size={13} />
        </IconButton>
        <IconButton label={t('markdown.code.wrap')} pressed={wrap} onClick={() => setWrapCodeLines(!wrap)}>
          <WrapText size={13} />
        </IconButton>
      </div>
      {children}
    </Card>
  )
}

// Links open in the system browser (the main process intercepts new windows).
// A link to a file opens it where it belongs (shared/fileOpen.ts, as a tool call's path does); Ctrl-click or ⌘-click shows
// it in its folder. `files.root` is the worktree a relative path is in; `files: null` (a cloud workspace, whose files are
// in its sandbox) leaves file links as they are. Without `files` only a full path opens.
// `wrapCode` may wrap a fenced block (given its text and the block): the assistant puts a Copy chip on `foreman` commands.
// `codeTools`: a fenced block gets its language, Copy and Wrap in a header (a chat reply's code).
// `headingStart`: the outline level a `#` heading takes, for text an agent wrote inside a message (chat, assistant), so its
// headings sit below the message's own. `##` is one level deeper, down to 6 (a reader has no level 7). The elements stay
// h1 to h6, so the headings look as they always did; `aria-level` gives the level a screen reader announces.
export const Markdown = memo(function Markdown({
  text,
  workspaceId,
  streaming = false,
  wrapCode,
  codeTools = false,
  headingStart,
  files
}: {
  text: string
  workspaceId?: string
  files?: { root?: string } | null
  streaming?: boolean
  wrapCode?: (code: string, block: ReactNode) => ReactNode | undefined
  codeTools?: boolean
  headingStart?: number
}) {
  // The reply's own top heading (often `##`, not `#`) takes `headingStart`, so the outline never skips a level.
  const topHeading = useMemo(() => {
    if (headingStart === undefined) return 1
    const levels = [...text.matchAll(/^ {0,3}(#{1,6})[ 	]/gm)].map((m) => m[1].length)
    return levels.length ? Math.min(...levels) : 1
  }, [text, headingStart])
  const components = useMemo<Components>(() => ({
    ...(headingStart !== undefined &&
      Object.fromEntries(
        HEADINGS.map((Tag, i) => [Tag, ({ children }: { children?: ReactNode }) => <Tag role="heading" aria-level={Math.min(Math.max(headingStart + i + 1 - topHeading, headingStart), 6)}>{children}</Tag>])
      )),
    a: ({ href, children }) => {
      const file = href && files !== null ? fileLinkPath(href, files?.root) : null
      if (!file) return <a href={href} target="_blank" rel="noreferrer">{children}</a>
      return (
        <a
          href={href}
          title={file}
          onClick={(e) => {
            e.preventDefault()
            void attempt(() => api.openFile(file, e.ctrlKey || e.metaKey ? 'reveal' : 'open'))
          }}
        >
          {children}
        </a>
      )
    },
    pre: ({ node, children }) => {
      const code = node?.children[0]
      const classes = code?.type === 'element' ? String(code.properties.className ?? '') : ''
      // A ```mermaid block counts as complete once its fence closes, or the reply ends.
      if (code?.type === 'element' && isMermaidClass(code.properties.className)) {
        const complete = !streaming || node?.properties.dataMermaid !== 'open'
        return <MermaidBlock source={codeText(code).replace(/\n$/, '')} complete={complete}><pre>{children}</pre></MermaidBlock>
      }
      if (workspaceId && /\blanguage-(bash|sh|shell)\b/.test(classes) && code) {
        return <ShellSnippet workspaceId={workspaceId} command={codeText(code).replace(/\n$/, '')} disabled={streaming}><pre>{children}</pre></ShellSnippet>
      }
      const wrapped = code && wrapCode?.(codeText(code), <pre>{children}</pre>)
      if (wrapped) return wrapped
      if (codeTools && code) return <CodeBlock language={/\blanguage-([\w+#.-]+)/.exec(classes)?.[1] ?? ''} code={codeText(code).replace(/\n$/, '')}><pre>{children}</pre></CodeBlock>
      return <pre>{children}</pre>
    }
  }), [workspaceId, streaming, wrapCode, codeTools, headingStart, topHeading, files])
  return (
    <div className="markdown">
      <ReactMarkdown
        urlTransform={urlTransform}
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeMermaidFences, rehypeHighlight]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
