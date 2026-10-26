import { ArrowDown, ArrowUp, Search, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { ChatItem } from '../../../shared/types'
import { getState, sendUiCommand } from '../store'
import { chatSearchRanges, revealChatMatch } from './findInChat'
import { useT } from '../i18n'
import { IconButton, TextInput } from '../ui'

export function ChatSearch({
  root,
  items,
  active,
  workspaceId,
  query,
  onQuery
}: {
  root: RefObject<HTMLDivElement | null>
  items: ChatItem[]
  active: boolean
  workspaceId: string
  query: string
  onQuery: (query: string) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const [count, setCount] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const name = `chat-search-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  const close = () => {
    setOpen(false)
    onQuery('')
    sendUiCommand('focus-composer', workspaceId)
  }
  const move = (delta: number) => setIndex((i) => (count ? (i + delta + count) % count : 0))

  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      const state = getState()
      if (state.overlay || state.settingsPage || state.newWorkspaceRepo || state.addRepoDialog || state.archiveTarget) return
      const mod = state.snapshot?.platform === 'darwin' ? event.metaKey : event.ctrlKey
      // A terminal and its find bar (O3) keep ⌘F, ⌘G and Esc for themselves.
      if ((event.target as Element | null)?.closest?.('.terminal, .term-find')) return
      if (mod && !event.altKey && !event.shiftKey && event.code === 'KeyF') {
        event.preventDefault()
        event.stopImmediatePropagation()
        setOpen(true)
        requestAnimationFrame(() => {
          input.current?.focus()
          input.current?.select()
        })
      } else if (open && ((mod && !event.altKey && event.code === 'KeyG') || event.key === 'Escape')) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (event.key === 'Escape') close()
        else move(event.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  useLayoutEffect(() => {
    CSS.highlights.delete(name)
    CSS.highlights.delete(`${name}-current`)
    if (!root.current || !active || !open) return
    const found = chatSearchRanges(root.current, query)
    setCount(found.length)
    const current = Math.min(index, Math.max(found.length - 1, 0))
    if (current !== index) setIndex(current)
    const all = new Highlight()
    for (const range of found) all.add(range)
    const selected = new Highlight(...(found[current] ? [found[current]] : []))
    // Each mounted chat owns its highlights; switching tabs clears only its own.
    CSS.highlights.set(name, all)
    CSS.highlights.set(`${name}-current`, selected)
    const style = document.createElement('style')
    style.textContent = `::highlight(${name}) { background: color-mix(in srgb, var(--amber) 33%, transparent); color: inherit; } ::highlight(${name}-current) { background: var(--amber); color: var(--bg); }`
    document.head.append(style)
    if (found[current]) revealChatMatch(found[current], root.current)
    return () => {
      CSS.highlights.delete(name)
      CSS.highlights.delete(`${name}-current`)
      style.remove()
    }
  }, [root, items, query, index, active, open, name])

  if (!open) return null
  return (
    <div className="chat-search" role="search" aria-label={t('chatFind.label')}>
      <Search size={14} className="faint" />
      <TextInput
        ref={input}
        aria-label={t('chatFind.label')}
        placeholder={t('chatFind.placeholder')}
        value={query}
        onChange={(e) => {
          onQuery(e.target.value)
          setIndex(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            move(e.shiftKey ? -1 : 1)
          }
        }}
      />
      <span className="faint small search-count" role="status">
        {query ? (count ? t('terminal.find.count', { index: Math.min(index + 1, count), count }) : t('terminal.find.none')) : ''}
      </span>
      <IconButton label={t('terminal.find.previous')} disabled={!count} onClick={() => move(-1)}>
        <ArrowUp size={14} />
      </IconButton>
      <IconButton label={t('terminal.find.next')} disabled={!count} onClick={() => move(1)}>
        <ArrowDown size={14} />
      </IconButton>
      <IconButton label={t('chatFind.close')} onClick={close}>
        <X size={14} />
      </IconButton>
    </div>
  )
}
