import { memo, useMemo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { MermaidBlock } from './MermaidBlock'
import { isMermaidClass, rehypeMermaidFences } from './mermaidSource'
import { ShellSnippet } from './ShellSnippet'

function codeText(node: { type: string; value?: string; children?: unknown[] }): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map((child) => codeText(child as Parameters<typeof codeText>[0])).join('')
}

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

// Links open in the system browser (the main process intercepts new windows).
// `wrapCode` may wrap a fenced block (given its text and the block): the assistant puts a Copy chip on `foreman` commands.
// `headingStart`: the outline level a `#` heading takes, for text an agent wrote inside a message (chat, assistant), so its
// headings sit below the message's own. `##` is one level deeper, down to 6 (a reader has no level 7). The elements stay
// h1 to h6, so the headings look as they always did; `aria-level` gives the level a screen reader announces.
export const Markdown = memo(function Markdown({
  text,
  workspaceId,
  streaming = false,
  wrapCode,
  headingStart
}: {
  text: string
  workspaceId?: string
  streaming?: boolean
  wrapCode?: (code: string, block: ReactNode) => ReactNode | undefined
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
    a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
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
      return <pre>{children}</pre>
    }
  }), [workspaceId, streaming, wrapCode, headingStart, topHeading])
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeMermaidFences, rehypeHighlight]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
