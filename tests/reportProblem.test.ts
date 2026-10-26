import { describe, expect, it } from 'vitest'
import {
  ISSUE_PASTE_NOTE,
  MAX_ISSUE_URL_LENGTH,
  agentLine,
  buildReport,
  formatDiagnostics,
  githubRepoFromPackage,
  issueBody,
  issueTitle,
  issueUrl,
  planIssue,
  redact,
  reportText,
  type ReportDiagnostics
} from '../src/shared/reportProblem'
import { ErrorLog, collectDiagnostics, errorLine } from '../src/main/reportProblem'

const mac = { home: '/Users/yatin', user: 'yatin' }
const win = { home: 'C:\\Users\\yatin', user: 'yatin' }

describe('redact', () => {
  it('replaces the home folder with ~, in either slash direction and any case', () => {
    expect(redact('log at /Users/yatin/Library/Logs/x.log', mac).text).toBe('log at ~/Library/Logs/x.log')
    expect(redact('C:\\Users\\yatin\\foreman and c:/users/YATIN/foreman', win).text).toBe('~\\foreman and ~/foreman')
    // Doubled backslashes, as in JSON.
    expect(redact('"C:\\\\Users\\\\yatin\\\\x"', win).text).toBe('"~\\\\x"')
  })

  it('leaves a longer folder name that starts with the home folder', () => {
    expect(redact('/Users/yatin2/x', { home: '/Users/yatin' }).text).toBe('/Users/yatin2/x')
  })

  it('replaces the user name as a whole word only', () => {
    const r = redact('yatin ran it; github.com/YatinChaubal/foreman', mac)
    expect(r.text).toBe('<user> ran it; github.com/YatinChaubal/foreman')
    expect(r.counts.user).toBe(1)
    // Too short a name would hit ordinary words.
    expect(redact('a bad day', { user: 'a' }).text).toBe('a bad day')
  })

  it('replaces keys and tokens', () => {
    const cases = [
      'sk-ant-api03-abcdefghijklmnopqrstuvwx',
      'sk-proj-ABCDEFGHIJKLMNOPQRSTUV123',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'gho_ABCDEFGHIJKLMNOPQRSTUVWX12',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'xoxb-1234567890-abcdefghij',
      'AKIAABCDEFGHIJKLMNOP',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      '0123456789abcdef0123456789abcdef',
      'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpL'
    ]
    for (const secret of cases) {
      const r = redact(`token ${secret} here`)
      expect(r.text, secret).toBe('token <token> here')
      expect(r.counts.token, secret).toBe(1)
    }
  })

  it('replaces only the value after a key name, and URL credentials', () => {
    expect(redact('api_key=abcd1234efgh').text).toBe('api_key=<token>')
    expect(redact('password: "hunter2hunter2"').text).toBe('password: "<token>"')
    expect(redact('https://x-access-token:s3cretvalue@github.com/a/b').text).toBe('https://<token>@github.com/a/b')
    expect(redact('Authorization: Bearer abcdefghijkl1234').text).toBe('Authorization: Bearer <token>')
  })

  it('replaces email addresses but not git@ remotes', () => {
    const r = redact('from yatin@appsmith.com via git@github.com:a/b.git', mac)
    expect(r.text).toBe('from <email> via git@github.com:a/b.git')
    expect(r.counts).toEqual({ path: 0, user: 0, token: 0, email: 1 })
  })

  it('leaves ordinary text, short ids and paths alone', () => {
    const text = 'git status failed in /tmp/oslo: exit 128 (abc1234) src/renderer/src/components/settings/AdvancedPage.tsx'
    const r = redact(text, mac)
    expect(r.text).toBe(text)
    expect(r.total).toBe(0)
    expect(r.segments).toEqual([{ text }])
  })

  it('reports each replacement as a segment with what it replaced', () => {
    const r = redact('see /Users/yatin/x, token ghp_abcdefghijklmnopqrstuvwxyz0123', mac)
    expect(r.segments).toEqual([
      { text: 'see ' },
      { text: '~', kind: 'path', original: '/Users/yatin' },
      { text: '/x, token ' },
      { text: '<token>', kind: 'token', original: 'ghp_abcdefghijklmnopqrstuvwxyz0123' }
    ])
    expect(r.total).toBe(2)
    expect(r.segments.map((s) => s.original ?? s.text).join('')).toBe('see /Users/yatin/x, token ghp_abcdefghijklmnopqrstuvwxyz0123')
  })
})

