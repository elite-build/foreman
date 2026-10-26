import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareBlock, compareBlockFor } from '../src/shared/compare'

const ws = { id: 'w1', state: 'ready' as const, path: '/tmp/w1' }
const tab = (id: string, workspaceId: string, status: string) => ({ id, workspaceId, status: status as 'idle', queue: [], title: id }) as never

describe('compareBlockFor (selector-safe)', () => {
  const sessions = [tab('a', 'w1', 'idle'), tab('b', 'w2', 'running')]
  it('only looks at the workspace tabs and returns a primitive, so repeated store reads are identical', () => {
    expect(compareBlockFor(ws, sessions)).toBeNull()
    expect(Object.is(compareBlockFor(ws, sessions), compareBlockFor(ws, [...sessions]))).toBe(true)
    const busy = [tab('a', 'w1', 'running')]
    expect(compareBlockFor(ws, busy)).toBe(compareBlock(ws, busy))
    expect(typeof compareBlockFor(ws, busy)).toBe('string')
  })
})

// React error #185 (blank window): useSyncExternalStore loops when a selector returns a new array/object on every read.
describe('renderer store selectors', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []))
  it('never build a fresh array or Map inside a useStore selector', () => {
    const bad: string[] = []
    for (const file of walk('src/renderer/src')) {
      for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        const m = /useStore\(\(\w+\) => (.*)\)$/.exec(line)
        if (m && /\.(filter|map|slice|sort|flatMap)\(|new Map|new Set|\[\.\.\./.test(m[1]) && !/\.(length|join)\b|\.some\(|\.find\(/.test(m[1].replace(/\.(filter|map)\([^)]*\)\.(length)/, ''))) bad.push(`${file}:${i + 1}`)
      }
    }
    expect(bad).toEqual([])
  })
})
