import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Tests create and clone real repositories. Do not inherit a developer's hooks,
// credential helpers, signing settings or line-ending conversions into fixtures.
const config = path.join(mkdtempSync(path.join(os.tmpdir(), 'foreman-test-git-')), 'config')
writeFileSync(config, '[user]\n\tname = Test\n\temail = test@example.com\n[core]\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n')
process.env.GIT_CONFIG_GLOBAL = config
process.env.GIT_CONFIG_NOSYSTEM = '1'
