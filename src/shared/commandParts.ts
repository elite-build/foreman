// A shell command as the parts a person agrees to (the tool approval, docs/agents.md 8): split where the shell chains
// commands (`&&`, `||`, `;`, `|`, `&`, a new line), each part with what it does when Foreman knows the command, whether it
// (or a command inside it) leaves this computer or can't be undone, and how it follows the part before. Pure and
// conservative: a command Foreman doesn't recognise gets no description rather than a guess, and a line it can't read
// (an unclosed quote or bracket) stays one part. Bash's rules, since agents run their commands through bash (Git Bash on
// Windows): quotes, backslash escapes, `$(…)`, backticks, subshells, here-documents, redirections, comments and
// `NAME=value` prefixes. Also the rules agents keep for "always allow" a command, and which parts one covers.
import type { TFunction } from './i18n'

/** How a part follows the one before it: `&&`, `||`, `;` or a new line, `|`, or after one sent to the background with `&`. */
export type CommandJoin = 'and' | 'or' | 'then' | 'pipe' | 'background'

/** Where a command's effects reach: this computer only, the network to fetch, or off this computer with something of ours. */
export type CommandReach = 'local' | 'network' | 'outward'

/** What a command does, in words the approval shows (`partLabel`). */
export type CommandDoes =
  | 'tests'
  | 'installs'
  | 'builds'
  | 'typechecks'
  | 'lints'
  | 'formats'
  | 'starts'
  | 'script'
  | 'status'
  | 'diff'
  | 'history'
  | 'stages'
  | 'commits'
  | 'switches'
  | 'discards'
  | 'stashes'
  | 'merges'
  | 'rebases'
  | 'resets'
  | 'deletesBranch'
  | 'pushes'
  | 'forcePushes'
  | 'pulls'
  | 'fetches'
  | 'clones'
  | 'pullRequest'
  | 'mergesPullRequest'
  | 'github'
  | 'githubReads'
  | 'githubApi'
  | 'publishes'
  | 'pushesImage'
  | 'deploys'
  | 'changesInfra'
  | 'changesCluster'
  | 'downloads'
  | 'sends'
  | 'connects'
  | 'copiesRemote'
  | 'deletes'
  | 'moves'
  | 'copies'
  | 'makesFolders'
  | 'createsFiles'
  | 'editsFiles'
  | 'lists'
  | 'reads'
  | 'searches'
  | 'finds'
  | 'prints'
  | 'changesFolder'

export interface CommandWhat {
  does: CommandDoes
  /** What the words name: a remote (`origin`), a host (`api.example.com`) or a script (`build`). */
  target?: string
  /** Absent where Foreman can't say (a project's own script can do anything). */
  reach?: CommandReach
  /** Deletes or overwrites what can't be got back (`rm`, `git reset --hard`, a force push). */
  destroys?: boolean
}

export interface CommandPart {
  /** The part as written, trimmed, for showing. */
  text: string
  /** The part without the `NAME=value` set before it: what an agent's command rule is matched against. */
  command: string
  /** The words the program gets, quotes and escapes removed, without the redirections and their files. */
  words: string[]
  /** Variables set for this part alone (`CI=1 npm test`): their names. */
  env: string[]
  /** How it follows the part before; absent on the first. */
  join?: CommandJoin
  /** What it does, when Foreman knows the command. */
  what?: CommandWhat
  /** It, or a command inside it (`$(…)`, a subshell, `bash -c`), sends something off this computer. */
  leaves: boolean
  /** It, or a command inside it, deletes or overwrites what can't be got back. */
  destroys: boolean
  /** A subshell's own parts: `(cd web && npm test)`. */
  group?: CommandPart[]
}

// ---- reading the line ----

interface Word {
  value: string
  start: number
}

interface RawPart {
  start: number
  end: number
  join?: CommandJoin
  words: Word[]
  nested: CommandPart[]
  group?: CommandPart[]
}

interface Scan {
  parts: RawPart[]
  end: number
}

class Unreadable extends Error {}

const SPACE = /\s/
const DELIMITER_END = /[\s;&|<>()]/

