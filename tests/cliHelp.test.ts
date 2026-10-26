import { describe, expect, it } from 'vitest'
import { CliError } from '../src/cli/client'
import { groupEntries, helpFor, registerTopic, renderCommandHelp, renderHelp, renderTopic, topicNames } from '../src/cli/help'
import { parseCommandArgs, plan, RUNNERS } from '../src/cli/registry'
import { CLI_VERSION } from '../src/cli/version'
import { ALIASES, COMMANDS, COMMON_OPTIONS, commandName, findCommand, GROUP_ORDER, visibleCommands, type CommandSpec } from '../src/shared/cliCommands'

const spec = (name: string): CommandSpec => {
  const found = COMMANDS.find((c) => commandName(c) === name)
  if (!found) throw new Error(`no command ${name}`)
  return found
}

describe('the command table', () => {
  it('gives every command a summary, a usage line that starts with its name and a group in the help order', () => {
    for (const c of COMMANDS) {
      expect(c.summary, commandName(c)).not.toBe('')
      expect(c.usage.startsWith(`foreman ${commandName(c)}`), c.usage).toBe(true)
      expect(GROUP_ORDER).toContain(c.group)
    }
  })

  it('has at least one example for every command a person sees', () => {
    for (const c of visibleCommands()) expect(c.examples?.length, commandName(c)).toBeGreaterThan(0)
  })

  it('has no two commands with one name, and no short option that clashes with a common one', () => {
    const names = COMMANDS.map(commandName)
    expect(new Set(names).size).toBe(names.length)
    const common = new Set(Object.values(COMMON_OPTIONS).map((o) => o.short))
    for (const c of COMMANDS) {
      const shorts = Object.values(c.options).map((o) => o.short).filter(Boolean)
      expect(new Set(shorts).size, commandName(c)).toBe(shorts.length)
      for (const s of shorts) expect(common.has(s), `${commandName(c)} -${s}`).toBe(false)
    }
  })

  it('has a function for every command except the hidden bridge, and none for a command that isn’t there', () => {
    for (const c of COMMANDS.filter((x) => !x.hidden)) expect(RUNNERS.has(commandName(c)), commandName(c)).toBe(true)
    expect(RUNNERS.has('mcp-bridge')).toBe(false)
    for (const key of RUNNERS.keys()) expect(COMMANDS.some((c) => commandName(c) === key), key).toBe(true)
  })

  it('keeps every command the CLI had', () => {
    for (const name of ['run', 'wait', 'send', 'cancel', 'resume-at', 'checks', 'status', 'export', 'import', 'templates', 'repos', 'report', 'review', 'mcp-bridge']) expect(spec(name)).toBeTruthy()
    expect(spec('mcp-bridge').hidden).toBe(true)
  })

  it('has the aliases the plan names and none for settings or keys', () => {
    expect(ALIASES).toEqual({ ws: ['workspace'], pr: ['git', 'pr'] })
  })
})