const diagnostics: ReportDiagnostics = {
  foremanVersion: '0.42.0',
  packaged: true,
  platform: 'darwin',
  arch: 'arm64',
  os: 'macOS 26.1',
  electron: '44.7.2',
  chrome: '140.0.1',
  node: '22.20.0',
  agents: [
    { name: 'Claude Code', installed: true, ready: true, version: '2.4.12', method: 'Claude Max account' },
    { name: 'Codex', installed: true, ready: false },
    { name: 'Cursor', installed: false, ready: false },
    { name: 'OpenCode', problem: 'no answer in 10s' }
  ],
  errors: ['14:03:11 one', '14:03:12 two', '14:03:13 three', '14:03:14 four', '14:03:15 five', '14:03:16 six'],
  repo: 'YatinChaubal/foreman',
  home: '/Users/yatin',
  user: 'yatin'
}

describe('formatDiagnostics', () => {
  it('lists versions, each agent and the last five errors', () => {
    expect(formatDiagnostics(diagnostics)).toBe(
      [
        'Foreman   0.42.0 (darwin-arm64, installed)',
        'OS        macOS 26.1',
        'Runtime   Electron 44.7.2 · Chrome 140.0.1 · Node 22.20.0',
        'Agents    Claude Code 2.4.12 (ready, Claude Max account)',
        '          Codex version unknown (not ready)',
        '          Cursor: not found',
        '          OpenCode: status unknown (no answer in 10s)',
        '',
        'Last errors (this session, newest last)',
        '14:03:12 two',
        '14:03:13 three',
        '14:03:14 four',
        '14:03:15 five',
        '14:03:16 six'
      ].join('\n')
    )
  })

  it('says so when nothing was logged', () => {
    expect(formatDiagnostics({ ...diagnostics, errors: [] })).toMatch(/\nLast errors: no recent errors recorded$/)
  })

  it('says unknown rather than guessing', () => {
    expect(agentLine({ name: 'Codex', installed: true })).toBe('Codex version unknown (sign-in unknown)')
  })
})

describe('the issue', () => {
  it('titles it from the first line of the description', () => {
    expect(issueTitle('\n  The   Changes panel stayed empty  \nmore')).toBe('The Changes panel stayed empty')
    expect(issueTitle('')).toBe('Problem report')
    const long = issueTitle('x'.repeat(200))
    expect(long).toHaveLength(80)
    expect(long.endsWith('…')).toBe(true)
  })

  it('puts the diagnostics in a fence they cannot close', () => {
    expect(issueBody('It broke', 'Foreman 1')).toBe('### What happened\n\nIt broke\n\n### Diagnostics\n\n```text\nForeman 1\n```\n')
    expect(issueBody('', 'a\n```\nb')).toContain('````text\na\n```\nb\n````')
    expect(issueBody('', 'x')).toContain('_No description given._')
  })

  it('redacts the title and body only when asked', () => {
    const on = buildReport('Broke in /Users/yatin/repo', 'token ghp_abcdefghijklmnopqrstuvwxyz0123', true, mac)
    expect(on.title.text).toBe('Broke in ~/repo')
    expect(on.body.text).toContain('Broke in ~/repo')
    expect(on.body.text).toContain('token <token>')
    expect(on.body.counts).toEqual({ path: 1, user: 0, token: 1, email: 0 })
    const off = buildReport('Broke in /Users/yatin/repo', 'x', false, mac)
    expect(off.title.text).toBe('Broke in /Users/yatin/repo')
    expect(off.body.total).toBe(0)
    expect(reportText({ title: on.title.text, body: on.body.text })).toBe(`Broke in ~/repo\n\n${on.body.text}`)
  })

  it('builds a pre-filled new-issue link', () => {
    const url = issueUrl('YatinChaubal/foreman', 'A & B', 'line 1\nline 2 #3')
    expect(url).toBe('https://github.com/YatinChaubal/foreman/issues/new?title=A%20%26%20B&body=line%201%0Aline%202%20%233')
    const parsed = new URL(url)
    expect(parsed.searchParams.get('title')).toBe('A & B')
    expect(parsed.searchParams.get('body')).toBe('line 1\nline 2 #3')
  })

  it('links the whole report when it fits', () => {
    const plan = planIssue('a/b', 'T', 'short body')
    expect(plan).toEqual({ url: issueUrl('a/b', 'T', 'short body'), copy: false })
  })

  it('falls back to copying when the link would be too long', () => {
    const body = 'x'.repeat(MAX_ISSUE_URL_LENGTH)
    const plan = planIssue('a/b', 'T', body)
    expect(plan.copy).toBe(true)
    expect(plan.url).toBe(issueUrl('a/b', 'T', ISSUE_PASTE_NOTE))
    expect(plan.url.length).toBeLessThan(MAX_ISSUE_URL_LENGTH)
    // Encoding counts: 2,000 characters that each encode to 9 don't fit either.
    expect(planIssue('a/b', 'T', '€'.repeat(2000)).copy).toBe(true)
    // The limit is inclusive.
    const exact = issueUrl('a/b', 'T', '')
    expect(planIssue('a/b', 'T', 'y'.repeat(100), exact.length + 100).copy).toBe(false)
    expect(planIssue('a/b', 'T', 'y'.repeat(101), exact.length + 100).copy).toBe(true)
  })

  it('refuses anything that is not owner/name', () => {
    expect(() => planIssue('https://evil.example/x', 'T', 'b')).toThrow()
    expect(() => planIssue('a/b/../c', 'T', 'b')).toThrow()
  })
})

