// The child-process guard (AGENTS.md, "Project and architecture": reuse the platform quoting and process helpers,
// never assume POSIX shells on Windows). Code in src/main that starts a process with node:child_process (spawn, exec,
// execFile, fork and their Sync forms) directly, outside the helper modules, is counted per file and held to a ratchet:
// a count may go down, never up, and a file with no baseline entry may have none. The baseline holds the call sites
// that were there when the guard came, each a service with its own process to run; they are not refactored here.
// A new one runs its process through what exists: git() in git.ts for git, platform.ts (scriptShell, shellSnippet,
// treeSpawnOptions, killProcessTree, shellQuote, agentBaseEnv, findOnPath) and shells.ts for shells and quoting, the
// scripts service (scripts.ts) for a repository's scripts. A new kind of launch belongs in platform.ts, with its tests.
// After lowering counts, write them down (the rewrite refuses any count that went up):
//   UPDATE_CP_BASELINE=1 npx vitest run tests/childProcess.test.ts
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN = 'src/main'
const BASELINE = 'tests/childProcess.baseline.json'

// The helper modules: where the platform's process and quoting rules live, so they call child_process themselves.
const HELPERS: Record<string, string> = {
  'src/main/platform.ts': 'The process helpers: spawn options, the script shell, killing a process tree (taskkill on Windows), the login shell’s environment.',
  'src/main/shells.ts': 'Finds Windows shells, and asks wsl.exe for its distributions.'
}

// One import statement: its clause holds no quote, so a match never runs on from an earlier import of another module.
const IMPORT = /\bimport\s+(type\s+)?([^;'"]*?)\s+from\s+['"](?:node:)?child_process['"]/g
const DYNAMIC = /import\(\s*['"](?:node:)?child_process['"]\s*\)/g
const escape = (s: string) => s.replace(/[$]/g, '\\$')

/**
 * How many times a file uses node:child_process directly: each call of a function it imports as a value (or passes on,
 * as `promisify(execFile)`), each `cp.x(` through a namespace or default import, each dynamic import; at least one for
 * a value import used some other way. Type-only imports (`import type`, `type ChildProcess`) are not uses.
 */
function directUses(source: string): number {
  let uses = 0
  let imported = false
  const names: string[] = []
  const namespaces: string[] = []
  const body = source.replace(IMPORT, (_all, typeOnly: string | undefined, clause: string) => {
    if (typeOnly) return ''
    const braces = /\{([^}]*)\}/.exec(clause)
    for (const spec of (braces?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      if (spec.startsWith('type ')) continue
      names.push(spec.split(/\s+as\s+/).pop()!.trim())
    }
    const bare = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+/, '').split(',').map((s) => s.trim()).filter(Boolean)
    namespaces.push(...bare)
    imported ||= names.length > 0 || bare.length > 0
    return ''
  })
  for (const name of names) uses += body.match(new RegExp(`(?<![\\w$.])${escape(name)}(?=\\s*[(,)])`, 'g'))?.length ?? 0
  for (const ns of namespaces) uses += body.match(new RegExp(`(?<![\\w$.])${escape(ns)}\\.\\w+\\s*\\(`, 'g'))?.length ?? 0
  uses += body.match(DYNAMIC)?.length ?? 0
  return imported ? Math.max(uses, 1) : uses
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = join(dir, name)
    if (statSync(file).isDirectory()) return sources(file)
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [file] : []
  })
}

type Counts = Record<string, number>

/** Every file's direct uses, the helper modules left out. */
function scanMain(): Counts {
  const counts: Counts = {}
  for (const file of sources(MAIN)) {
    const key = relative(process.cwd(), file).split(sep).join('/')
    if (HELPERS[key]) continue
    const n = directUses(readFileSync(file, 'utf8'))
    if (n) counts[key] = n
  }
  return Object.fromEntries(Object.keys(counts).sort().map((file) => [file, counts[file]]))
}

function overBaseline(now: Counts, baseline: Counts): string[] {
  return Object.entries(now).flatMap(([file, n]) => (n > (baseline[file] ?? 0) ? [`${file}: ${baseline[file] ?? 0} → ${n}`] : []))
}

const FAILURE = [
  'New direct node:child_process use in src/main. Run the process through the helpers instead:',
  'git() in src/main/git.ts for git; platform.ts (scriptShell, shellSnippet, treeSpawnOptions, killProcessTree, shellQuote,',
  'agentBaseEnv, findOnPath) and shells.ts for shells and quoting; scripts.ts for a repository’s scripts. A new kind of',
  'launch goes in platform.ts with its tests. The baseline is never raised to let one in.'
].join('\n')

describe('child-process guard: counting', () => {
  it('counts calls of value imports, aliases and namespaces, and not type imports, comments’ words or other modules', () => {
    expect(directUses(`import { execFile, spawn } from 'node:child_process'\nexecFile('git', [])\nconst p = spawn('x', [])\nspawn('y')`)).toBe(3)
    expect(directUses(`import { spawn as spawnChild, type ChildProcess } from 'node:child_process'\nlet c: ChildProcess\nspawnChild('x')`)).toBe(1)
    expect(directUses(`import { execFile } from 'child_process'\nconst run = promisify(execFile)\nrun('a')`)).toBe(1)
    expect(directUses(`import * as cp from 'node:child_process'\ncp.spawn('a')\ncp.execSync('b')`)).toBe(2)
    expect(directUses(`import { fork } from 'node:child_process'\nconst f = fork`)).toBe(1)
    expect(directUses(`const { spawn } = await import('node:child_process')`)).toBe(1)
    expect(directUses(`import type { ChildProcess } from 'node:child_process'\nimport type { fork, spawn } from 'node:child_process'\nspawn('x')`)).toBe(0)
    expect(directUses(`import { spawn } from 'node-pty'\nspawn('x')`)).toBe(0)
    // A process started inside a remote sandbox, as text, isn't one Foreman starts here.
    expect(directUses(`const script = 'require("child_process").spawn("/bin/sh")'`)).toBe(0)
  })

  it('holds a count to its baseline, and a file with no entry to none', () => {
    expect(overBaseline({ 'a.ts': 2 }, { 'a.ts': 2 })).toEqual([])
    expect(overBaseline({ 'a.ts': 1 }, { 'a.ts': 2 })).toEqual([])
    expect(overBaseline({ 'a.ts': 3 }, { 'a.ts': 2 })).toEqual(['a.ts: 2 → 3'])
    expect(overBaseline({ 'b.ts': 1 }, {})).toEqual(['b.ts: 0 → 1'])
  })

  it('names a reason for every helper module, and each still exists', () => {
    for (const [file, why] of Object.entries(HELPERS)) {
      expect(existsSync(file), file).toBe(true)
      expect(why.length, file).toBeGreaterThan(20)
    }
  })
})

describe('child-process guard: src/main', () => {
  it('no file uses node:child_process directly more than its baseline', () => {
    const now = scanMain()
    const baseline: Counts = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}
    const over = overBaseline(now, baseline)
    const total = (c: Counts) => Object.values(c).reduce((a, b) => a + b, 0)
    console.log(`Child-process guard: ${total(now)} direct uses now, ${total(baseline)} in the baseline, outside ${Object.keys(HELPERS).length} helper modules.`)
    if (process.env.UPDATE_CP_BASELINE === '1') {
      // Written down only when nothing went up; a rise is fixed in the code, never here.
      if (existsSync(BASELINE)) expect(over, 'counts went up; the baseline is not rewritten upward').toEqual([])
      writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`)
      return
    }
    expect(over, FAILURE).toEqual([])
  })
})
