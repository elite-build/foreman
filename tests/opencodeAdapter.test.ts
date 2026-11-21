// The OpenCode adapter's own rules (docs/agents.md 3.3), apart from the recorded traffic (tests/replay/opencode.test.ts): the
// config each turn's server starts with, OpenCode's tools and questions in the chat's words, model ids, and what a missing
// binary looks like.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { opencodeDriver } from '../src/main/agents/opencode'
import { opencodeMcp, serveArgs, serverConfig } from '../src/main/agents/opencode/server'
import { modelParts } from '../src/main/agents/opencode/turn'
import { alwaysScope, cardQuestions, hiddenTool, questionAnswers, todoEntries, toolView } from '../src/main/agents/opencode/view'
import { callbacks, request } from './replay/harness'

const cwd = path.resolve('/work/repo')

describe('the server a turn starts', () => {
  it('listens on loopback only, on a port of its choosing', () => {
    expect(serveArgs()).toEqual(['serve', '--hostname=127.0.0.1', '--port=0'])
  })

  it('under Ask and Ask except edits, asks Foreman before anything that changes or reaches out, and lets reads through', () => {
    for (const approvals of ['ask', 'ask-except-edits'] as const) {
      const config = JSON.parse(serverConfig({ approvals, cwd, env: {} }))
      expect(config.permission['*']).toBe('ask')
      for (const tool of ['read', 'glob', 'grep', 'list', 'todowrite', 'task', 'question']) expect(config.permission[tool], tool).toBe('allow')
      for (const tool of ['edit', 'bash', 'webfetch']) expect(config.permission[tool], tool).toBeUndefined()
    }
  })

  it('under Never ask, leaves the person’s own permissions as they are', () => {
    expect(JSON.parse(serverConfig({ approvals: 'never-ask', cwd, env: {} }))).not.toHaveProperty('permission')
  })

  it('keeps what OPENCODE_CONFIG_CONTENT already held underneath, and replaces what isn’t JSON', () => {
    const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: 'dark', permission: { bash: { 'rm *': 'deny' } } }) }
    const config = JSON.parse(serverConfig({ approvals: 'ask', cwd, env }))
    expect(config.theme).toBe('dark')
    expect(config.permission.bash).toEqual({ 'rm *': 'deny' })
    expect(config.permission['*']).toBe('ask')
    expect(JSON.parse(serverConfig({ approvals: 'never-ask', cwd, env: { OPENCODE_CONFIG_CONTENT: 'not json' } }))).toEqual({})
  })

  it('gives it the repository’s approved MCP servers as local ones, with only their declared variables', () => {
    const servers = { echo: { command: process.execPath, args: ['server.js'], env: { TOKEN: 'repo-token' } } }
    const config = JSON.parse(serverConfig({ approvals: 'never-ask', mcpServers: servers, cwd, env: {} }))
    expect(config.mcp).toEqual({ echo: { type: 'local', command: [process.execPath, 'server.js'], environment: { TOKEN: 'repo-token' }, enabled: true } })
    expect(opencodeMcp(undefined, cwd, {})).toEqual({})
    // A Windows .cmd shim runs through cmd.exe, as the agents themselves do.
    const shim = opencodeMcp({ s: { command: 'C:\\tools\\npx.cmd', args: ['srv'], env: {} } }, cwd, {}, 'win32').s as { command: string[] }
    expect(shim.command[0].toLowerCase()).toContain('cmd')
  })
})

