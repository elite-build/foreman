// Where a cloud workspace's commands and files are: its sandbox.
// git, scripts and setup steps take a folder on this computer (a plain path) or a runtime, so the
// same code works in both places. Paths may be relative to `cwd`.

export interface RuntimeExecOptions {
  cwd?: string
  // Added to the place's own environment (this process's locally, the sandbox's in the cloud).
  env?: Record<string, string | undefined>
  timeoutMs?: number
  // Cloud only: run as root.
  sudo?: boolean
  // Stream output as it arrives (stdout and stderr together); the result still has both.
  onOutput?: (chunk: string) => void
  // Aborting kills the command; its result then has whatever exit code it ended with.
  signal?: AbortSignal
}

/** A finished command. A non-zero `code` is a result, not an error; a command that couldn't start is 127. */
export interface RuntimeExecResult {
  stdout: string
  stderr: string
  code: number
}

export interface WorkspaceRuntime {
  kind: 'cloud'
  cwd: string
  exec(cmd: string, args: string[], opts?: RuntimeExecOptions): Promise<RuntimeExecResult>
  // null when there is no such file.
  readFile(path: string): Promise<Buffer | null>
  writeFile(path: string, data: Buffer | string, mode?: number): Promise<void>
  exists(path: string): Promise<boolean>
  // With parents; an existing folder is fine.
  mkdir(path: string): Promise<void>
}