/** The parts of one list of commands, from `from` to the end, or to the `)` that closes a `$(` or `(`. */
function scanList(src: string, from: number, closer: boolean): Scan {
  const parts: RawPart[] = []
  let part: RawPart = { start: from, end: from, words: [], nested: [] }
  let word: Word | null = null
  // The next word is a redirection's file (or a here-string), not an argument.
  let redirectTarget = false
  const heredocs: { delimiter: string; tabs: boolean }[] = []
  let i = from

  const endWord = () => {
    if (word && redirectTarget) redirectTarget = false
    else if (word) part.words.push(word)
    word = null
  }
  const begin = (at: number) => (word ??= { value: '', start: at })
  const endPart = (at: number, next: number, join: CommandJoin | undefined) => {
    endWord()
    redirectTarget = false
    part.end = at
    if (part.words.length || part.group || part.nested.length) parts.push(part)
    // A part with nothing in it (`a ;; b`, a leading `;`) leaves the join to the next.
    part = { start: next, end: next, words: [], nested: [], join: parts.length ? join : undefined }
  }
  // Here-documents start on the line after their `<<`: their bodies are text, not commands.
  const skipHeredocs = (at: number): number => {
    let pos = at
    for (const doc of heredocs.splice(0)) {
      while (pos < src.length) {
        const nl = src.indexOf('\n', pos)
        const line = src.slice(pos, nl < 0 ? src.length : nl)
        pos = nl < 0 ? src.length : nl + 1
        if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break
      }
    }
    return pos
  }

  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') {
      // A line continuation joins the lines; any other escaped character is that character.
      if (src[i + 1] === '\n') i += 2
      else {
        begin(i).value += src[i + 1] ?? ''
        i += 2
      }
    } else if (ch === "'") {
      const close = src.indexOf("'", i + 1)
      if (close < 0) throw new Unreadable()
      begin(i).value += src.slice(i + 1, close)
      i = close + 1
    } else if (ch === '"') {
      const w = begin(i)
      i = scanDouble(src, i + 1, w, part.nested)
    } else if (ch === '`') {
      const w = begin(i)
      i = scanBackticks(src, i + 1, w, part.nested)
    } else if (ch === '$' && src[i + 1] === '(') {
      const w = begin(i)
      const inner = scanList(src, i + 2, true)
      part.nested.push(...toParts(src, inner.parts))
      w.value += src.slice(i, inner.end)
      i = inner.end
    } else if (ch === '$' && src[i + 1] === '{') {
      const close = src.indexOf('}', i + 2)
      if (close < 0) throw new Unreadable()
      begin(i).value += src.slice(i, close + 1)
      i = close + 1
    } else if (ch === ')' && closer) {
      endPart(i, i, undefined)
      return { parts, end: i + 1 }
    } else if (ch === '(' && !word && !part.words.length && !part.group) {
      // A subshell: its own list, one part here.
      const inner = scanList(src, i + 1, true)
      part.group = toParts(src, inner.parts)
      i = inner.end
    } else if (ch === '#' && !word) {
      while (i < src.length && src[i] !== '\n') i++
    } else if (ch === '\n') {
      // A part with here-documents ends after their bodies, which it shows.
      const bodies = heredocs.length > 0
      const next = bodies ? skipHeredocs(i + 1) : i + 1
      endPart(bodies ? next : i, next, 'then')
      i = next
    } else if (ch === ';') {
      const width = src[i + 1] === ';' ? 2 : 1
      endPart(i, i + width, 'then')
      i += width
    } else if (ch === '&' && src[i + 1] === '&') {
      endPart(i, i + 2, 'and')
      i += 2
    } else if (ch === '&' && src[i + 1] === '>') {
      // `&>file`, `&>>file`: both outputs to a file.
      endWord()
      i += src[i + 2] === '>' ? 3 : 2
      redirectTarget = true
    } else if (ch === '&') {
      endPart(i, i + 1, 'background')
      i++
    } else if (ch === '|' && src[i + 1] === '|') {
      endPart(i, i + 2, 'or')
      i += 2
    } else if (ch === '|') {
      const width = src[i + 1] === '&' ? 2 : 1
      endPart(i, i + width, 'pipe')
      i += width
    } else if (ch === '>' || ch === '<') {
      // A file descriptor written against it (`2>`) is part of the redirection, not a word.
      const current = word as Word | null
      if (current && /^\d+$/.test(current.value) && src.slice(current.start, i) === current.value) word = null
      else endWord()
      if (src[i + 1] === '(') {
        // Process substitution, `<(cmd)`: a command inside this one.
        const inner = scanList(src, i + 2, true)
        part.nested.push(...toParts(src, inner.parts))
        i = inner.end
      } else if (ch === '<' && src[i + 1] === '<' && src[i + 2] === '<') {
        i += 3
        redirectTarget = true
      } else if (ch === '<' && src[i + 1] === '<') {
        i += 2
        const tabs = src[i] === '-'
        if (tabs) i++
        while (src[i] === ' ' || src[i] === '\t') i++
        let delimiter = ''
        while (i < src.length && !DELIMITER_END.test(src[i])) {
          if (src[i] !== '"' && src[i] !== "'" && src[i] !== '\\') delimiter += src[i]
          i++
        }
        if (delimiter) heredocs.push({ delimiter, tabs })
      } else {
        i++
        if (src[i] === '>' || src[i] === '|') i++
        if (src[i] === '&') {
          // `>&2`, `2>&1`: to another descriptor, no file.
          i++
          while (i < src.length && /[\d-]/.test(src[i])) i++
        } else redirectTarget = true
      }
    } else if (SPACE.test(ch)) {
      endWord()
      i++
    } else {
      begin(i).value += ch
      i++
    }
  }
  if (closer) throw new Unreadable()
  endPart(src.length, src.length, undefined)
  return { parts, end: src.length }
}

/** Inside double quotes from `from`: escapes, `$(…)` and backticks; returns where the closing quote ends. */
function scanDouble(src: string, from: number, word: Word, nested: CommandPart[]): number {
  let i = from
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"') return i + 1
    if (ch === '\\') {
      const next = src[i + 1] ?? ''
      if (next === '\n') {
        // A line continuation inside quotes.
      } else if ('$`"\\'.includes(next)) word.value += next
      else word.value += `\\${next}`
      i += 2
    } else if (ch === '$' && src[i + 1] === '(') {
      const inner = scanList(src, i + 2, true)
      nested.push(...toParts(src, inner.parts))
      word.value += src.slice(i, inner.end)
      i = inner.end
    } else if (ch === '`') {
      i = scanBackticks(src, i + 1, word, nested)
    } else {
      word.value += ch
      i++
    }
  }
  throw new Unreadable()
}

