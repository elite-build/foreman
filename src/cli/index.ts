// `foreman`: drives the running Foreman app from a terminal. Each command is a row in
// src/shared/cliCommands.ts with its function in src/cli/commands/; this file only picks the entry
// path (the MCP bridge, --version, or a command) and turns whatever goes wrong into an exit code.
import { runBridge } from './bridge'
import { CliError, requestV2 } from './client'
import { wantsJson } from './output'
import { defaultDataDir, ERROR_EXIT, socketPath, type AppInfoResult } from './protocol'
import { execute } from './registry'
import { CLI_VERSION } from './version'

/** `foreman --version`: this command's version and, when the app answers, the app's. */
async function printVersion(argv: string[]): Promise<void> {
  const dataDir = defaultDataDir()
  const app = await requestV2<AppInfoResult>(socketPath(dataDir), 'app-info', undefined).catch(() => undefined)
  if (wantsJson(argv.includes('--json'))) console.log(JSON.stringify({ cli: CLI_VERSION, app: app?.version ?? null }, null, 2))
  else console.log(`foreman ${CLI_VERSION}${app ? `\nForeman app ${app.version}` : ''}`)
}

/** Say what went wrong, on stderr, and set the exit code. With --json the failure is also a JSON object, with its code. */
function fail(err: unknown, argv: string[]): void {
  const known = err instanceof CliError
  const message = known ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)
  if (known && wantsJson(argv.includes('--json'))) console.error(JSON.stringify({ error: err.message, code: err.code ?? 'failed', ...(err.hint ? { hint: err.hint } : {}) }))
  else {
    console.error(`foreman: ${message}`)
    if (known && err.hint) console.error(err.hint)
  }
  process.exitCode = (known && err.exitCode) || ERROR_EXIT.failed
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === '-V') return printVersion(argv)
  await execute(argv)
}

// `foreman mcp-bridge <service>`: the stdio MCP server agents start (src/cli/bridge.ts). Its stdout
// is the MCP channel, so nothing else may print there, and nothing else runs first.
const [first, service] = process.argv.slice(2)
if (first === 'mcp-bridge') {
  void runBridge(service ?? '').then(() => process.exit(0))
} else main(process.argv.slice(2)).catch((err: unknown) => fail(err, process.argv.slice(2)))
