// #18 (G4): the remembered Diagram / Code view, and Copy as SVG's file text.
import { describe, expect, it } from 'vitest'
import { parseMermaidView, standaloneSvg } from '../src/renderer/src/components/mermaidSource'
import { createT } from '../src/shared/i18n'

describe('remembered view', () => {
  it('defaults to Diagram, and remembers Code', () => {
    expect(parseMermaidView(null)).toBe('diagram')
    expect(parseMermaidView('"code"')).toBe('code')
    expect(parseMermaidView('"diagram"')).toBe('diagram')
    expect(parseMermaidView('not json')).toBe('diagram')
    expect(parseMermaidView('"something"')).toBe('diagram')
  })
})

describe('Copy as SVG', () => {
  it('declares the SVG namespace and an XML header', () => {
    expect(standaloneSvg('<svg viewBox="0 0 10 10"><g/></svg>')).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g/></svg>')
  })

  it('keeps a namespace already there', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" id="m"><g/></svg>'
    expect(standaloneSvg(svg).endsWith(svg)).toBe(true)
    expect(standaloneSvg(svg).match(/xmlns=/g)).toHaveLength(1)
  })

  it('leaves anything that is not an SVG alone', () => {
    expect(standaloneSvg('<div></div>')).toBe('<div></div>')
  })

  it('has Spanish strings', () => {
    expect(createT('es')('mermaid.copySvg')).toBe('Copiar como SVG')
  })
})
