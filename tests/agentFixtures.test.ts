// Every fixture under src/main/agents/*/fixtures (docs/agents.md, 9.1, 9.2): well formed, and nothing in it that must
// not be committed: the recorder's home folder, an email, a key, a JWT, an `env` value that isn't a placeholder.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EOF, formatFixture, parseFixture, type Fixture, type Frame } from '../src/main/agents/fixtures/format'
import { CLI_BUNDLED_COMMANDS, PLACEHOLDER_VALUE, findLeaks, fillPlaceholders, sanitizeFixture, sanitizeFrames } from '../src/main/agents/fixtures/sanitize'

const AGENTS = 'src/main/agents'

function allFixtures(): { file: string; fixture: Fixture }[] {
  const found: { file: string; fixture: Fixture }[] = []
  for (const folder of readdirSync(AGENTS)) {
    const dir = path.join(AGENTS, folder, 'fixtures')
    if (!statSync(path.join(AGENTS, folder)).isDirectory()) continue
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names.filter((n) => n.endsWith('.jsonl'))) {
      const file = path.join(dir, name)
      found.push({ file, fixture: parseFixture(readFileSync(file, 'utf8'), file) })
    }
  }
  return found
}

const fixtures = allFixtures()
const machine = { home: os.homedir(), username: os.userInfo().username }

