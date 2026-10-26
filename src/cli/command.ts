// What a command's `run` gets. The declarative half (name, options, help) is in src/shared/cliCommands.ts;
// each command's function is attached to it in registry.ts. The context carries the parsed words and the
// few things every command needs, so a command never reads argv, env or the socket itself.
import type { CliProgressFrame } from './protocol'

export interface SendOptions {
  // A dropped connection is exit code 5 and says the work isn't lost.
  waiting?: boolean
}

export interface Context {
  // The positional words after the command's own name.
  args: string[]
  // Parsed options, only those this command (plus the common ones) declares.
  opts: Record<string, unknown>
  json: boolean
  quiet: boolean
  yes: boolean
  cwd: string
  // One request to the app. Progress lines it sends go to stderr unless --quiet.
  send<T>(method: string, params?: unknown, options?: SendOptions): Promise<T>
  // The answer: JSON for --json, otherwise the text.
  print(value: unknown, text: string | (() => string)): void
  // Ask before something that can't be undone; see output.ts.
  confirm(question: string): Promise<boolean>
  // A line for the person, on stderr; nothing with --quiet.
  note(text: string): void
  // A progress frame from the app, printed as `note` would.
  progress(frame: CliProgressFrame['progress']): void
}

export type Run = (ctx: Context) => Promise<void>
