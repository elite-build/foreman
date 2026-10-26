import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'
import { DEFAULT_PROMPT_TEMPLATES, findTemplate, SETUP_REPO_TEMPLATE_ID } from '../src/shared/promptTemplates'
import { offerSetupHint } from '../src/shared/setupHint'
import type { Repo, Workspace } from '../src/shared/types'
import { tempDir } from './helpers'

const repo = (patch: Partial<Repo> = {}) => ({ id: 'r', name: 'app', ...patch }) as Repo
const ws = (id: string, patch: Partial<Workspace> = {}) => ({ id, repoId: 'r', state: 'ready', path: '/p', ...patch }) as Workspace

describe('Set up this repo template', () => {
  const template = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SETUP_REPO_TEMPLATE_ID)!

  it('is built in and proposes the settings file as a diff without changing the system', () => {
    expect(template.name).toBe('Set up this repo')
    expect(findTemplate(DEFAULT_PROMPT_TEMPLATES, 'set up this repo')).toMatchObject({ template: { id: SETUP_REPO_TEMPLATE_ID } })
    expect(template.body).toContain('.foreman/settings.toml')
    expect(template.body).toContain('diff')
    expect(template.body).toMatch(/Do not commit/)
    expect(template.body).toMatch(/Do not run commands that change the system/)
    for (const part of ['[scripts] setup', '[[checks]]', 'sensitive_paths']) expect(template.body).toContain(part)
    // Nothing in it starts by itself or sets a model or permissions.
    expect(template.startModel).toBeUndefined()
    expect(template.followUp).toBeUndefined()
  })

  it('reaches saved template lists once, and deleting it sticks', async () => {
    const dir = await tempDir()
    const saved = [{ id: 'mine', name: 'Mine', body: 'x' }]
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 1, repos: [], workspaces: [], sessions: [], settings: { promptTemplates: saved } }))
    const store = new Store(dir)
    await store.load()
    expect(store.state.settings.promptTemplates.map((t) => t.id)).toContain(SETUP_REPO_TEMPLATE_ID)
    store.state.settings.promptTemplates = saved
    store.flush()
    const again = new Store(dir)
    await again.load()
    expect(again.state.settings.promptTemplates.map((t) => t.id)).toEqual(['mine'])
  })
})

describe('the first-workspace hint', () => {
  const first = ws('w1')

  it('is offered on a repo with no settings file and one workspace', () => {
    expect(offerSetupHint(repo(), {}, [first], first)).toBe(true)
  })

  it('stays away once the repo has a settings file, was dismissed, or has had more workspaces', () => {
    expect(offerSetupHint(repo(), { sharedFile: '/p/.foreman/settings.toml' }, [first], first)).toBe(false)
    expect(offerSetupHint(repo({ setupHintDismissed: true }), {}, [first], first)).toBe(false)
    const second = ws('w2')
    expect(offerSetupHint(repo(), {}, [first, second], first)).toBe(false)
    expect(offerSetupHint(repo(), {}, [first, ws('old', { state: 'archived' })], first)).toBe(false)
  })

  it('waits for a workspace that is ready', () => {
    const setting = ws('w1', { state: 'setting-up' })
    expect(offerSetupHint(repo(), {}, [setting], setting)).toBe(false)
    expect(offerSetupHint(undefined, {}, [first], first)).toBe(false)
  })
})
