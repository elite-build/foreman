import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'
import { RUN_TEMP_PREFIX } from './globalSetup'

// Tests make thousands of repositories and folders in the temp folder and don't delete them. Each test file's go in
// one folder of its own instead, removed when the file ends; a killed run's are cleared by tests/globalSetup.ts. The
// short name keeps Unix socket paths under a temp-based data folder within their 104 bytes on macOS.
const TEMP_VARS = ['TMPDIR', 'TEMP', 'TMP'] as const
const before = TEMP_VARS.map((key) => [key, process.env[key]] as const)
const fileTemp = mkdtempSync(path.join(os.tmpdir(), RUN_TEMP_PREFIX))
for (const key of TEMP_VARS) process.env[key] = fileTemp
afterAll(() => {
  for (const [key, value] of before) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    rmSync(fileTemp, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // A process the file started still holds something: the next run's global setup deletes it.
  }
})

// Tests create and clone real repositories. Do not inherit a developer's hooks,
// credential helpers, signing settings or line-ending conversions into fixtures.
const config = path.join(mkdtempSync(path.join(os.tmpdir(), 'foreman-test-git-')), 'config')
writeFileSync(config, '[user]\n\tname = Test\n\temail = test@example.com\n[core]\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n')
process.env.GIT_CONFIG_GLOBAL = config
process.env.GIT_CONFIG_NOSYSTEM = '1'
