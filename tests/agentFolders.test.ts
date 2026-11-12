// docs/agents.md, 2.2: an agent that can hold a chat is one adapter folder, one catalog file, its fixtures and a doc
// section. This fails when a listed agent lacks any of them. Full agents have a folder of their own under
// src/main/agents/<id>/; the generic ACP chat agents share src/main/agents/acp/ (and its fixtures).
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_CATALOG, CHAT_AGENT_IDS, FULL_AGENT_IDS, catalogAgent, staticCapabilities } from '../src/shared/agentCatalog'

const AGENTS = 'src/main/agents'
const CATALOG = 'src/shared/agentCatalog'
const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory()

/** The text of section 12 ("Per-agent reference") of docs/agents.md. */
function referenceSection(): string {
  const doc = readFileSync('docs/agents.md', 'utf8').replace(/\r\n/g, '\n')
  const start = doc.indexOf('\n## 12.')
  if (start < 0) return ''
  const end = doc.indexOf('\n## ', start + 1)
  return doc.slice(start, end < 0 ? undefined : end)
}

const chatCapable = [...FULL_AGENT_IDS, ...CHAT_AGENT_IDS]

describe('agent folders', () => {
  it('lists every agent that can hold a chat in the catalog', () => {
    expect(AGENT_CATALOG.filter((a) => a.level !== 'terminal').map((a) => a.id).sort()).toEqual([...chatCapable].sort())
  })

  describe.each(chatCapable.map((id) => [id]))('%s', (id) => {
    const full = (FULL_AGENT_IDS as readonly string[]).includes(id)

    it('has a catalog entry and a capability record', () => {
      expect(catalogAgent(id)).toBeDefined()
      expect(staticCapabilities(id)).toBeDefined()
    })

    if (full) {
      it('has an adapter folder with an index and a fixtures folder', () => {
        expect(existsSync(join(AGENTS, id, 'index.ts'))).toBe(true)
        expect(isDir(join(AGENTS, id, 'fixtures'))).toBe(true)
      })
      it('has a catalog file of its own', () => {
        expect(existsSync(join(CATALOG, `${id}.ts`))).toBe(true)
      })
    } else {
      it('is covered by the ACP adapter folder and its fixtures', () => {
        expect(existsSync(join(AGENTS, 'acp', 'index.ts'))).toBe(true)
        expect(isDir(join(AGENTS, 'acp', 'fixtures'))).toBe(true)
        expect(catalogAgent(id)?.acp).toBeDefined()
      })
    }

    it('has a section in docs/agents.md, section 12', () => {
      const heading = `### ${catalogAgent(id)!.name}`
      expect(referenceSection().split('\n').map((line) => line.trimEnd())).toContain(heading)
    })

    // The section names the versions its catalog file was recorded with, so it can't say one thing while the fixtures say another.
    it('names in its section the versions its fixtures were recorded with', () => {
      const lines = referenceSection().split('\n')
      const at = lines.findIndex((line) => line.trimEnd() === `### ${catalogAgent(id)!.name}`)
      const next = lines.findIndex((line, i) => i > at && line.startsWith('### '))
      const text = lines.slice(at, next < 0 ? undefined : next).join('\n')
      const tested = catalogAgent(id)?.versions?.tested ?? []
      for (const version of tested) expect(text, `${id} ${version}`).toContain(version)
      if (full && tested.length === 0) expect(text).toMatch(/Tested:.*(no version|none)/i)
    })
  })

  it('keeps the ACP chat agents in one catalog file', () => {
    expect(existsSync(join(CATALOG, 'acpAgents.ts'))).toBe(true)
    expect(existsSync(join(CATALOG, 'terminalAgents.ts'))).toBe(true)
  })
})
