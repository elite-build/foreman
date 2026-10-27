import { vi } from 'vitest'

type Reply = { stdout?: string; stderr?: string; code?: number }
type Handler = (args: string[], env: NodeJS.ProcessEnv) => Reply
const fixture = vi.hoisted(() => ({ handler: undefined as Handler | undefined, calls: [] as { args: string[]; sync: boolean }[] }))

// Import this before services using gh. Mock only that external boundary: Git
// still runs for real, and no fixture can fall through to the user's gh login.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const reply = (args: string[], options: { env?: NodeJS.ProcessEnv }, sync: boolean) => {
    fixture.calls.push({ args, sync })
    if (!fixture.handler) throw new Error(`Unexpected gh invocation: ${args.join(' ')}`)
    const result = fixture.handler(args, options.env ?? process.env)
    const error = result.code ? Object.assign(new Error(result.stderr || `gh exited ${result.code}`), { code: result.code, stderr: result.stderr }) : null
    return { ...result, error }
  }
  return {
    ...actual,
    execFile: (file: string, ...rest: unknown[]) => {
      if (file !== 'gh') return Reflect.apply(actual.execFile, actual, [file, ...rest])
      const [args, options, callback] = rest as [string[], { env?: NodeJS.ProcessEnv }, (err: Error | null, stdout: string, stderr: string) => void]
      const result = reply(args, options, false)
      queueMicrotask(() => callback(result.error, result.stdout ?? '', result.stderr ?? ''))
      return new actual.ChildProcess()
    },
    execFileSync: (file: string, ...rest: unknown[]) => {
      if (file !== 'gh') return Reflect.apply(actual.execFileSync, actual, [file, ...rest])
      const [args, options] = rest as [string[], { env?: NodeJS.ProcessEnv }]
      const result = reply(args, options, true)
      if (result.error) throw result.error
      return result.stdout ?? ''
    }
  }
})

export function stubGh(handler: Handler): void {
  fixture.handler = handler
}

/** Every gh invocation since the last call, and whether it blocked (execFileSync). */
export function takeGhCalls(): { args: string[]; sync: boolean }[] {
  return fixture.calls.splice(0)
}
