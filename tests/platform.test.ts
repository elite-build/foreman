import { mkdir, writeFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { importLoginShellEnv, isWindows } from '../src/main/platform'
import { tempDir } from './helpers'

describe.skipIf(isWindows)('login shell environment', () => {
  it('gives up on a shell that hangs, even when a child keeps its output open', async () => {
    const dir = await tempDir()
    await mkdir(dir, { recursive: true })
    const shell = path.join(dir, 'stuck-shell')
    // Starts a background sleeper that inherits stdout, then hangs itself.
    await writeFile(shell, '#!/bin/sh\nsleep 30 &\nsleep 30\n')
    await chmod(shell, 0o755)
    const saved = process.env.SHELL
    process.env.SHELL = shell
    const started = Date.now()
    try {
      await importLoginShellEnv(500)
    } finally {
      process.env.SHELL = saved
    }
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
