import { describe, expect, it } from 'vitest'
import { axWarnings, checkAxTree, diffAxTrees, flattenAx, reduceAxTree, type AxNode, type CdpAxNode } from '../src/main/axTree'

const cdp = (nodeId: string, role: string, name: string, extra: Partial<CdpAxNode> = {}): CdpAxNode => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  ...extra
})
const prop = (name: string, value: unknown) => ({ name, value: { value } })
const node = (role: string, name = '', extra: Partial<AxNode> = {}): AxNode => ({ role, name, children: [], ...extra })

describe('reduceAxTree', () => {
  const nodes: CdpAxNode[] = [
    cdp('1', 'RootWebArea', 'Foreman', { childIds: ['2', '3', '9'] }),
    cdp('2', 'generic', '', { parentId: '1', childIds: ['4', '5'] }),
    cdp('3', 'main', '', { parentId: '1', childIds: ['6'] }),
    cdp('4', 'button', ' Save ', { parentId: '2', properties: [prop('focusable', true)] }),
    cdp('5', 'StaticText', 'Save', { parentId: '2' }),
    cdp('6', 'heading', 'Chat', { parentId: '3', properties: [prop('level', 2)] }),
    cdp('9', 'button', 'hidden', { parentId: '1', ignored: true })
  ]

  it('drops generic, text and ignored nodes and moves their children up', () => {
    expect(reduceAxTree(nodes)).toEqual([
      {
        role: 'RootWebArea',
        name: 'Foreman',
        children: [
          { role: 'button', name: 'Save', focusable: true, children: [] },
          { role: 'main', name: '', children: [{ role: 'heading', name: 'Chat', level: 2, children: [] }] }
        ]
      }
    ])
  })

  it('omits level and focusable when absent, and survives a child cycle', () => {
    const looped = [cdp('1', 'group', 'a', { childIds: ['2'] }), cdp('2', 'group', 'b', { parentId: '1', childIds: ['1'] })]
    const [root] = reduceAxTree(looped)
    expect(root).toEqual({ role: 'group', name: 'a', children: [{ role: 'group', name: 'b', children: [] }] })
    expect('level' in root).toBe(false)
  })

  it('treats a missing role or name as empty', () => {
    expect(reduceAxTree([{ nodeId: '1', role: { value: 'button' } }])).toEqual([{ role: 'button', name: '', children: [] }])
    expect(reduceAxTree([{ nodeId: '1' }])).toEqual([])
  })
})

describe('checkAxTree', () => {
  it('reports focusable nodes without a name, not named ones, the web area or table rows (read by their cells)', () => {
    const tree = [node('RootWebArea', '', { focusable: true, children: [node('button', '', { focusable: true }), node('button', 'OK', { focusable: true }), node('image', ''), node('row', '', { focusable: true })] })]
    const report = checkAxTree(tree)
    expect(report.unnamedFocusable).toEqual([{ role: 'button' }])
  })

  it('finds a heading level skip in document order, but not a first heading at h2 or a drop back', () => {
    const clean = [node('main', '', { children: [node('heading', 'a', { level: 2 }), node('heading', 'b', { level: 3 }), node('heading', 'c', { level: 2 }), node('heading', 'd', { level: 3 })] })]
    expect(checkAxTree(clean).headingSkips).toEqual([])
    const skipped = [node('main', '', { children: [node('heading', 'a', { level: 2 }), node('group', '', { children: [node('heading', 'deep', { level: 4 })] })] })]
    expect(checkAxTree(skipped).headingSkips).toEqual([{ from: 2, to: 4, name: 'deep' }])
  })

  it('counts main landmarks', () => {
    expect(checkAxTree([node('main'), node('main')]).mainCount).toBe(2)
    expect(checkAxTree([node('banner')]).mainCount).toBe(0)
  })
})

describe('axWarnings', () => {
  it('is empty for a clean screen', () => {
    expect(axWarnings(checkAxTree([node('main', '', { children: [node('heading', 'h', { level: 2 })] })]))).toEqual([])
  })

  it('words each problem', () => {
    const tree = [node('button', '', { focusable: true }), node('heading', 'x', { level: 1 }), node('heading', 'y', { level: 3 })]
    const warnings = axWarnings(checkAxTree(tree))
    expect(warnings).toEqual(['1 focusable without a name (button x1)', 'heading level skips from h1 to h3: "y"', '0 main landmarks (expected 1)'])
  })
})

describe('diffAxTrees', () => {
  it('lists added and removed role and name pairs', () => {
    const a = [node('main', '', { children: [node('button', 'Run'), node('heading', 'Old', { level: 2 })] })]
    const b = [node('main', '', { children: [node('button', 'Run'), node('button', 'Stop'), node('heading', 'New', { level: 2 })] })]
    expect(diffAxTrees(a, b)).toEqual({ added: ['button "Stop"', 'heading "New"'], removed: ['heading "Old"'] })
  })

  it('counts duplicates and is empty for identical trees', () => {
    const one = [node('button', 'Go')]
    const two = [node('button', 'Go'), node('button', 'Go')]
    expect(diffAxTrees(one, two)).toEqual({ added: ['button "Go"'], removed: [] })
    expect(diffAxTrees(two, two)).toEqual({ added: [], removed: [] })
  })
})

describe('flattenAx', () => {
  it('walks in document order', () => {
    const tree = [node('a', '', { children: [node('b', '', { children: [node('c')] }), node('d')] }), node('e')]
    expect(flattenAx(tree).map((n) => n.role)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})
