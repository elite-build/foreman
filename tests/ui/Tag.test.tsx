// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { Tag } from '../../src/renderer/src/ui/Tag'
import { readCss, ruleBody } from './cssRule'

afterEach(cleanup)

describe('Tag', () => {
  it('is a plain, non-interactive span', () => {
    const ref = createRef<HTMLSpanElement>()
    render(<Tag ref={ref}>r3</Tag>)
    const el = screen.getByText('r3')
    expect(el.tagName).toBe('SPAN')
    expect(el.className).toBe('ui-tag')
    expect(ref.current).toBe(el)
    expect(screen.queryByRole('button')).toBeNull()
    expect(el.querySelector('svg')).toBeNull()
  })

  it.each([
    ['accent', 'ui-tag ui-tag--accent'],
    ['outline', 'ui-tag ui-tag--outline']
  ] as const)('%s has no glyph', (tone, cls) => {
    render(<Tag tone={tone}>label</Tag>)
    const el = screen.getByText('label')
    expect(el.className).toBe(cls)
    expect(el.querySelector('svg')).toBeNull()
  })

  it.each(['ok', 'warn', 'error', 'info'] as const)('%s carries its glyph, hidden from assistive tech', (tone) => {
    render(<Tag tone={tone}>word</Tag>)
    const el = screen.getByText('word')
    expect(el.className).toBe(`ui-tag ui-tag--${tone}`)
    const svg = el.querySelector('svg')!
    expect(svg.getAttribute('data-glyph')).toBe(tone)
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    // The accessible text is the word alone.
    expect(el.textContent).toBe('word')
  })

  it('mono sets the code font and keeps the tag size', () => {
    render(<Tag tone="outline" mono>API_KEY</Tag>)
    expect(screen.getByText('API_KEY').className).toBe('ui-tag ui-tag--outline ui-tag--mono')
    const rule = ruleBody(readCss('tag'), '.ui-tag--mono') ?? ''
    expect(rule).toMatch(/font-family:\s*var\(--mono\)/)
    expect(rule).not.toMatch(/font-size/)
  })

  it('passes native props and a layout className through', () => {
    render(<Tag className="mine" title="why" data-x="1">t</Tag>)
    const el = screen.getByText('t')
    expect(el.className).toBe('ui-tag mine')
    expect(el.getAttribute('title')).toBe('why')
  })
})