/** An old-style command substitution, `` `cmd` ``: read its command as a line of its own. */
function scanBackticks(src: string, from: number, word: Word, nested: CommandPart[]): number {
  let i = from
  let inner = ''
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\' && i + 1 < src.length) {
      inner += src[i + 1]
      i += 2
    } else inner += src[i++]
  }
  if (i >= src.length) throw new Unreadable()
  nested.push(...commandParts(inner))
  word.value += src.slice(from - 1, i + 1)
  return i + 1
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function toParts(src: string, raw: RawPart[]): CommandPart[] {
  return raw.map((p, n) => {
    const words = p.words.map((w) => w.value)
    let envCount = 0
    while (envCount < words.length && ASSIGNMENT.test(words[envCount])) envCount++
    const text = src.slice(p.start, p.end).trim()
    const firstWord = p.words[envCount]
    const command = firstWord ? src.slice(firstWord.start, p.end).trim() : p.group ? text : ''
    const found = p.group ? {} : analyse(words)
    const inner = [...p.nested, ...(p.group ?? []), ...(found.nested ?? [])]
    const what = found.what
    return {
      text,
      command,
      words: words.slice(envCount),
      env: words.slice(0, envCount).map((w) => w.slice(0, w.indexOf('='))),
      ...(n > 0 && p.join ? { join: p.join } : {}),
      ...(what ? { what } : {}),
      leaves: what?.reach === 'outward' || inner.some((x) => x.leaves),
      destroys: Boolean(what?.destroys) || inner.some((x) => x.destroys),
      ...(p.group ? { group: p.group } : {})
    }
  })
}

/**
 * A command line as its parts, in order. A line Foreman can't read (an unclosed quote, bracket or substitution) is one part
 * with no description, so nothing is split or named on a guess.
 */
export function commandParts(command: string): CommandPart[] {
  try {
    return toParts(command, scanList(command, 0, false).parts)
  } catch (err) {
    if (!(err instanceof Unreadable)) throw err
    const text = command.trim()
    return text ? [{ text, command: text, words: [], env: [], leaves: false, destroys: false }] : []
  }
}

// ---- what a command does ----

interface Analysis {
  what?: CommandWhat
  // Commands it runs itself: `bash -c "…"`, `eval`.
  nested?: CommandPart[]
}

/** A program's name as typed, without its folder or a Windows extension: `/usr/bin/git` and `git.exe` are `git`. */
function programName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '')
}

// Programs that run the command after them, with their options that take a value.
const WRAPPERS: Record<string, string[]> = {
  sudo: ['-u', '-g', '-C', '-h', '-p', '-U', '-r', '-t', '-D'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S', '--unset', '--chdir'],
  time: ['-f', '-o'],
  nohup: [],
  exec: ['-a'],
  command: [],
  builtin: [],
  nice: ['-n'],
  stdbuf: ['-i', '-o', '-e'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  xargs: ['-I', '-i', '-n', '-P', '-d', '-L', '-l', '-s', '-E', '-e', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace', '--max-lines']
}

// Shell words that start a part without being its program: `then git push`, `do rm "$f"`.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{'])

/** The words of the command that actually runs: past `NAME=value`, `sudo`, `env`, `time`, `xargs`, `then` and the like. */
function unwrap(words: readonly string[]): string[] {
  let w = [...words]
  for (let guard = 0; guard < 8 && w.length; guard++) {
    let skip = 0
    while (skip < w.length && (ASSIGNMENT.test(w[skip]) || KEYWORDS.has(w[skip]))) skip++
    if (skip) {
      w = w.slice(skip)
      continue
    }
    const name = programName(w[0])
    const valued = WRAPPERS[name]
    if (!valued) break
    let j = 1
    while (j < w.length && w[j].startsWith('-') && w[j] !== '--') j += valued.includes(w[j]) ? 2 : 1
    if (w[j] === '--') j++
    if (name === 'timeout' && j < w.length) j++
    w = w.slice(j)
  }
  return w
}

/** The arguments that aren't options, skipping the values of the options that take one. */
function positional(args: readonly string[], valued: readonly string[] = []): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      out.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith('-') && a.length > 1) {
      if (valued.includes(a)) i++
      continue
    }
    out.push(a)
  }
  return out
}

const has = (args: readonly string[], ...flags: string[]) => args.some((a) => flags.includes(a))
const hasPrefix = (args: readonly string[], ...prefixes: string[]) => args.some((a) => prefixes.some((p) => a.startsWith(p)))

const local = (does: CommandDoes, extra: Partial<CommandWhat> = {}): CommandWhat => ({ does, reach: 'local', ...extra })
const network = (does: CommandDoes, target?: string): CommandWhat => ({ does, reach: 'network', ...(target ? { target } : {}) })
const outward = (does: CommandDoes, extra: Partial<CommandWhat> = {}): CommandWhat => ({ does, reach: 'outward', ...extra })

/** A project script by its name: `test`, `build` and the like say what they do; any other is "Runs the x script". */
function script(name: string | undefined): CommandWhat | undefined {
  if (!name) return undefined
  if (/^(test|tests|spec|e2e)\b|[:_-](test|tests|spec|e2e)\b/.test(name)) return local('tests')
  if (/^build\b/.test(name)) return local('builds')
  if (/^(typecheck|type-check|check-types|types|tsc)\b/.test(name)) return local('typechecks')
  if (/^lint\b/.test(name)) return local('lints')
  if (/^(format|fmt|prettier)\b/.test(name)) return local('formats')
  if (/^(dev|start|serve|preview)\b/.test(name)) return local('starts')
  return { does: 'script', target: name }
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])
const POWERSHELLS = new Set(['pwsh', 'powershell'])

