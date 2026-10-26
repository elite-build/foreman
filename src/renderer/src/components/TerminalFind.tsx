import type { ISearchOptions, SearchAddon } from '@xterm/addon-search'
import { ArrowDown, ArrowUp, CaseSensitive, Regex, Search, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { findStatus, validRegex } from '../../../shared/terminalTabs'
import { useT } from '../i18n'
import { terminalSearchColors } from '../theme'
import { IconButton, TextInput } from '../ui'

/**
 * Find in a terminal's output (O3): the chat's find bar, floating at the terminal's top right. Match case,
 * regex, "3 of 12", Enter / Shift+Enter to step, Esc to close. It searches what the scrollback still holds.
 */
export function TerminalFind({ search, focusRequest, onClose }: {
  search: SearchAddon
  // Bumped by ⌘F while open: focus and select the query again.
  focusRequest: number
  onClose: () => void
}) {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  const [term, setTerm] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [result, setResult] = useState({ index: -1, count: 0 })
  const searchable = Boolean(term) && (!regex || validRegex(term))

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusRequest])

  useEffect(() => {
    const sub = search.onDidChangeResults(({ resultIndex, resultCount }) => setResult({ index: resultIndex, count: resultCount }))
    return () => {
      sub.dispose()
      try {
        search.clearDecorations()
      } catch {
        // The terminal (and its addons) went first.
      }
    }
  }, [search])

  const options = (incremental: boolean): ISearchOptions => ({ caseSensitive, regex, incremental, decorations: terminalSearchColors() })
  const step = (direction: 1 | -1) => {
    if (!searchable) return
    if (direction === 1) search.findNext(term, options(false))
    else search.findPrevious(term, options(false))
  }

  // Typing (or a changed option) searches from the current match onwards.
  useEffect(() => {
    if (!searchable) {
      search.clearDecorations()
      setResult({ index: -1, count: 0 })
      return
    }
    search.findNext(term, { caseSensitive, regex, incremental: true, decorations: terminalSearchColors() })
  }, [search, term, caseSensitive, regex, searchable])

  const close = () => {
    search.clearDecorations()
    onClose()
  }
  const toggle = (on: boolean, set: (on: boolean) => void, label: string, icon: ReactNode) => (
    <IconButton pressed={on} label={label} onClick={() => set(!on)}>
      {icon}
    </IconButton>
  )

  return (
    <div className="chat-search term-find" role="search" aria-label={t('terminal.find.label')}>
      <Search size={14} className="faint" />
      <TextInput
        ref={input}
        mono
        bare
        aria-label={t('terminal.find.label')}
        placeholder={t('terminal.find.placeholder')}
        spellCheck={false}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
        }}
      />
      {toggle(caseSensitive, setCaseSensitive, t('terminal.find.matchCase'), <CaseSensitive size={15} />)}
      {toggle(regex, setRegex, t('terminal.find.regex'), <Regex size={14} />)}
      <span className="term-find-sep" />
      <span className="faint small search-count" role="status">
        {findStatus({ term, regex, index: result.index, count: result.count }, t)}
      </span>
      <IconButton label={t('terminal.find.previous')} disabled={!searchable || !result.count} onClick={() => step(-1)}>
        <ArrowUp size={14} />
      </IconButton>
      <IconButton label={t('terminal.find.next')} disabled={!searchable || !result.count} onClick={() => step(1)}>
        <ArrowDown size={14} />
      </IconButton>
      <IconButton label={t('terminal.find.close')} onClick={close}>
        <X size={14} />
      </IconButton>
    </div>
  )
}