describe('foreman help', () => {
  const text = renderHelp()

  it('starts with the version and what the command is', () => {
    expect(text.split('\n')[0]).toBe(`foreman ${CLI_VERSION} · drives the running Foreman app`)
  })

  it('lists every command a person sees, and not the bridge', () => {
    for (const c of visibleCommands()) {
      const entries = groupEntries(c.group)
      // A noun with a one-word alias (ws for workspace) is shown by its alias, as the plan's help does.
      const shown = Object.entries(ALIASES).find(([, path]) => path.length === 1 && path[0] === c.path[0])?.[0] ?? c.path[0]
      if (c.path.length === 1) expect(entries, commandName(c)).toContain(c.path[0])
      else if (entries.includes(c.path[0])) {
        // The noun has a command of its own, which lists the verbs; the overview names it once.
      } else {
        const row = entries.find((e) => e.startsWith(`${shown} `))
        expect(row, commandName(c)).toBeDefined()
        // A noun with many verbs is shown as a count; otherwise its verbs are listed.
        if (!/^\S+ \(\d+ commands: /.test(row!)) expect(row!.slice(shown.length + 1).split('|'), commandName(c)).toContain(c.path.slice(1).join(' '))
      }
      expect(text, commandName(c)).toContain(shown)
    }
    expect(text).not.toContain('mcp-bridge')
  })

  it('shows groups in order, as one row each, with the labels from the plan', () => {
    const lines = text.split('\n')
    expect(lines.find((l) => l.startsWith('Work '))).toMatch(/^Work {11}run, wait, send, cancel, resume-at, checks, status, report, review/)
    expect(lines.find((l) => l.startsWith('App '))).toContain('app info, doctor, cli status|install, completion, help')
    const order = ['Work', 'Workspaces', 'Repositories', 'Settings', 'App'].map((label) => lines.findIndex((l) => l.startsWith(`${label} `)))
    expect(order.every((n) => n > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('ends with where to look next', () => {
    expect(text).toContain('foreman help <command>   options, examples and exit codes       foreman help exit-codes | agents | settings-keys | environment')
    expect(text).toContain('Every command takes --json.')
  })

  it('wraps a long row at a comma, under the label', () => {
    const many = Array.from({ length: 30 }, (_, i): CommandSpec => ({ ...spec('status'), path: [`command${i}`], group: 'chats' }))
    const lines = renderHelp(many).split('\n')
    const row = lines.filter((l) => l.startsWith('Chats ') || (l.startsWith('               ') && l.includes('command')))
    expect(row.length).toBeGreaterThan(1)
    for (const line of row) expect(line.length).toBeLessThanOrEqual(100)
    expect(row[0].trimEnd().endsWith(',')).toBe(true)
  })
})

describe('foreman help <command>', () => {
  it('shows every option of the command, and the common ones', () => {
    for (const c of COMMANDS) {
      const rendered = renderCommandHelp(c)
      for (const [name, option] of Object.entries({ ...c.options, ...COMMON_OPTIONS })) {
        expect(rendered, `${commandName(c)} --${name}`).toContain(`--${name}`)
        if (option.short) expect(rendered, `${commandName(c)} -${option.short}`).toContain(`-${option.short}, --${name}`)
      }
      expect(rendered).toContain(c.usage)
      for (const example of c.examples ?? []) expect(rendered).toContain(example)
    }
  })

  it('shows choices, defaults, exit codes and the long description', () => {
    const run = renderCommandHelp(spec('run'))
    expect(run).toContain('-l, --loadout <n>')
    expect(run).toContain('(default: 1)')
    expect(run).toContain('3  Setup failed; the first message is held')
    expect(run).toContain('If setup fails, the first message is held, not sent.')
    expect(renderCommandHelp(spec('report'))).toContain('(one of: needs-input, stuck, checkpoint, done)')
    expect(renderCommandHelp(spec('export'))).toContain('(repeatable)')
  })

  it('is the same for `foreman help send` and `foreman send --help`', () => {
    const viaHelp = helpFor(['send'])
    expect('text' in viaHelp && viaHelp.text).toBe(renderCommandHelp(spec('send')))
    const planned = plan(['send', '--help'])
    expect(planned.kind).toBe('command')
    if (planned.kind === 'command') expect(parseCommandArgs(planned.spec, planned.args).opts.help).toBe(true)
  })

  it('answers a noun with its verbs, a topic by name, and an unknown word with suggestions', () => {
    const cli = helpFor(['cli'])
    expect('text' in cli && cli.text).toContain('cli install')
    const twoWords = helpFor(['cli', 'install'])
    expect('text' in twoWords && twoWords.text).toContain('foreman cli install')
    const typo = helpFor(['stauts'])
    expect(typo).toMatchObject({ error: expect.stringContaining('stauts') })
    expect('suggestions' in typo && typo.suggestions).toContain('status')
    expect(helpFor([])).toEqual({ text: renderHelp() })
  })
})

describe('help topics', () => {
  it('has exit-codes, agents, settings-keys and environment', () => {
    expect(topicNames()).toEqual(['exit-codes', 'agents', 'settings-keys', 'environment'])
    for (const name of topicNames()) expect(renderTopic(name)?.length, name).toBeGreaterThan(40)
  })

  it('lists every exit code, 0 to 8', () => {
    const codes = renderTopic('exit-codes')!
    for (let n = 0; n <= 8; n++) expect(codes).toMatch(new RegExp(`^  ${n}  `, 'm'))
  })

  it('explains what agents may call and the token', () => {
    const agents = renderTopic('agents')!
    for (const word of ['FOREMAN_TURN_TOKEN', 'foreman report', 'foreman review', 'foreman checks', 'Let agents start workspaces and queue messages', 'attribution']) expect(agents).toContain(word)
  })

  it('names the environment variables', () => {
    const env = renderTopic('environment')!
    for (const name of ['FOREMAN_DATA_DIR', 'FOREMAN_PASSPHRASE', 'FOREMAN_SESSION_ID', 'FOREMAN_TURN_ID', 'FOREMAN_TURN_TOKEN', 'NO_COLOR', 'FOREMAN_JSON=1']) expect(env).toContain(name)
  })

  it('renders the settings keys from the schema, and lets a topic be replaced', () => {
    // src/cli/topics/settingsKeys.ts registers the real topic when the registry is imported.
    const real = renderTopic('settings-keys')!
    expect(real).toContain('appearance.theme')
    expect(real).toContain('scripts.checks-after-turn')
    registerTopic('settings-keys', () => 'appearance.theme  system|light|dark')
    try {
      expect(renderTopic('settings-keys')).toBe('appearance.theme  system|light|dark')
      expect(topicNames()).toEqual(['exit-codes', 'agents', 'settings-keys', 'environment'])
    } finally {
      registerTopic('settings-keys', () => real)
    }
  })
})

describe('finding a command', () => {
  it('takes the longest path and gives back the words after it', () => {
    const run = findCommand(['run', 'fix-a-bug', '--open'])
    expect(run).toMatchObject({ rest: ['fix-a-bug', '--open'] })
    expect('spec' in run && commandName(run.spec)).toBe('run')
    const install = findCommand(['cli', 'install', 'extra'])
    expect('spec' in install && commandName(install.spec)).toBe('cli install')
    expect('spec' in install && install.rest).toEqual(['extra'])
    const help = findCommand(['help', 'cli', 'install'])
    expect('spec' in help && help.rest).toEqual(['cli', 'install'])
  })

  it('suggests the nearest command for a typo or a prefix', () => {
    expect(findCommand(['stauts'])).toMatchObject({ error: 'Unknown command “stauts”', suggestions: ['status'] })
    const prefix = findCommand(['sta'])
    expect('suggestions' in prefix && prefix.suggestions).toContain('status')
    const none = findCommand(['zzzzzzzz'])
    expect(none).toEqual({ error: 'Unknown command “zzzzzzzz”', suggestions: [] })
  })

  it('never suggests the hidden bridge', () => {
    const found = findCommand(['mcp-brdige'])
    expect('suggestions' in found && found.suggestions).not.toContain('mcp-bridge')
  })

  it('asks a noun for its verb, and corrects a wrong one', () => {
    expect(findCommand(['cli'])).toEqual({ error: 'foreman cli needs a subcommand', suggestions: ['cli status', 'cli install'] })
    expect(findCommand(['cli', 'instal'])).toMatchObject({ error: 'Unknown cli command “instal”', suggestions: ['cli status', 'cli install'] })
  })

  it('expands an alias for a noun', () => {
    const workspace: CommandSpec[] = [{ ...spec('status'), path: ['workspace', 'list'] }]
    const found = findCommand(['ws', 'list', 'x'], workspace)
    expect('spec' in found && commandName(found.spec)).toBe('workspace list')
    expect('spec' in found && found.rest).toEqual(['x'])
    expect(groupEntries('work', workspace)).toEqual(['ws list'])
  })

  it('lets the common flags come before the command', () => {
    const planned = plan(['--json', 'status'])
    expect(planned).toMatchObject({ kind: 'command', args: ['--json'] })
    expect(plan([])).toEqual({ kind: 'overview' })
    expect(plan(['--help'])).toEqual({ kind: 'overview' })
    expect(plan(['--bogus'])).toMatchObject({ kind: 'error', message: 'Unknown option --bogus' })
    expect(plan(['bogus'])).toMatchObject({ kind: 'error', message: 'Unknown command “bogus”' })
  })
})

describe('parsing a command’s options', () => {
  it('takes the options the command declares, and the common ones', () => {
    const { opts, positionals } = parseCommandArgs(spec('run'), ['fix', 'ENG-1', '-r', 'api', '--wait', '--timeout', '30', '-o', '--json', '-q'])
    expect(positionals).toEqual(['fix', 'ENG-1'])
    expect(opts).toMatchObject({ repo: 'api', wait: true, timeout: '30', open: true, json: true, quiet: true })
    expect(parseCommandArgs(spec('export'), ['ws', '--chat', '1', '--chat', 'abc']).opts.chat).toEqual(['1', 'abc'])
  })

  it('refuses an option the command doesn’t declare, naming it and pointing at the help', () => {
    for (const [name, args, option] of [
      ['run', ['x', '--share'], '--share'],
      ['status', ['--tab', '3'], '--tab'],
      ['send', ['ws', '--wait'], '--wait'],
      ['checks', ['-z'], '-z']
    ] as const) {
      let error: unknown
      try {
        parseCommandArgs(spec(name), [...args])
      } catch (err) {
        error = err
      }
      expect(error, name).toBeInstanceOf(CliError)
      expect((error as CliError).message).toBe(`foreman ${name} doesn’t take ${option}`)
      expect((error as CliError).hint).toBe(`See: foreman help ${name}`)
      expect((error as CliError).exitCode).toBe(2)
      expect((error as CliError).code).toBe('invalid')
    }
  })

  it('says when an option needs a value', () => {
    expect(() => parseCommandArgs(spec('send'), ['ws', '--tab'])).toThrowError(expect.objectContaining({ message: '--tab needs a value', exitCode: 2 }))
  })

  it('still takes text that starts with a dash after --', () => {
    expect(parseCommandArgs(spec('send'), ['ws', '--', '--fix', 'it']).positionals).toEqual(['ws', '--fix', 'it'])
  })
})