function analyse(words: readonly string[]): Analysis {
  const w = unwrap(words)
  if (!w.length) return {}
  const name = programName(w[0])
  const args = w.slice(1)
  if (SHELLS.has(name)) {
    const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a))
    return c >= 0 && args[c + 1] !== undefined ? { nested: commandParts(args[c + 1]) } : {}
  }
  if (POWERSHELLS.has(name)) {
    const c = args.findIndex((a) => /^-(c|command)$/i.test(a))
    return c >= 0 ? { nested: commandParts(args.slice(c + 1).join(' ')) } : {}
  }
  if (name === 'eval') return { nested: commandParts(args.join(' ')) }
  const what = describe(name, args)
  return what ? { what } : {}
}

function describe(name: string, args: string[]): CommandWhat | undefined {
  switch (name) {
    case 'npm':
      return npm(args)
    case 'yarn':
    case 'pnpm':
    case 'bun':
      return packageManager(name, args)
    case 'npx':
    case 'pnpx':
    case 'bunx':
      return runner(args)
    case 'git':
      return git(args)
    case 'gh':
      return github(args)
    case 'curl':
    case 'wget':
    case 'invoke-webrequest':
    case 'iwr':
    case 'invoke-restmethod':
    case 'irm':
      return web(name, args)
    case 'ssh':
    case 'nc':
    case 'ncat':
    case 'telnet':
    case 'ftp': {
      const host = positional(args, ['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'])[0]
      return host ? outward('connects', { target: host.replace(/^[^@]*@/, '') }) : undefined
    }
    case 'scp':
    case 'sftp':
    case 'rsync': {
      const remote = args.map((a) => /^(?:[^@\s/\\]+@)?([^:\s/\\]{2,}):/.exec(a)).find(Boolean)
      if (remote) return outward('copiesRemote', { target: remote[1], ...(hasPrefix(args, '--delete') ? { destroys: true } : {}) })
      return name === 'sftp' ? undefined : local('copies', hasPrefix(args, '--delete') ? { destroys: true } : {})
    }
    case 'docker':
    case 'podman': {
      const sub = positional(args)[0]
      if (sub === 'push') return outward('pushesImage')
      if (sub === 'pull') return network('downloads')
      if (sub === 'build') return local('builds')
      return undefined
    }
    case 'kubectl':
    case 'helm': {
      const sub = positional(args, ['-n', '--namespace', '--context', '-f', '--filename'])[0]
      if (['delete', 'uninstall'].includes(sub)) return outward('changesCluster', { destroys: true })
      if (['apply', 'create', 'patch', 'replace', 'scale', 'set', 'rollout', 'edit', 'label', 'annotate', 'expose', 'run', 'cordon', 'drain', 'taint', 'install', 'upgrade', 'rollback'].includes(sub)) return outward('changesCluster')
      return undefined
    }
    case 'terraform':
    case 'tofu': {
      const sub = positional(args)[0]
      if (sub === 'destroy') return outward('changesInfra', { destroys: true })
      if (sub === 'apply' || sub === 'import') return outward('changesInfra')
      return undefined
    }
    case 'vercel': {
      const sub = positional(args)[0]
      return !sub || sub === 'deploy' ? outward('deploys') : undefined
    }
    case 'netlify':
    case 'fly':
    case 'flyctl':
    case 'firebase':
    case 'wrangler':
    case 'railway':
    case 'gcloud':
      return args.some((a) => a === 'deploy' || a === 'publish' || (name === 'railway' && a === 'up')) ? outward('deploys') : undefined
    case 'cargo':
      return cargo(args)
    case 'go':
      return golang(args)
    case 'python':
    case 'python3':
    case 'py': {
      const m = args.indexOf('-m')
      return m >= 0 && args[m + 1] ? analyse(args.slice(m + 1)).what : undefined
    }
    case 'pip':
    case 'pip3':
      return positional(args)[0] === 'install' ? network('installs') : undefined
    case 'uv':
    case 'poetry': {
      const [sub, next] = positional(args)
      if (sub === 'run') return analyse(args.slice(args.indexOf('run') + 1)).what
      if (sub === 'publish') return outward('publishes')
      if (sub === 'add' || sub === 'install' || sub === 'sync' || (sub === 'pip' && next === 'install')) return network('installs')
      return undefined
    }
    case 'pytest':
    case 'vitest':
    case 'jest':
    case 'mocha':
    case 'ava':
    case 'phpunit':
    case 'rspec':
    case 'unittest':
      return local('tests')
    case 'playwright':
    case 'cypress': {
      const sub = positional(args)[0]
      if (sub === 'install') return network('installs')
      return sub === 'test' || sub === 'run' ? local('tests') : undefined
    }
    case 'tsc':
    case 'vue-tsc':
      return local(has(args, '--noEmit') ? 'typechecks' : 'builds')
    case 'mypy':
    case 'pyright':
      return local('typechecks')
    case 'eslint':
    case 'flake8':
    case 'pylint':
    case 'stylelint':
    case 'golangci-lint':
      return local('lints')
    case 'ruff':
      return local(positional(args)[0] === 'format' ? 'formats' : 'lints')
    case 'biome':
      return local(positional(args)[0] === 'format' ? 'formats' : 'lints')
    case 'prettier':
    case 'black':
    case 'gofmt':
    case 'rustfmt':
      return local('formats')
    case 'make':
    case 'gmake': {
      const target = positional(args, ['-C', '-f', '-j']).find((a) => !a.includes('='))
      return !target || target === 'all' ? local('builds') : script(target)
    }
    case 'dotnet': {
      const [sub, next] = positional(args)
      if (sub === 'test') return local('tests')
      if (sub === 'build' || sub === 'publish') return local('builds')
      if (sub === 'restore' || (sub === 'add' && next === 'package')) return network('installs')
      if (sub === 'nuget' && next === 'push') return outward('publishes')
      return undefined
    }
    case 'mvn':
    case 'gradle':
    case 'gradlew': {
      const goals = positional(args)
      if (goals.some((g) => /deploy|publish/i.test(g))) return outward('publishes')
      if (goals.some((g) => /test/i.test(g))) return local('tests')
      if (goals.some((g) => /^(install|build|package|assemble|compile)/i.test(g))) return local('builds')
      return undefined
    }
    case 'twine':
      return positional(args)[0] === 'upload' ? outward('publishes') : undefined
    case 'gem': {
      const sub = positional(args)[0]
      if (sub === 'push') return outward('publishes')
      return sub === 'install' ? network('installs') : undefined
    }
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'shred':
    case 'del':
    case 'erase':
    case 'rd':
    case 'remove-item':
    case 'ri':
      return local('deletes', { destroys: true })
    case 'find':
      return has(args, '-delete') || args.some((a, n) => (a === '-exec' || a === '-execdir') && ['rm', 'shred', 'unlink'].includes(programName(args[n + 1] ?? '')))
        ? local('deletes', { destroys: true })
        : local('finds')
    case 'fd':
    case 'locate':
      return local('finds')
    case 'mv':
    case 'move':
    case 'move-item':
      return local('moves')
    case 'cp':
    case 'copy':
    case 'copy-item':
    case 'xcopy':
    case 'robocopy':
      return local('copies')
    case 'mkdir':
    case 'md':
      return local('makesFolders')
    case 'new-item':
      return local(args.some((a, n) => /^-itemtype$/i.test(args[n - 1] ?? '') && /^directory$/i.test(a)) ? 'makesFolders' : 'createsFiles')
    case 'touch':
      return local('createsFiles')
    case 'sed':
      return has(args, '-i', '--in-place') || hasPrefix(args, '-i.', '--in-place=') ? local('editsFiles') : undefined
    case 'perl':
      return hasPrefix(args, '-i', '-pi') ? local('editsFiles') : undefined
    case 'ls':
    case 'dir':
    case 'tree':
    case 'exa':
    case 'eza':
    case 'get-childitem':
    case 'gci':
      return local('lists')
    case 'cat':
    case 'head':
    case 'tail':
    case 'less':
    case 'more':
    case 'bat':
    case 'get-content':
    case 'gc':
      return local('reads')
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'rg':
    case 'ag':
    case 'ack':
    case 'findstr':
    case 'select-string':
    case 'sls':
      return local('searches')
    case 'echo':
    case 'printf':
    case 'write-output':
    case 'write-host':
      return local('prints')
    case 'cd':
    case 'pushd':
    case 'popd':
    case 'set-location':
      return local('changesFolder')
    default:
      return undefined
  }
}