describe('OpenCode in the chat’s words', () => {
  it('names its tools as the chat renders them, with absolute paths', () => {
    expect(toolView('read', { filePath: 'src/a.ts', offset: 3 }, cwd)).toEqual({ name: 'Read', input: { file_path: path.join(cwd, 'src/a.ts'), offset: 3 } })
    expect(toolView('write', { filePath: 'b.txt', content: 'hi' }, cwd)).toEqual({ name: 'Write', input: { file_path: path.join(cwd, 'b.txt'), content: 'hi' } })
    expect(toolView('edit', { filePath: 'c.ts', oldString: 'a', newString: 'b' }, cwd)).toEqual({ name: 'Edit', input: { file_path: path.join(cwd, 'c.ts'), old_string: 'a', new_string: 'b' } })
    expect(toolView('bash', { command: 'git status', description: 'Status', workdir: cwd }, cwd)).toEqual({ name: 'Bash', input: { command: 'git status', description: 'Status' } })
    expect(toolView('grep', { pattern: 'x', include: '*.ts' }, cwd)).toEqual({ name: 'Grep', input: { pattern: 'x', glob: '*.ts' } })
    expect(toolView('task', { description: 'List files', prompt: 'ls', subagent_type: 'explore' }, cwd)).toEqual({ name: 'Task', input: { description: 'List files', prompt: 'ls', subagent_type: 'explore' } })
    // An MCP or plugin tool keeps its own name and input.
    expect(toolView('linear_create_issue', { title: 'Bug' }, cwd)).toEqual({ name: 'linear_create_issue', input: { title: 'Bug' } })
  })

  it('keeps the todo list and questions out of the tool rows: each has its own card', () => {
    expect(['todowrite', 'todoread', 'question'].every(hiddenTool)).toBe(true)
    expect(hiddenTool('bash')).toBe(false)
    expect(todoEntries([{ content: 'A', status: 'in_progress', priority: 'high' }, { content: 'B', status: 'cancelled', priority: 'low' }])).toEqual([
      { content: 'A', status: 'in_progress' },
      { content: 'B', status: 'completed' }
    ])
  })

  it('asks its questions on the card, and answers with its option labels, a multi-select split back on them', () => {
    const questions = [
      { question: 'Indent?', header: 'Style', options: [{ label: 'Tabs', description: 'One tab' }, { label: 'Spaces' }] },
      { question: 'Which?', options: [{ label: 'A, or not' }, { label: 'B' }], multiple: true }
    ]
    expect(cardQuestions(questions)).toEqual([
      { question: 'Indent?', header: 'Style', options: [{ label: 'Tabs', description: 'One tab' }, { label: 'Spaces' }] },
      { question: 'Which?', multiSelect: true, options: [{ label: 'A, or not' }, { label: 'B' }] }
    ])
    expect(questionAnswers(questions, { 'Indent?': 'Spaces', 'Which?': 'A, or not, B, my own, words' })).toEqual([['Spaces'], ['A, or not', 'B', 'my own, words']])
    expect(questionAnswers(questions, {})).toEqual([[], []])
  })

  it('says what an Always allow covers', () => {
    expect(alwaysScope('webfetch', ['https://example.com/*'])).toBe('`https://example.com/*`')
    expect(alwaysScope('external_directory', ['*'])).toBe('every external_directory request')
    expect(alwaysScope('bash', [])).toBeUndefined()
  })

  it('reads a model id as provider and model, at the first slash', () => {
    expect(modelParts('opencode/big-pickle')).toEqual({ providerID: 'opencode', modelID: 'big-pickle' })
    expect(modelParts('openrouter/anthropic/claude')).toEqual({ providerID: 'openrouter', modelID: 'anthropic/claude' })
    for (const id of ['', 'no-provider', '/x', 'x/']) expect(modelParts(id), id).toBeUndefined()
  })
})

describe('a missing OpenCode', () => {
  it('a turn says it isn’t installed and points at Settings', async () => {
    const { cb, played } = callbacks()
    await opencodeDriver.createTurn(await request({ executablePath: '/definitely/missing/opencode', env: process.env as Record<string, string> }), cb).run()
    expect(played.find('notice')).toMatchObject([{ level: 'error', action: 'open-settings', text: expect.stringContaining('OpenCode is not installed') }])
    expect(played.results).toMatchObject([{ ok: false }])
  })

  it('its status says how to install it', async () => {
    const missing = await opencodeDriver.status(process.env as Record<string, string>, '/definitely/missing/opencode')
    expect(missing).toMatchObject({ agent: 'opencode', installed: false, ready: false })
    expect(missing.detail).toContain('OpenCode is not installed')
    expect(missing.detail).toContain('npm i -g opencode-ai')
  })
})
