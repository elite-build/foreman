import { createContext, useContext, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { treeKey, type TreeRow } from '../../../shared/fileTree'
import { createTypeahead, typeahead } from './keys'

// A tree of rows (the Files tab): one tab stop, ↑ ↓ Home End, → opens or steps in, ← closes or steps out,
// Enter and Space open a file or toggle a folder, and typing jumps to a row by name. The keys are `treeKey` from
// shared/fileTree.ts. The feature supplies the visible rows in order (`rows`) and one TreeItem per row with its
// content; anything that isn't a row (a "loading…" line) belongs outside the tree or as its own labelled element.

export type TreeNodeRow = TreeRow & {
  // What typeahead matches; defaults to the last part of the path.
  label?: string
}

type TreeContext = {
  rows: Map<string, TreeNodeRow>
  tabStop: string | undefined
  focus: (path: string) => void
  activate: (path: string) => void
  register: (path: string, el: HTMLElement | null) => void
}

const Context = createContext<TreeContext | null>(null)

export type TreeProps = Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'onKeyDown' | 'onToggle' | 'aria-label' | 'children'> & {
  // The tree's accessible name.
  label: string
  // Every visible row, top to bottom.
  rows: TreeNodeRow[]
  // A folder row was asked to open or close (click, Enter, → or ←).
  onToggle: (path: string) => void
  // A file row was asked to open (click or Enter).
  onOpen: (path: string) => void
  children: ReactNode
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function Tree({ label, rows, onToggle, onOpen, className, children, ...rest }: TreeProps) {
  const [focused, setFocused] = useState<string | null>(null)
  const els = useRef(new Map<string, HTMLElement>())
  const typed = useMemo(() => createTypeahead(), [])
  const byPath = useMemo(() => new Map(rows.map((r) => [r.path, r])), [rows])
  const tabStop = focused !== null && byPath.has(focused) ? focused : rows[0]?.path

  const focusRow = (path: string) => {
    setFocused(path)
    els.current.get(path)?.focus()
    els.current.get(path)?.scrollIntoView?.({ block: 'nearest' })
  }
  const activate = (path: string) => (byPath.get(path)?.dir ? onToggle(path) : onOpen(path))

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    // Keys on a control inside a row stay that control's.
    if (e.metaKey || e.ctrlKey || e.altKey || target.getAttribute('role') !== 'treeitem') return
    const index = rows.findIndex((r) => r.path === target.dataset.uiPath)
    if (index < 0) return
    const key = e.key === ' ' ? 'Enter' : e.key
    const move = treeKey(rows, index, key)
    if (move) {
      e.preventDefault()
      if ('focus' in move) focusRow(rows[move.focus].path)
      else if ('toggle' in move) onToggle(move.toggle)
      else onOpen(move.open)
      return
    }
    const query = typed.push(e.key)
    if (query === undefined) return
    const hit = typeahead(query, rows.map((r) => r.label ?? baseName(r.path)), index)
    if (hit !== undefined) {
      e.preventDefault()
      focusRow(rows[hit].path)
    }
  }

  const context: TreeContext = {
    rows: byPath,
    tabStop,
    focus: setFocused,
    activate,
    register: (path, el) => {
      if (el) els.current.set(path, el)
      else els.current.delete(path)
    }
  }

  return (
    <div {...rest} role="tree" aria-label={label} className={['ui-tree', className].filter(Boolean).join(' ')} onKeyDown={onKeyDown}>
      <Context value={context}>{children}</Context>
    </div>
  )
}

export type TreeItemProps = Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'tabIndex' | 'onClick' | 'onFocus' | 'aria-level' | 'aria-expanded' | 'aria-selected'> & {
  // Matches a row in the Tree's `rows`: depth, folder and open state come from there.
  path: string
  // The open file.
  selected?: boolean
}

export function TreeItem({ path, selected = false, className, style, children, ...rest }: TreeItemProps) {
  const tree = useContext(Context)
  if (!tree) throw new Error('TreeItem must be inside a Tree')
  const row = tree.rows.get(path)
  if (!row) throw new Error(`TreeItem path "${path}" is not in the Tree's rows`)
  return (
    <div
      {...rest}
      ref={(el) => {
        tree.register(path, el)
      }}
      role="treeitem"
      data-ui-path={path}
      data-dir={row.dir || undefined}
      data-selected={selected || undefined}
      aria-level={row.depth + 1}
      aria-expanded={row.dir ? Boolean(row.expanded) : undefined}
      aria-selected={selected}
      tabIndex={path === tree.tabStop ? 0 : -1}
      className={['ui-tree__item', className].filter(Boolean).join(' ')}
      style={{ ...style, '--d': row.depth } as CSSProperties}
      onFocus={(e: FocusEvent<HTMLDivElement>) => e.target === e.currentTarget && tree.focus(path)}
      onClick={() => {
        tree.focus(path)
        tree.activate(path)
      }}
    >
      {children}
    </div>
  )
}
