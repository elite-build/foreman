// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Tree, TreeItem, type TreeNodeRow } from '../../src/renderer/src/ui/Tree'

afterEach(cleanup)

// src/ (open) > main/ (closed), shared/ (open) > types.ts, then README.md at the top.
const FILES = [
  { path: 'src', dir: true, depth: 0 },
  { path: 'src/main', dir: true, depth: 1 },
  { path: 'src/shared', dir: true, depth: 1 },
  { path: 'src/shared/types.ts', dir: false, depth: 2 },
  { path: 'README.md', dir: false, depth: 0 }
]

function Demo({ onOpen = () => {}, selected }: { onOpen?: (path: string) => void; selected?: string }) {
  const [expanded, setExpanded] = useState(new Set(['src', 'src/shared']))
  const rows: TreeNodeRow[] = []
  const visible = (path: string) => path.split('/').slice(0, -1).every((_, i, parts) => expanded.has(parts.slice(0, i + 1).join('/')))
  for (const f of FILES) if (visible(f.path)) rows.push({ ...f, expanded: f.dir ? expanded.has(f.path) : undefined })
  return (
    <>
      <button>Before</button>
      <Tree
        label="Files"
        rows={rows}
        onOpen={onOpen}
        onToggle={(path) =>
          setExpanded((s) => {
            const next = new Set(s)
            if (!next.delete(path)) next.add(path)
            return next
          })
        }
      >
        {rows.map((r) => (
          <TreeItem key={r.path} path={r.path} selected={r.path === selected}>
            <span>{r.path.split('/').pop()}</span>
          </TreeItem>
        ))}
      </Tree>
    </>
  )
}

const focused = () => document.activeElement?.textContent

describe('Tree', () => {
  it('is a named tree of treeitems with level, expanded and selected state', () => {
    render(<Demo selected="README.md" />)
    expect(screen.getByRole('tree', { name: 'Files' })).toBeTruthy()
    const items = screen.getAllByRole('treeitem')
    expect(items.map((i) => i.getAttribute('aria-level'))).toEqual(['1', '2', '2', '3', '1'])
    expect(screen.getByRole('treeitem', { name: 'src' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('treeitem', { name: 'main' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('treeitem', { name: 'types.ts' }).hasAttribute('aria-expanded')).toBe(false)
    expect(screen.getByRole('treeitem', { name: 'README.md' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('treeitem', { name: 'src' }).getAttribute('aria-selected')).toBe('false')
  })

  it('has one tab stop, the first row until focus moves; Tab leaves the tree', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    const stops = screen.getAllByRole('treeitem').filter((i) => i.tabIndex === 0)
    expect(stops.map((i) => i.textContent)).toEqual(['src'])
    await user.tab()
    await user.tab()
    expect(focused()).toBe('src')
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(focused()).toBe('shared')
    // The tab stop followed focus.
    expect(screen.getAllByRole('treeitem').filter((i) => i.tabIndex === 0).map((i) => i.textContent)).toEqual(['shared'])
    await user.tab({ shift: true })
    expect(focused()).toBe('Before')
  })

  it('↑ ↓ Home End move between rows', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    screen.getByRole('treeitem', { name: 'src' }).focus()
    await user.keyboard('{End}')
    expect(focused()).toBe('README.md')
    await user.keyboard('{ArrowUp}')
    expect(focused()).toBe('types.ts')
    await user.keyboard('{Home}')
    expect(focused()).toBe('src')
  })

  it('→ opens a closed folder, then steps into it; ← closes an open folder, then steps out to the parent', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    screen.getByRole('treeitem', { name: 'main' }).focus()
    // main is empty and closed: → opens it, and there is nothing inside to step into.
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('treeitem', { name: 'main' }).getAttribute('aria-expanded')).toBe('true')
    await user.keyboard('{ArrowRight}')
    expect(focused()).toBe('main')
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('treeitem', { name: 'main' }).getAttribute('aria-expanded')).toBe('false')
    await user.keyboard('{ArrowLeft}')
    expect(focused()).toBe('src')
    // From an open folder, → steps to its first child.
    await user.keyboard('{ArrowRight}')
    expect(focused()).toBe('main')
  })

  it('Enter and Space toggle a folder and open a file', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<Demo onOpen={onOpen} />)
    screen.getByRole('treeitem', { name: 'shared' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('treeitem', { name: 'types.ts' })).toBeNull()
    await user.keyboard(' ')
    expect(screen.getByRole('treeitem', { name: 'types.ts' })).toBeTruthy()
    screen.getByRole('treeitem', { name: 'types.ts' }).focus()
    await user.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledWith('src/shared/types.ts')
  })

  it('clicking a row focuses it and acts on it', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<Demo onOpen={onOpen} />)
    await user.click(screen.getByRole('treeitem', { name: 'README.md' }))
    expect(onOpen).toHaveBeenCalledWith('README.md')
    expect(focused()).toBe('README.md')
    await user.click(screen.getByRole('treeitem', { name: 'src' }))
    expect(screen.queryByRole('treeitem', { name: 'main' })).toBeNull()
  })

  it('types ahead to a row by name', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    screen.getByRole('treeitem', { name: 'src' }).focus()
    await user.keyboard('r')
    expect(focused()).toBe('README.md')
  })

  it('types ahead to a nested row, matching the last part of its path', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    screen.getByRole('treeitem', { name: 'src' }).focus()
    await user.keyboard('t')
    expect(focused()).toBe('types.ts')
  })

  it('leaves keys alone when they come from a control inside a row', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(
      <Tree label="T" rows={[{ path: 'a', dir: true, depth: 0, expanded: false }]} onOpen={() => {}} onToggle={onToggle}>
        <TreeItem path="a">
          a<span role="textbox" tabIndex={-1} />
        </TreeItem>
      </Tree>
    )
    screen.getByRole('textbox').focus()
    await user.keyboard('{Enter}{ArrowRight}')
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('fails loudly when a TreeItem has no row, or no Tree', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() =>
      render(
        <Tree label="T" rows={[]} onOpen={() => {}} onToggle={() => {}}>
          <TreeItem path="missing">x</TreeItem>
        </Tree>
      )
    ).toThrow(/not in the Tree's rows/)
    cleanup()
    expect(() => render(<TreeItem path="a">x</TreeItem>)).toThrow(/inside a Tree/)
    error.mockRestore()
  })
})
