// npm run gen:agent-protocols   (docs/agents.md, section 4.2)
//
// Pins the three protocols the agent adapters are written against and records them in src/main/agents/protocolPins.json:
//   - Codex: the pinned @openai/codex binary's `app-server generate-ts --experimental` is written to
//     src/main/agents/codex/protocol/ (every file under a generated header). The adapter imports these types.
//     `--experimental` because the adapter asks for the experimental API (appServer.ts initialize).
//   - ACP: @agentclientprotocol/sdk's version and the hashes of its v1 and v2 JSON schemas (its types come from them).
//   - Claude Agent SDK: its version and the hash of sdk.d.ts. package.json pins it exactly, because the replay seam is the
//     CLI's stdio control protocol, which changes between SDK releases.
//
// tests/agentProtocolPins.test.ts fails when an installed package differs from its pin (run this, then re-record the
// fixtures) or when the generated folder was edited by hand. `--check` runs the same comparison without writing.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PINS_FILE = 'src/main/agents/protocolPins.json'
export const CODEX_PROTOCOL_DIR = 'src/main/agents/codex/protocol'
export const ACP_SCHEMAS = ['schema/v1/schema.json', 'schema/v1/schema.unstable.json', 'schema/v2/schema.json', 'schema/v2/schema.unstable.json']
export const CLAUDE_SDK_TYPES = 'sdk.d.ts'

const sha = (text) => createHash('sha256').update(text).digest('hex')
/** Text is hashed with LF line endings, so a Windows checkout with core.autocrlf hashes the same as the pin. */
const normal = (buffer) => buffer.toString('utf8').replace(/\r\n/g, '\n')

/** Packages are read from node_modules directly: some (the ACP SDK) don't export their package.json to require.resolve. */
function packageJsonPath(name, root) {
  return path.join(root, 'node_modules', ...name.split('/'), 'package.json')
}

export function packageRoot(name, root = ROOT) {
  return path.dirname(packageJsonPath(name, root))
}

export function packageVersion(name, root = ROOT) {
  return JSON.parse(readFileSync(path.join(packageRoot(name, root), 'package.json'), 'utf8')).version
}

export function fileHash(file) {
  return sha(normal(readFileSync(file)))
}

/** One hash over every file under `dir`: relative path and LF-normalised contents, in path order. */
export function folderHash(dir) {
  const files = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push(full)
    }
  }
  walk(dir)
  const hash = createHash('sha256')
  const rels = files.map((file) => path.relative(dir, file).split(path.sep).join('/')).sort()
  for (const rel of rels) hash.update(rel).update('\0').update(normal(readFileSync(path.join(dir, ...rel.split('/'))))).update('\0')
  return { sha256: hash.digest('hex'), files: rels.length }
}

/** `@openai/codex-<platform>-<arch>`'s binary, found the way the adapter finds it (codex/index.ts): the package holds vendor/<triple>/bin/codex. */
export function codexBinary(root = ROOT) {
  const platformPackage = `@openai/codex-${process.platform}-${process.arch}`
  const vendor = path.join(packageRoot(platformPackage, root), 'vendor')
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const triple = readdirSync(vendor).find((dir) => existsSync(path.join(vendor, dir, 'bin', name)))
  if (!triple) throw new Error(`${platformPackage} holds no codex binary under vendor/`)
  return path.join(vendor, triple, 'bin', name)
}

/** The pins as the installed packages say they are now (the generated folder's hash is read from disk, not regenerated). */
export function currentPins(root = ROOT) {
  const acpRoot = packageRoot('@agentclientprotocol/sdk', root)
  const claudeRoot = packageRoot('@anthropic-ai/claude-agent-sdk', root)
  return {
    codex: {
      package: '@openai/codex',
      version: packageVersion('@openai/codex', root),
      command: 'app-server generate-ts --experimental',
      generated: { dir: CODEX_PROTOCOL_DIR, ...folderHash(path.join(root, CODEX_PROTOCOL_DIR)) }
    },
    acp: {
      package: '@agentclientprotocol/sdk',
      version: packageVersion('@agentclientprotocol/sdk', root),
      schemas: Object.fromEntries(ACP_SCHEMAS.map((rel) => [rel, fileHash(path.join(acpRoot, rel))]))
    },
    claudeAgentSdk: {
      package: '@anthropic-ai/claude-agent-sdk',
      version: packageVersion('@anthropic-ai/claude-agent-sdk', root),
      types: { file: CLAUDE_SDK_TYPES, sha256: fileHash(path.join(claudeRoot, CLAUDE_SDK_TYPES)) }
    }
  }
}

