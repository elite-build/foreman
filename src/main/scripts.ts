// Runs user scripts (workspace setup) in a non-interactive shell: here, or through a
// workspace runtime.
import { spawn, type ChildProcess } from 'node:child_process'
import { killProcessTree, scriptShell, treeSpawnOptions, windowsScriptLaunch } from './platform'
import type { WorkspaceRuntime } from './runtime/types'

export interface RunningScript {
  // Null when the script shell wasn't found and nothing started.
  child: ChildProcess | null
  done: Promise<number>
  kill(): Promise<void>
}

export function runScript(
  script: string,
  where: string | WorkspaceRuntime,
  env: Record<string, string>,
  onOutput: (chunk: string) => void
): RunningScript {
  if (typeof where !== 'string') return runRemote(script, where, env, onOutput)
  const cwd = where
  // On Windows the Script shell setting (O4) may pick PowerShell or Git Bash over cmd.exe.
  let launch: ReturnType<typeof windowsScriptLaunch>
  try {
    launch = windowsScriptLaunch(script, false)
  } catch (err) {
    onOutput(`
${(err as Error).message}
`)
    return { child: null, done: Promise.resolve(127), kill: async () => {} }
  }
  const child = launch
    ? spawn(launch.file, launch.args, { cwd, env: { ...env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'], ...treeSpawnOptions })
    : spawn(script, { cwd, env, shell: scriptShell(), stdio: ['ignore', 'pipe', 'pipe'], ...treeSpawnOptions })
  child.stdout?.setEncoding('utf8').on('data', onOutput)
  child.stderr?.setEncoding('utf8').on('data', onOutput)
  const done = new Promise<number>((resolve) => {
    child.once('error', (err) => {
      onOutput(`\n${err.message}\n`)
      resolve(127)
    })
    child.once('close', (code, signal) => resolve(code ?? (signal ? 130 : 1)))
  })
  return {
    child,
    done,
    kill: async () => {
      if (child.pid && child.exitCode === null) await killProcessTree(child.pid)
    }
  }
}

/** A script in a runtime that isn't this computer: a bash login shell there, stopped by aborting the command. */
function runRemote(script: string, rt: WorkspaceRuntime, env: Record<string, string>, onOutput: (chunk: string) => void): RunningScript {
  const stop = new AbortController()
  const done = rt.exec('bash', ['-lc', script], { cwd: rt.cwd, env, onOutput, signal: stop.signal }).then(
    (r) => (stop.signal.aborted && r.code === 0 ? 130 : r.code),
    (err: unknown) => {
      onOutput(`
${err instanceof Error ? err.message : String(err)}
`)
      return 127
    }
  )
  return { child: null, done, kill: async () => stop.abort() }
}