describe('agent fixtures', () => {
  it('finds the recordings', () => {
    expect(fixtures.length).toBeGreaterThan(0)
  })

  describe.each(fixtures.map((f) => [path.relative(AGENTS, f.file).replace(/\\/g, '/'), f] as const))('%s', (_name, { file, fixture }) => {
    it('has a header that matches where it is', () => {
      const [folder] = path.relative(AGENTS, file).split(path.sep)
      expect(fixture.header.scenario).toBe(path.basename(file, '.jsonl'))
      expect(folder === fixture.header.agent || (folder === 'acp' && !['claude', 'codex', 'cursor', 'opencode'].includes(fixture.header.agent))).toBe(true)
      expect(fixture.header.version).toBeTruthy()
      expect(fixture.header.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('says what an edited fixture changed', () => {
      if (fixture.header.evidence === 'edited') expect(fixture.header.edits?.length).toBeGreaterThan(0)
    })

    it('round-trips through the format', () => {
      expect(parseFixture(formatFixture(fixture))).toEqual(fixture)
    })

    it('holds nothing that must not be committed', () => {
      expect(findLeaks(fixture, machine)).toEqual([])
    })

    it('is already what the sanitiser makes of it (nothing left for `npm run record:agent -- resanitize` to change)', () => {
      expect(sanitizeFixture(fixture, { repo: '', tmp: '', home: '' })).toEqual(fixture)
    })

    it('names no organisation, plan, claude.ai org skill, or skill and command the CLI does not ship with', () => {
      const text = JSON.stringify(fixture.frames)
      expect(text).not.toMatch(/anthropic-skills:/)
      const found: string[] = []
      const walk = (value: unknown, key?: string) => {
        if (typeof value === 'string') {
          if (key && /^organi[sz]ation$/i.test(key) && !PLACEHOLDER_VALUE.test(value)) found.push(`organization ${value}`)
          if (key && /^(subscription|plan)_?type$/i.test(key) && !PLACEHOLDER_VALUE.test(value)) found.push(`plan ${value}`)
        } else if (Array.isArray(value)) {
          for (const v of value) {
            const name = typeof v === 'string' ? v : (v as { name?: unknown } | null)?.name
            if (key === 'skills' || key === 'slash_commands' || key === 'terminal_slash_commands' || key === 'commands') {
              // Built-in commands say so (`builtin`), as does a built-in skill's source.
              const own = typeof v === 'object' && v !== null && ((v as { builtin?: boolean }).builtin || (v as { source?: string }).source === 'built-in')
              if (typeof name === 'string' && !own && !CLI_BUNDLED_COMMANDS.has(name) && !PLACEHOLDER_VALUE.test(name)) found.push(`${key}: ${name}`)
            }
            if (key === 'skillFrontmatter' && (v as { source?: string }).source !== 'built-in' && !PLACEHOLDER_VALUE.test(String(name))) found.push(`skillFrontmatter: ${String(name)}`)
            walk(v)
          }
        } else if (typeof value === 'object' && value !== null) for (const [k, v] of Object.entries(value)) walk(v, k)
      }
      for (const f of fixture.frames) walk(f.data)
      expect(found).toEqual([])
    })

    it('has frames in time order', () => {
      const times = fixture.frames.map((f) => f.t)
      expect(times).toEqual([...times].sort((a, b) => a - b))
    })
  })
})

describe('the sanitiser', () => {
  const ctx = { repo: 'C:\\Users\\Pat\\AppData\\Local\\Temp\\run-ab12\\repo', tmp: 'C:\\Users\\Pat\\AppData\\Local\\Temp\\run-ab12', home: 'C:\\Users\\Pat', username: 'Pat Example'.split(' ')[0] }
  const frame = (data: unknown) => ({ t: 0, dir: 'recv' as const, data })

  it('replaces paths whichever way they are spelled, and puts them back at replay', () => {
    const data = { cwd: ctx.repo, file: `${ctx.repo}\\src\\a.ts`, json: JSON.stringify({ p: `${ctx.repo}\\b.ts` }), home: `${ctx.home}\\.config`, fwd: 'C:/Users/Pat/AppData/Local/Temp/run-ab12/repo/x', tmp: ctx.tmp }
    const [out] = sanitizeFrames([frame(data)], ctx)
    expect(out.data).toEqual({ cwd: '<repo>', file: '<repo>/src/a.ts', json: '{"p":"<repo>/b.ts"}', home: '<home>/.config', fwd: '<repo>/x', tmp: '<tmp>' })
    expect(fillPlaceholders(out.data, { repo: '/work/r', home: '/h', tmp: '/t' })).toMatchObject({ cwd: '/work/r', file: '/work/r/src/a.ts', home: '/h/.config' })
  })

  it('replaces tokens, keys, emails, JWTs and account ids with stable placeholders', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijk'
    const data = {
      text: `key sk-ant-api03-AAAAAAAAAAAAAAAA and ghp_${'a'.repeat(36)} and ${jwt} for pat@corp.io, again pat@corp.io and other@corp.io; ok noreply@anthropic.com`,
      account: { email: 'who@corp.io', organizationUuid: '0b1f3c9e-1111-2222-3333-444455556666' },
      env: { PATH: '/usr/bin', TOKEN: 'secret' }
    }
    const [out] = sanitizeFrames([frame(data)], ctx)
    expect(out.data).toEqual({
      text: 'key <token-1> and <token-2> and <jwt-1> for <email-1>, again <email-1> and <email-2>; ok noreply@anthropic.com',
      account: { email: '<email-3>', organizationUuid: '<account-id-1>' },
      env: { PATH: '<env>', TOKEN: '<env>' }
    })
    expect(findLeaks({ header: {} as never, frames: [out] }, machine)).toEqual([])
  })

  it('cleans a path a streamed tool input splits across fragments', () => {
    const json = JSON.stringify({ file_path: `${ctx.repo}\\a.ts` })
    const cut = json.indexOf('Users') + 8
    const fragment = (partial_json: string): Frame => ({ t: 0, dir: 'recv', data: { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } } } })
    const stop: Frame = { t: 0, dir: 'recv', data: { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } } }
    const out = sanitizeFrames([fragment(json.slice(0, cut)), fragment(json.slice(cut)), stop], ctx)
    const joined = out.map((f) => (f.data as { event: { delta?: { partial_json: string } } }).event.delta?.partial_json ?? '').join('')
    expect(JSON.parse(joined)).toEqual({ file_path: '<repo>/a.ts' })
    expect(findLeaks({ header: {} as never, frames: out }, machine)).toEqual([])
  })

  it('replaces the account\'s organisation and plan, and every skill and command the CLI does not ship with', () => {
    const init = {
      type: 'system',
      subtype: 'init',
      skills: ['batch', 'anthropic-skills:morning', 'my-own-skill'],
      slash_commands: ['clear', 'anthropic-skills:morning', 'deploy'],
      agents: ['Explore', 'acme-reviewer'],
      plugins: [{ name: 'cc-plugin-telemetry', path: 'builtin', source: 'cc-plugin-telemetry@builtin' }, { name: 'acme-tools', path: '/home/x/.claude/plugins/acme', source: 'acme-tools@market' }]
    }
    const reply = {
      account: { email: 'a@corp.io', organization: 'Acme Corp', subscriptionType: 'Claude Team' },
      commands: [
        { name: 'compact', description: 'Clear history', argumentHint: '', builtin: true },
        { name: 'morning', description: 'Acme\'s morning routine', argumentHint: '[team]', aliases: ['anthropic-skills:morning'] }
      ],
      skills: { skillFrontmatter: [{ name: 'simplify', source: 'built-in', tokens: 63 }, { name: 'morning', source: 'syncedSkills', tokens: 80 }] }
    }
    const out = sanitizeFrames([{ t: 0, dir: 'recv', data: init }, { t: 1, dir: 'recv', data: reply }], ctx)
    expect(out[0].data).toEqual({
      type: 'system',
      subtype: 'init',
      skills: ['batch', '<skill-1>', '<skill-2>'],
      slash_commands: ['clear', '<skill-1>', '<skill-3>'],
      agents: ['Explore', '<agent-1>'],
      plugins: [{ name: 'cc-plugin-telemetry', path: 'builtin', source: 'cc-plugin-telemetry@builtin' }, { name: '<plugin-1>', path: '<plugin>', source: '<plugin-2>' }]
    })
    expect(out[1].data).toEqual({
      account: { email: '<email-1>', organization: '<org>', subscriptionType: '<plan>' },
      commands: [
        { name: 'compact', description: 'Clear history', argumentHint: '', builtin: true },
        { name: '<skill-4>', description: '<skill>', argumentHint: '<skill>', aliases: ['<skill-1>'] }
      ],
      skills: { skillFrontmatter: [{ name: 'simplify', source: 'built-in', tokens: 63 }, { name: '<skill-4>', source: '<skill-5>', tokens: 80 }] }
    })
    expect(findLeaks({ header: {} as never, frames: out }, machine)).toEqual([])
    // Sanitising what is sanitised changes nothing.
    expect(sanitizeFrames(out, { repo: '', tmp: '', home: '' })).toEqual(out)
  })

  it('is caught by the check when an organisation, plan, org skill or unknown command is left', () => {
    const dirty: Fixture = {
      header: { fixture: 1, agent: 'x', scenario: 's', version: '1', recordedAt: '2026-01-01', evidence: 'recorded' },
      frames: [
        { t: 0, dir: 'recv', data: { account: { organization: 'Acme', subscriptionType: 'Claude Max' }, skills: ['anthropic-skills:pdf', 'deploy', 'batch'], commands: [{ name: 'fix-linear-issue' }, { name: 'init', builtin: true }], skills2: { skillFrontmatter: [{ name: 'x', source: 'syncedSkills' }] } } },
        { t: 1, dir: 'recv', data: { skillFrontmatter: [{ name: 'x', source: 'syncedSkills' }], plugins: [{ name: 'acme', path: '/p' }] } }
      ]
    }
    const leaks = findLeaks(dirty, machine).join('\n')
    for (const what of ['organisation name under "organization"', 'plan under "subscriptionType"', 'org skill (anthropic-skills:)', '"deploy" in "skills"', '"fix-linear-issue" in "commands"', '"x" in "skillFrontmatter"', '"acme" in "plugins"']) expect(leaks).toContain(what)
    expect(leaks).not.toContain('"batch"')
    expect(leaks).not.toContain('"init"')
  })

  describe('a streamed text split across fragments', () => {
    const path = 'C:/Users/Pat/AppData/Local/Temp/run-ab12/repo/README.md'
    const cuts = ['See [README.md](C:/Us', 'ers/P', 'at/AppData/Local/Te', 'mp/run-ab12/repo/README', '.md) for P', 'at.']
    const codex = (method: string, parts: string[], itemId = 'msg_1'): Frame[] => parts.map((delta, t) => ({ t, dir: 'recv' as const, data: { method, params: { threadId: 't', turnId: 'u', itemId, delta } } }))
    const claude = (kind: string, field: string, parts: string[]): Frame[] => [
      ...parts.map((text, t): Frame => ({ t, dir: 'recv', data: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: kind, [field]: text } } } })),
      { t: 99, dir: 'recv', data: { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } } }
    ]
    const joined = (frames: Frame[], read: (data: any) => string | undefined) => frames.map((f) => read(f.data) ?? '').join('')
    const cases: [string, Frame[], (data: any) => string | undefined][] = [
      ['Codex agent message', codex('item/agentMessage/delta', cuts), (d) => d.params?.delta],
      ['Codex reasoning', codex('item/reasoning/textDelta', cuts), (d) => d.params?.delta],
      ['Codex command output', codex('item/commandExecution/outputDelta', cuts), (d) => d.params?.delta],
      ['Codex file change output', codex('item/fileChange/outputDelta', cuts), (d) => d.params?.delta],
      ['Codex plan', codex('item/plan/delta', cuts), (d) => d.params?.delta],
      ['Claude text', claude('text_delta', 'text', cuts), (d) => d.event?.delta?.text],
      ['Claude thinking', claude('thinking_delta', 'thinking', cuts), (d) => d.event?.delta?.thinking]
    ]

    it.each(cases)('is caught by the leak check, and cleaned by the sanitiser: %s', (_name, frames, read) => {
      expect(joined(frames, read)).toContain(path)
      // Not one fragment holds the path or the login name, so only reading them joined can see it.
      for (const f of frames) expect(read(f.data) ?? '').not.toMatch(/Pat|Users/)
      const dirty: Fixture = { header: { fixture: 1, agent: 'x', scenario: 's', version: '1', recordedAt: '2026-01-01', evidence: 'recorded' }, frames }
      const leaks = findLeaks(dirty, machine).join('\n')
      expect(leaks).toContain('home folder path')
      const out = sanitizeFrames(frames, ctx)
      expect(joined(out, read)).toBe('See [README.md](<repo>/README.md) for Pat.')
      expect(findLeaks({ ...dirty, frames: out }, machine)).toEqual([])
      // And again: nothing left to change.
      expect(sanitizeFrames(out, { repo: '', tmp: '', home: '' })).toEqual(out)
    })

    it('keeps two items’ deltas apart, and a reused content index after its block has stopped', () => {
      const frames = [...codex('item/agentMessage/delta', ['C:/Us', 'ers/P'], 'a'), ...codex('item/agentMessage/delta', ['hello ', 'there'], 'b'), ...codex('item/agentMessage/delta', ['at/AppData/x'], 'a')]
      const out = sanitizeFrames(frames, ctx)
      expect(joined(out.filter((f) => (f.data as any).params.itemId === 'b'), (d) => d.params.delta)).toBe('hello there')
      const next = [...claude('text_delta', 'text', ['one ', 'two']), ...claude('text_delta', 'text', ['C:/Users/Pat/', 'x'])]
      expect(joined(sanitizeFrames(next, ctx), (d) => d.event?.delta?.text)).toBe('one two<home>/x')
    })
  })

  it('sanitising again continues the placeholder numbers, so a new value never takes an old one’s', () => {
    const first = sanitizeFrames([{ t: 0, dir: 'recv', data: { text: 'mail a@corp.io and b@corp.io', skills: ['batch', 'my-own-skill'] } }], ctx)
    expect(first[0].data).toEqual({ text: 'mail <email-1> and <email-2>', skills: ['batch', '<skill-1>'] })
    // The same file later holds one more email and skill (a newer recording merged in, or a sanitiser that learned a pattern).
    const more = [...first, { t: 1, dir: 'recv' as const, data: { text: 'and c@corp.io', skills: ['another-skill'] } }]
    const again = sanitizeFrames(more, { repo: '', tmp: '', home: '' })
    expect(again[0].data).toEqual(first[0].data)
    expect(again[1].data).toEqual({ text: 'and <email-3>', skills: ['<skill-2>'] })
  })

  it('turns an <epoch+N> placeholder into a time that far from now', () => {
    expect(fillPlaceholders({ resetsAt: '<epoch+7200>' }, { now: 1_000_000 })).toEqual({ resetsAt: 1000 + 7200 })
  })

  it('is caught by the check when it was not run', () => {
    const dirty: Fixture = {
      header: { fixture: 1, agent: 'x', scenario: 's', version: '1', recordedAt: '2026-01-01', evidence: 'recorded' },
      frames: [
        { t: 0, dir: 'recv', data: { cwd: 'C:\\Users\\Someone\\proj', mail: 'a@b.io', jwt: 'eyJhbGciOiJIUzI1NiJ9xx.yy.zz', env: { HOME: '/home/someone' }, key: 'sk-ant-api03-ZZZZZZZZZZZZZZ' } },
        { t: 1, dir: 'send', data: EOF }
      ]
    }
    const leaks = findLeaks(dirty, machine).join('\n')
    for (const what of ['home folder path', 'email address', 'JWT', 'env value of HOME', 'key or token']) expect(leaks).toContain(what)
  })
})
