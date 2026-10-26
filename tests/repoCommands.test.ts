import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverClaudeCommands } from '../src/main/agents/claude'
import { commandText, filterCommands, repoCommands } from '../src/shared/repoCommands'
import { tempDir } from './helpers'

async function put(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
}

describe('Claude commands and skills discovery', () => {
  it('lists repo and home commands and skills; a repo command shadows a home one of the same name', async () => {
    const repo = await tempDir('foreman-cmds-')
    const home = await tempDir('foreman-home-')
    await put(path.join(repo, '.claude/commands/review-ipc.md'), '---\ndescription: Check IPC contract changes\n---\nbody')
    await put(path.join(repo, '.claude/commands/frontend/lint.md'), 'Lint the frontend')
    await put(path.join(repo, '.claude/skills/electron-debug/SKILL.md'), '---\nname: electron-debug\ndescription: Attach to the main process\n---\n')
    await put(path.join(repo, '.claude/skills/no-skill-file/README.md'), 'not a skill')
    await put(path.join(home, '.claude/commands/review-ipc.md'), 'home version')
    await put(path.join(home, '.claude/commands/standup.md'), 'Write my standup')
    const found = (await discoverClaudeCommands(repo, home)).sort((a, b) => a.name.localeCompare(b.name))
    expect(found).toEqual([
      { name: 'electron-debug', description: 'Attach to the main process', kind: 'skill', source: 'repo' },
      { name: 'frontend:lint', description: 'Lint the frontend', kind: 'command', source: 'repo' },
      { name: 'review-ipc', description: 'Check IPC contract changes', kind: 'command', source: 'repo' },
      { name: 'standup', description: 'Write my standup', kind: 'command', source: 'home' }
    ])
  })

  it('finds nothing in a repo without a .claude folder', async () => {
    expect(await discoverClaudeCommands(await tempDir('foreman-cmds-'), await tempDir('foreman-home-'))).toEqual([])
  })
})

describe('Repo commands in the picker', () => {
  const list = [
    { name: 'clear', description: 'Clear the chat' },
    { name: 'review-ipc', description: 'Check IPC contract changes', kind: 'command' as const, source: 'repo' as const },
    { name: 'electron-debug', description: 'Attach to the main process', kind: 'skill' as const, source: 'repo' as const }
  ]

  it('is hidden for other agents and leaves out built-ins', () => {
    expect(repoCommands('claude', list).map((c) => c.name)).toEqual(['review-ipc', 'electron-debug'])
    for (const agent of ['codex', 'cursor', 'opencode'] as const) expect(repoCommands(agent, list)).toEqual([])
  })

  it('filters by words and inserts only the name', () => {
    expect(filterCommands(repoCommands('claude', list), '/ipc').map((c) => c.name)).toEqual(['review-ipc'])
    expect(filterCommands(repoCommands('claude', list), 'main process').map((c) => c.name)).toEqual(['electron-debug'])
    expect(commandText({ name: 'review-ipc' })).toBe('/review-ipc ')
  })
})
