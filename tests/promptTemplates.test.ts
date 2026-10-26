import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defaultSettings, Store } from '../src/main/store'
import { DEFAULT_PROMPT_TEMPLATES, filterTemplates, findTemplate, insertTemplate } from '../src/shared/promptTemplates'
import { tempDir } from './helpers'

const t = (name: string, body: string) => ({ id: name, name, body })

describe('prompt templates', () => {
  it('ships defaults in new settings', () => {
    expect(defaultSettings().promptTemplates).toEqual(DEFAULT_PROMPT_TEMPLATES)
    expect(new Set(DEFAULT_PROMPT_TEMPLATES.map((d) => d.id)).size).toBe(DEFAULT_PROMPT_TEMPLATES.length)
  })

  it('adds the issue template to saved lists once', async () => {
    const dir = await tempDir()
    const saved = [{ id: 'mine', name: 'Mine', body: 'x' }]
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 1, repos: [], workspaces: [], sessions: [], settings: { promptTemplates: saved } }))
    const store = new Store(dir)
    await store.load()
    expect(store.state.settings.promptTemplates.map((x) => x.id)).toEqual(['mine', 'default-fix-issue', 'default-setup-repo'])
    expect(findTemplate(store.state.settings.promptTemplates, 'issue')).toMatchObject({ template: { id: 'default-fix-issue' } })

    // Deleting it afterwards sticks.
    store.state.settings.promptTemplates = saved
    store.flush()
    const again = new Store(dir)
    await again.load()
    expect(again.state.settings.promptTemplates.map((x) => x.id)).toEqual(['mine'])
  })

  it('filters by every word, name matches first', () => {
    const list = [t('Write tests', 'cover edge cases'), t('Refactor', 'then write tests'), t('Explain', 'how it works')]
    expect(filterTemplates(list, '').map((x) => x.name)).toEqual(['Write tests', 'Refactor', 'Explain'])
    expect(filterTemplates(list, 'tests').map((x) => x.name)).toEqual(['Write tests', 'Refactor'])
    expect(filterTemplates(list, 'WRITE  edge').map((x) => x.name)).toEqual(['Write tests'])
    expect(filterTemplates(list, 'nothing')).toEqual([])
  })

  it('fills an empty composer and selects the first placeholder', () => {
    const body = 'Fix {{bug}} in {{file}}'
    const result = insertTemplate('', 0, 0, body)
    expect(result.text).toBe(body)
    expect(result.text.slice(...result.selection)).toBe('{{bug}}')
  })

  it('puts the cursor at the end without placeholders', () => {
    expect(insertTemplate('', 0, 0, 'Review it').selection).toEqual([9, 9])
  })

  it('replaces the selection and keeps the template on its own lines', () => {
    const result = insertTemplate('before XX after', 7, 9, 'Do {{x}}')
    expect(result.text).toBe('before \n\nDo {{x}}\n\n after')
    expect(result.text.slice(...result.selection)).toBe('{{x}}')
    expect(insertTemplate('line\n', 5, 5, 'Do it').text).toBe('line\nDo it')
  })
})
