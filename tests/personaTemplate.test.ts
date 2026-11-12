// docs/persona-template.md: the persona documents it shows (the ten starters rewritten with the template) must read
// as personas, with no problems and no warnings, and end the way the template says, so the page can't drift from the
// parser or from what a flow run reads back.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePersona, type Persona } from '../src/shared/personas'
import { PERSONA_STARTERS } from '../src/shared/personaStarters'

// A Windows checkout with core.autocrlf=true has CRLF line endings.
const doc = readFileSync(join(__dirname, '..', 'docs', 'persona-template.md'), 'utf8').replace(/\r\n/g, '\n')
const documents = [...doc.matchAll(/```md\n([\s\S]*?)```/g)].map((m) => m[1])

describe('docs/persona-template.md', () => {
  const read = (markdown: string): Persona => {
    const parsed = parsePersona(markdown, 'built-in')
    expect('problems' in parsed ? parsed.problems : [], markdown.slice(0, 40)).toEqual([])
    expect(parsed.warnings, markdown.slice(0, 40)).toEqual([])
    return (parsed as { persona: Persona }).persona
  }

  it('shows every starter, rewritten, and each reads with no problems or warnings', () => {
    const personas = documents.map(read)
    expect(personas.map((p) => p.name)).toEqual(PERSONA_STARTERS.map((s) => s.name))
    for (const p of personas) expect(p.description, p.name).toBeTruthy()
  })

  it('is the shipped starters, word for word', () => {
    expect(documents).toEqual(PERSONA_STARTERS.map((s) => s.markdown))
  })

  it('ends a reviewer with the findings block and a turn with a report, in the template’s words', () => {
    for (const p of documents.map(read)) {
      const body = p.instructions
      expect(body.split('\n').length, p.name).toBeLessThanOrEqual(10)
      if (p.read_only && p.name !== 'architect') {
        expect(p.ends_with, p.name).toEqual(['findings'])
        expect(body, p.name).toContain('`foreman-findings` block')
        expect(body, p.name).toContain('`[]` when')
        expect(body, p.name).toContain('titled "Blocked: …"')
        expect(body, p.name).not.toMatch(/foreman review|say `done`/i)
      } else {
        expect(body, p.name).toMatch(/report `done`|report `needs-input`/i)
        expect(body, p.name).toContain('`Status: ')
        expect(body, p.name).toContain('`report` tool')
        if (p.writes) expect(body, p.name).toContain('(this step has no shell)')
      }
    }
  })
})