describe('githubRepoFromPackage', () => {
  it('reads the forms package.json allows', () => {
    expect(githubRepoFromPackage('YatinChaubal/foreman')).toBe('YatinChaubal/foreman')
    expect(githubRepoFromPackage('github:YatinChaubal/foreman')).toBe('YatinChaubal/foreman')
    expect(githubRepoFromPackage('https://github.com/YatinChaubal/foreman.git')).toBe('YatinChaubal/foreman')
    expect(githubRepoFromPackage({ type: 'git', url: 'git+https://github.com/YatinChaubal/foreman.git' })).toBe('YatinChaubal/foreman')
    expect(githubRepoFromPackage('git@github.com:YatinChaubal/foreman.git')).toBe('YatinChaubal/foreman')
  })

  it('is null for anything else', () => {
    expect(githubRepoFromPackage(undefined)).toBeNull()
    expect(githubRepoFromPackage('https://gitlab.com/a/b')).toBeNull()
    expect(githubRepoFromPackage({ url: 42 })).toBeNull()
  })
})

describe('ErrorLog', () => {
  it('keeps the latest lines, newest last', () => {
    const log = new ErrorLog(3)
    for (const n of [1, 2, 3, 4]) log.record(`line ${n}`)
    expect(log.recent(2)).toEqual(['line 3', 'line 4'])
    expect(log.recent(10)).toEqual(['line 2', 'line 3', 'line 4'])
  })

  it('makes one timestamped line from console.error arguments', () => {
    const at = new Date(2026, 9, 22, 14, 3, 11)
    expect(errorLine(['Could not create the tray icon:', new Error('boom\n    at x.js:1')], at)).toBe('14:03:11 Could not create the tray icon: Error: boom')
    expect(errorLine(['a\nb', { code: 1 }], at)).toBe('14:03:11 a b {"code":1}')
    expect(errorLine(['x'.repeat(500)], at)).toHaveLength(9 + 300)
  })
})

describe('collectDiagnostics', () => {
  it('asks every agent, says unknown when one fails or stalls, and takes the last errors', async () => {
    const errors = new ErrorLog()
    for (let n = 1; n <= 7; n++) errors.record(`e${n}`)
    const d = await collectDiagnostics({
      version: '1.2.3',
      packaged: false,
      appPath: process.cwd(),
      errors,
      timeoutMs: 50,
      agentStatus: async (agent) => {
        if (agent === 'codex') throw new Error('spawn codex ENOENT\nstack')
        if (agent === 'opencode') return new Promise(() => undefined)
        return { agent, installed: true, ready: agent === 'claude', version: '9.9', account: 'someone@example.com' }
      }
    })
    expect(d.foremanVersion).toBe('1.2.3')
    expect(d.node).toBe(process.versions.node)
    expect(d.agents).toEqual([
      { name: 'Claude Code', installed: true, ready: true, version: '9.9', method: undefined },
      { name: 'Codex', problem: 'spawn codex ENOENT' },
      { name: 'Cursor', installed: true, ready: false, version: '9.9', method: undefined },
      { name: 'OpenCode', problem: 'no answer in 0s' }
    ])
    // The account never reaches the report.
    expect(JSON.stringify(d.agents)).not.toContain('someone@example.com')
    expect(d.errors).toEqual(['e3', 'e4', 'e5', 'e6', 'e7'])
    expect(d.home).toBeTruthy()
  })
})