export function readPins(root = ROOT) {
  return JSON.parse(readFileSync(path.join(root, PINS_FILE), 'utf8'))
}

/** What differs between the pins file and the installed packages and generated folder; empty when they agree. */
export function pinProblems(root = ROOT, pinned = readPins(root)) {
  const now = currentPins(root)
  const out = []
  const regen = 'Run npm run gen:agent-protocols, then re-record the fixtures (docs/agents.md, 4.2).'
  const same = (label, a, b, fix) => {
    if (a !== b) out.push(`${label}: pinned ${a}, now ${b}. ${fix}`)
  }
  same('@openai/codex version', pinned.codex.version, now.codex.version, regen)
  same('Codex protocol folder', pinned.codex.generated.sha256, now.codex.generated.sha256, `${CODEX_PROTOCOL_DIR} was edited by hand or is out of date. ${regen}`)
  same('@agentclientprotocol/sdk version', pinned.acp.version, now.acp.version, regen)
  for (const rel of ACP_SCHEMAS) same(`ACP ${rel}`, pinned.acp.schemas[rel], now.acp.schemas[rel], regen)
  same('@anthropic-ai/claude-agent-sdk version', pinned.claudeAgentSdk.version, now.claudeAgentSdk.version, regen)
  same('claude-agent-sdk sdk.d.ts', pinned.claudeAgentSdk.types.sha256, now.claudeAgentSdk.types.sha256, regen)
  return out
}

const header = (version) =>
  `// Generated by scripts/gen-agent-protocols.mjs from @openai/codex ${version} (codex app-server generate-ts --experimental). Do not edit by hand: npm run gen:agent-protocols.\n`

function generateCodex(root) {
  const version = packageVersion('@openai/codex', root)
  const binary = codexBinary(root)
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'foreman-codex-protocol-'))
  try {
    const out = path.join(tmp, 'protocol')
    const run = spawnSync(binary, ['app-server', 'generate-ts', '--experimental', '--out', out], { encoding: 'utf8', windowsHide: true })
    if (run.status !== 0) throw new Error(`codex app-server generate-ts failed (${run.status}): ${run.stderr || run.error}`)
    const stamped = path.join(tmp, 'stamped')
    const copy = (from, to) => {
      mkdirSync(to, { recursive: true })
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        if (entry.isDirectory()) copy(path.join(from, entry.name), path.join(to, entry.name))
        else if (entry.name.endsWith('.ts')) writeFileSync(path.join(to, entry.name), header(version) + normal(readFileSync(path.join(from, entry.name))))
      }
    }
    copy(out, stamped)
    const target = path.join(root, CODEX_PROTOCOL_DIR)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(path.dirname(target), { recursive: true })
    cpSync(stamped, target, { recursive: true })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function main() {
  if (process.argv.includes('--check')) {
    const problems = pinProblems()
    if (problems.length) {
      console.error(problems.join('\n'))
      process.exitCode = 1
    } else console.log('Agent protocol pins match')
    return
  }
  generateCodex(ROOT)
  const pins = currentPins()
  writeFileSync(path.join(ROOT, PINS_FILE), JSON.stringify(pins, null, 2) + '\n')
  const size = statSync(path.join(ROOT, PINS_FILE)).size
  console.log(`Wrote ${PINS_FILE} (${size} bytes): Codex ${pins.codex.version} (${pins.codex.generated.files} files), ACP SDK ${pins.acp.version}, Claude Agent SDK ${pins.claudeAgentSdk.version}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