function npm(args: string[]): CommandWhat | undefined {
  const pos = positional(args, ['--prefix', '-w', '--workspace'])
  const sub = pos[0]
  if (!sub) return undefined
  if (['test', 't', 'tst'].includes(sub)) return local('tests')
  if (['install', 'i', 'ci', 'add', 'in', 'update', 'up'].includes(sub)) return network('installs')
  if (sub === 'publish') return outward('publishes')
  if (sub === 'run' || sub === 'run-script') return script(pos[1])
  if (sub === 'start') return local('starts')
  if (sub === 'exec' || sub === 'x') return runner(args.slice(args.indexOf(sub) + 1))
  return undefined
}

function packageManager(name: string, args: string[]): CommandWhat | undefined {
  const pos = positional(args, ['--cwd', '-C', '--dir', '--filter', '-F'])
  const sub = pos[0]
  if (!sub) return name === 'yarn' ? network('installs') : undefined
  if (sub === 'test') return local('tests')
  if (['install', 'add', 'i', 'up', 'upgrade', 'update'].includes(sub)) return network('installs')
  if (sub === 'publish') return outward('publishes')
  if (sub === 'run') return script(pos[1])
  if (sub === 'start') return local('starts')
  if (sub === 'dlx' || sub === 'x' || sub === 'exec') return runner(args.slice(args.indexOf(sub) + 1))
  if (name === 'bun') return sub === 'build' ? local('builds') : undefined
  // `yarn build`, `pnpm lint`: a script by its name.
  return script(sub)
}

/** `npx vitest run`: what the tool it runs does, when Foreman knows it. */
function runner(args: string[]): CommandWhat | undefined {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) i += args[i] === '-p' || args[i] === '--package' ? 2 : 1
  return i < args.length ? analyse(args.slice(i)).what : undefined
}

