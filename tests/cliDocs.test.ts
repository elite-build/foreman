import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderDocs } from '../src/cli/docs'
import { repoSettingsByTab } from '../src/shared/repoSettingsSchema'
import { settingsByPage } from '../src/shared/settingsSchema'
import { commandName, visibleCommands } from '../src/shared/cliCommands'

const file = join(__dirname, '..', 'docs', 'cli.md')

describe('docs/cli.md', () => {
  it('lists every visible command and every settings key', () => {
    const docs = renderDocs()
    for (const c of visibleCommands()) expect(docs, commandName(c)).toContain(`### foreman ${commandName(c)}\n`)
    for (const g of settingsByPage()) for (const s of g.specs) expect(docs, s.key).toContain(s.key)
    for (const g of repoSettingsByTab()) for (const s of g.specs) expect(docs, s.key).toContain(s.key)
    expect(docs).not.toMatch(/[A-Z]:\Users|\/Users\//)
  })

  // `npm run docs:cli` runs this one with FOREMAN_WRITE_DOCS=1.
  it.runIf(!process.env.FOREMAN_WRITE_DOCS)('is up to date', () => {
    const committed = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    expect(committed === renderDocs(), 'docs/cli.md is stale: run `npm run docs:cli`').toBe(true)
  })

  it.runIf(!!process.env.FOREMAN_WRITE_DOCS)('writes docs/cli.md', () => {
    writeFileSync(file, renderDocs())
  })
})
