// Write a full prompt on Codex (docs/prompt-writer.md): one answer from `codex exec` on the model asked for, in an empty
// folder, read-only, with nothing kept, on the person's own sign-in and config. The system prompt goes in as developer
// instructions, the request on stdin, and a schema, when given, holds the final message to its shape.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { OneShotOptions } from '../types'

/** Past this the process is ended; the prompt writer stops waiting sooner (PROMPT_WRITER_TIMEOUT_MS). */
const ANSWER_ONCE_KILL_MS = 120_000

/** `codex exec`'s arguments for one answer; `dir` is the empty folder it runs in and writes its last message to. */
export function answerOnceArgs(options: Pick<OneShotOptions, 'model' | 'effort' | 'systemPrompt'>, dir: string, schemaFile?: string): string[] {
  return [
    'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--cd', dir,
    '--output-last-message', path.join(dir, 'answer.txt'),
    ...(options.model ? ['--model', options.model] : []),
    // A JSON string is a TOML basic string, which is what `-c` reads.
    ...(options.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`] : []),
    ...(options.systemPrompt ? ['-c', `developer_instructions=${JSON.stringify(options.systemPrompt)}`] : []),
    ...(schemaFile ? ['--output-schema', schemaFile] : []),
    '-'
  ]
}

export async function codexAnswerOnce(file: string, env: Record<string, string>, prompt: string, options: OneShotOptions): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foreman-answer-'))
  try {
    const schemaFile = options.schema ? path.join(dir, 'schema.json') : undefined
    if (schemaFile) await writeFile(schemaFile, JSON.stringify(options.schema))
    await new Promise<void>((resolve, reject) => {
      const child = spawn(file, answerOnceArgs(options, dir, schemaFile), { cwd: dir, env, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
      let stderr = ''
      const timer = setTimeout(() => child.kill(), ANSWER_ONCE_KILL_MS)
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000)
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `codex exec exited with ${code}`))
      })
      child.stdin.end(prompt)
    })
    return (await readFile(path.join(dir, 'answer.txt'), 'utf8')).trim()
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