function git(args: string[]): CommandWhat | undefined {
  // Options before the subcommand: `-C dir`, `-c key=value`, `--no-pager`.
  let i = 0
  while (i < args.length && args[i].startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
  const sub = args[i]
  const rest = args.slice(i + 1)
  const pos = positional(rest, ['-m', '-o', '--repo', '--push-option', '-b', '-B', '--format', '-n'])
  switch (sub) {
    case 'push': {
      const remote = positional(rest, ['-o', '--push-option', '--repo', '--receive-pack', '--exec'])[0]
      const target = remote ? { target: remote } : {}
      if (has(rest, '--dry-run', '-n')) return network('pushes', remote)
      const force = has(rest, '-f', '--force', '--mirror') || hasPrefix(rest, '--force-with-lease', '--force-if-includes') || positional(rest).slice(1).some((r) => r.startsWith('+'))
      const deletes = has(rest, '-d', '--delete', '--prune') || positional(rest).slice(1).some((r) => r.startsWith(':'))
      return outward(force ? 'forcePushes' : 'pushes', { ...target, ...(force || deletes ? { destroys: true } : {}) })
    }
    case 'pull':
      return network('pulls', pos[0])
    case 'fetch':
    case 'ls-remote':
      return network('fetches', has(rest, '--all') ? undefined : pos[0])
    case 'clone':
      return network('clones')
    case 'status':
      return local('status')
    case 'diff':
      return local('diff')
    case 'log':
    case 'show':
    case 'blame':
    case 'reflog':
    case 'shortlog':
      return local('history')
    case 'add':
      return local('stages')
    case 'commit':
    case 'cherry-pick':
      return local('commits')
    case 'switch':
      return has(rest, '--discard-changes', '-f', '--force') ? local('discards', { destroys: true }) : local('switches')
    case 'checkout':
      return has(rest, '--', '.', '-f', '--force') ? local('discards', { destroys: true }) : local('switches')
    case 'restore':
      return has(rest, '--staged', '-S') && !has(rest, '--worktree', '-W') ? local('stages') : local('discards', { destroys: true })
    case 'reset':
      return has(rest, '--hard', '--merge', '--keep') ? local('discards', { destroys: true }) : local('resets')
    case 'clean':
      return has(rest, '-n', '--dry-run') ? local('lists') : local('deletes', { destroys: true })
    case 'rm':
      return local('deletes', { destroys: true })
    case 'mv':
      return local('moves')
    case 'stash':
      return pos[0] === 'drop' || pos[0] === 'clear' ? local('discards', { destroys: true }) : local('stashes')
    case 'merge':
      return local('merges')
    case 'rebase':
      return local('rebases')
    case 'branch':
      if (has(rest, '-D') || (has(rest, '-d', '--delete') && has(rest, '-f', '--force'))) return local('deletesBranch', { destroys: true })
      return has(rest, '-d', '--delete') ? local('deletesBranch') : undefined
    default:
      return undefined
  }
}

function github(args: string[]): CommandWhat | undefined {
  const pos = positional(args, ['-R', '--repo', '-t', '--title', '-b', '--body', '-B', '--base', '-H', '--head', '-X', '--method', '-f', '-F', '--field', '--raw-field', '-H', '--header', '--input', '-q', '--jq', '-L', '--limit', '-s', '--state', '-l', '--label', '-a', '--assignee', '-m', '--milestone', '-r', '--reviewer', '-w'])
  const [group, action] = pos
  if (group === 'api') {
    const methodAt = args.findIndex((a) => a === '-X' || a === '--method')
    const method = (methodAt >= 0 ? args[methodAt + 1] : args.find((a) => a.startsWith('--method='))?.slice(9) ?? args.find((a) => /^-X\w/.test(a))?.slice(2)) ?? ''
    const sends = (method && !/^(get|head)$/i.test(method)) || has(args, '-f', '-F', '--field', '--raw-field', '--input')
    return sends ? outward('githubApi', /^delete$/i.test(method) ? { destroys: true } : {}) : network('githubApi')
  }
  if (group === 'pr') {
    if (action === 'create') return outward('pullRequest')
    if (action === 'merge') return outward('mergesPullRequest')
    if (action === 'checkout') return network('switches')
    if (['view', 'list', 'diff', 'checks', 'status'].includes(action)) return network('githubReads')
    return ['close', 'edit', 'comment', 'review', 'ready', 'reopen', 'lock', 'unlock'].includes(action) ? outward('github') : undefined
  }
  if (group === 'issue' || group === 'repo' || group === 'release' || group === 'run' || group === 'workflow' || group === 'label' || group === 'gist' || group === 'secret' || group === 'variable') {
    if (['view', 'list', 'status', 'watch', 'download'].includes(action)) return network('githubReads')
    if (group === 'repo' && action === 'clone') return network('clones')
    if (group === 'release' && (action === 'create' || action === 'upload')) return outward('publishes')
    if (action === 'delete') return outward('github', { destroys: true })
    return action ? outward('github') : undefined
  }
  return undefined
}

const LOCALHOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?$/i

/** The host of a URL or `host/path` word, lower case: `https://API.example.com/x` is `api.example.com`. */
function hostOf(address: string): string | undefined {
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `http://${address}`
  try {
    return new URL(url).host.toLowerCase() || undefined
  } catch {
    return undefined
  }
}

function web(name: string, args: string[]): CommandWhat | undefined {
  const powershell = !['curl', 'wget'].includes(name)
  const lower = args.map((a) => a.toLowerCase())
  let address: string | undefined
  let method = ''
  let sends = false
  if (powershell) {
    const valueOf = (flag: string) => {
      const at = lower.indexOf(flag)
      return at >= 0 ? args[at + 1] : undefined
    }
    address = valueOf('-uri') ?? positional(args, ['-method', '-body', '-infile', '-outfile', '-headers', '-contenttype', '-uri'])[0]
    method = valueOf('-method') ?? ''
    sends = lower.includes('-body') || lower.includes('-infile')
  } else {
    address = args.find((a) => /^[a-z][a-z0-9+.-]*:\/\//i.test(a)) ?? positional(args, ['-o', '-O', '-H', '--header', '-X', '--request', '-d', '--data', '-F', '--form', '-u', '--user', '-T', '--upload-file', '-A', '--user-agent', '-e', '--referer', '-w', '--write-out', '-b', '--cookie', '-c', '--cookie-jar', '--json', '--output-document', '-P'])[0]
    const at = args.findIndex((a) => a === '-X' || a === '--request')
    method = at >= 0 ? (args[at + 1] ?? '') : (args.find((a) => /^-X\w/.test(a))?.slice(2) ?? args.find((a) => /^--(request|method)=/.test(a))?.replace(/^--\w+=/, '') ?? '')
    sends =
      has(args, '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '-F', '--form', '--form-string', '-T', '--upload-file', '--json', '--post-data', '--post-file', '--body-data', '--body-file') ||
      hasPrefix(args, '--data=', '--data-raw=', '--data-binary=', '--data-urlencode=', '--json=', '--post-data=', '--post-file=', '--body-data=', '--upload-file=') ||
      args.some((a) => /^-[dFT]./.test(a))
  }
  if (method && !/^(get|head|options)$/i.test(method)) sends = true
  const host = address ? hostOf(address) : undefined
  const target = host ? { target: host } : {}
  if (host && LOCALHOST.test(host)) return local(sends ? 'sends' : 'downloads', target)
  return sends ? outward('sends', target) : { does: 'downloads', reach: 'network', ...target }
}

function cargo(args: string[]): CommandWhat | undefined {
  switch (positional(args)[0]) {
    case 'test':
    case 'nextest':
      return local('tests')
    case 'build':
      return local('builds')
    case 'check':
      return local('typechecks')
    case 'clippy':
      return local('lints')
    case 'fmt':
      return local('formats')
    case 'add':
    case 'install':
    case 'fetch':
    case 'update':
      return network('installs')
    case 'publish':
      return outward('publishes')
    case 'run':
      return local('starts')
    default:
      return undefined
  }
}

function golang(args: string[]): CommandWhat | undefined {
  const [sub, next] = positional(args)
  switch (sub) {
    case 'test':
      return local('tests')
    case 'build':
    case 'install':
      return local('builds')
    case 'vet':
      return local('lints')
    case 'fmt':
      return local('formats')
    case 'get':
      return network('installs')
    case 'mod':
      return next === 'download' || next === 'tidy' ? network('installs') : undefined
    case 'run':
      return local('starts')
    default:
      return undefined
  }
}

// ---- the words ----

/** "Runs tests", "Pushes to origin": what a part does, in words. */
export function partLabel(what: CommandWhat, t: TFunction): string {
  const target = what.target ?? ''
  switch (what.does) {
    case 'tests':
      return t('commandPart.tests')
    case 'installs':
      return t('commandPart.installs')
    case 'builds':
      return t('commandPart.builds')
    case 'typechecks':
      return t('commandPart.typechecks')
    case 'lints':
      return t('commandPart.lints')
    case 'formats':
      return t('commandPart.formats')
    case 'starts':
      return t('commandPart.starts')
    case 'script':
      return t('commandPart.script', { name: target })
    case 'status':
      return t('commandPart.status')
    case 'diff':
      return t('commandPart.diff')
    case 'history':
      return t('commandPart.history')
    case 'stages':
      return t('commandPart.stages')
    case 'commits':
      return t('commandPart.commits')
    case 'switches':
      return t('commandPart.switches')
    case 'discards':
      return t('commandPart.discards')
    case 'stashes':
      return t('commandPart.stashes')
    case 'merges':
      return t('commandPart.merges')
    case 'rebases':
      return t('commandPart.rebases')
    case 'resets':
      return t('commandPart.resets')
    case 'deletesBranch':
      return t('commandPart.deletesBranch')
    case 'pushes':
      return target ? t('commandPart.pushes', { remote: target }) : t('commandPart.pushesDefault')
    case 'forcePushes':
      return target ? t('commandPart.forcePushes', { remote: target }) : t('commandPart.forcePushesDefault')
    case 'pulls':
      return target ? t('commandPart.pulls', { remote: target }) : t('commandPart.pullsDefault')
    case 'fetches':
      return target ? t('commandPart.fetches', { remote: target }) : t('commandPart.fetchesDefault')
    case 'clones':
      return t('commandPart.clones')
    case 'pullRequest':
      return t('commandPart.pullRequest')
    case 'mergesPullRequest':
      return t('commandPart.mergesPullRequest')
    case 'github':
      return t('commandPart.github')
    case 'githubReads':
      return t('commandPart.githubReads')
    case 'githubApi':
      return t('commandPart.githubApi')
    case 'publishes':
      return t('commandPart.publishes')
    case 'pushesImage':
      return t('commandPart.pushesImage')
    case 'deploys':
      return t('commandPart.deploys')
    case 'changesInfra':
      return t('commandPart.changesInfra')
    case 'changesCluster':
      return t('commandPart.changesCluster')
    case 'downloads':
      return target ? t('commandPart.downloads', { host: target }) : t('commandPart.downloadsDefault')
    case 'sends':
      return target ? t('commandPart.sends', { host: target }) : t('commandPart.sendsDefault')
    case 'connects':
      return t('commandPart.connects', { host: target })
    case 'copiesRemote':
      return t('commandPart.copiesRemote', { host: target })
    case 'deletes':
      return t('commandPart.deletes')
    case 'moves':
      return t('commandPart.moves')
    case 'copies':
      return t('commandPart.copies')
    case 'makesFolders':
      return t('commandPart.makesFolders')
    case 'createsFiles':
      return t('commandPart.createsFiles')
    case 'editsFiles':
      return t('commandPart.editsFiles')
    case 'lists':
      return t('commandPart.lists')
    case 'reads':
      return t('commandPart.reads')
    case 'searches':
      return t('commandPart.searches')
    case 'finds':
      return t('commandPart.finds')
    case 'prints':
      return t('commandPart.prints')
    case 'changesFolder':
      return t('commandPart.changesFolder')
  }
}

/** "only if that succeeds": how a part follows the one before, in words. */
export function joinLabel(join: CommandJoin, t: TFunction): string {
  switch (join) {
    case 'and':
      return t('commandPart.join.and')
    case 'or':
      return t('commandPart.join.or')
    case 'then':
      return t('commandPart.join.then')
    case 'pipe':
      return t('commandPart.join.pipe')
    case 'background':
      return t('commandPart.join.background')
  }
}

// Programs whose second word says what they do: `git push`, `npm test`.
const WITH_SUBCOMMAND = new Set(['git', 'npm', 'yarn', 'pnpm', 'bun', 'gh', 'docker', 'podman', 'kubectl', 'helm', 'cargo', 'go', 'pip', 'pip3', 'uv', 'poetry', 'terraform', 'tofu', 'dotnet', 'npx', 'pnpx', 'bunx', 'gem', 'twine', 'vercel', 'netlify', 'fly', 'flyctl', 'firebase', 'wrangler'])

/** A part as a person names it: `git push`, `npm test`, `rm`; a subshell or a line Foreman can't read by its text. */
export function partName(part: CommandPart): string {
  const w = unwrap(part.words)
  if (!w.length) return part.text
  const name = programName(w[0])
  if (!WITH_SUBCOMMAND.has(name)) return w[0]
  let i = 1
  if (name === 'git') while (i < w.length && w[i].startsWith('-')) i += w[i] === '-C' || w[i] === '-c' ? 2 : 1
  else while (i < w.length && w[i].startsWith('-')) i++
  return w[i] ? `${w[0]} ${w[i]}` : w[0]
}

const ONLY_LOOKS: ReadonlySet<CommandDoes> = new Set(['status', 'diff', 'history', 'lists', 'reads', 'searches', 'finds', 'prints', 'changesFolder'])

/** A part that only looks (`git status`, `ls`, `cd`) and runs nothing inside it: agents commonly let these through without asking. */
export function onlyLooks(part: CommandPart): boolean {
  return Boolean(part.what && ONLY_LOOKS.has(part.what.does)) && !part.leaves && !part.destroys
}

// ---- always-allow rules ----

/** A rule an agent keeps for "always allow" a command: every command that starts with `command`, or that command only. */
export interface CommandRule {
  prefix: boolean
  command: string
}

const oneLine = (text: string) => text.trim().replace(/\s+/g, ' ')

/** Claude Code's Bash rule content: `npm test:*` (or `npm test *`) is a prefix; anything else is the exact command. */
export function commandRule(content: string): CommandRule {
  const m = /^(.*?)(?::\*| \*)$/.exec(content.trim())
  return m ? { prefix: true, command: oneLine(m[1]) } : { prefix: false, command: oneLine(content) }
}

/**
 * Which parts of `command` the rules let through without asking, one flag per part: a prefix rule covers a part that
 * starts with it (word by word), an exact rule a part that is it, and a rule for the whole line every part.
 */
export function coveredParts(command: string, parts: readonly CommandPart[], rules: readonly CommandRule[]): boolean[] {
  const whole = oneLine(command)
  if (rules.some((r) => !r.prefix && r.command === whole)) return parts.map(() => true)
  return parts.map((part) => {
    const text = oneLine(part.command)
    return rules.some((r) => (r.prefix ? text === r.command || text.startsWith(`${r.command} `) : text === r.command))
  })
}

export interface RuleReach {
  /** Parts the rules leave out, by name (`git push`), that will still ask; parts that only look aren't named. */
  notCovered: string[]
  /** Parts the rules let through that leave this computer. */
  leaves: string[]
  /** Parts the rules let through that can't be undone (and don't leave this computer: that is said first). */
  destroys: string[]
}

/** What always-allow's rules come to for this command: the parts they leave out, and the risky parts they let through. */
export function ruleReach(command: string, rules: readonly CommandRule[]): RuleReach {
  const parts = commandParts(command)
  const covered = coveredParts(command, parts, rules)
  const names = (pick: (part: CommandPart, n: number) => boolean) => [...new Set(parts.filter(pick).map(partName))]
  return {
    notCovered: names((p, n) => !covered[n] && !onlyLooks(p)),
    leaves: names((p, n) => covered[n] && p.leaves),
    destroys: names((p, n) => covered[n] && p.destroys && !p.leaves)
  }
}
