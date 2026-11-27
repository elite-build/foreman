import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { actionRefs, jobName, jobs, readWorkflows, triggers, workflowProblems } from '../scripts/check-workflows.mjs'

// The rules every GitHub Actions workflow here keeps (scripts/check-workflows.mjs, also run with actionlint by
// `npm run check:workflows` in CI): pinned actions, explicit permissions, no secrets on pull requests, and the required
// check names docs/maintenance.md lists still naming CI's jobs.

const SHA = 'a'.repeat(40)
const MAINTENANCE = 'The required check names are `Types and design system` and `Tests and build`.'
const CI = `name: CI
on:
  pull_request:
    branches: [main]
permissions:
  contents: read
jobs:
  checks:
    name: Types and design system
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${SHA} # v7.0.1
  tests:
    name: Tests and build
    runs-on: windows-2022
    steps:
      - run: npm test
`

describe('workflow policy', () => {
  it('holds for the workflows in this repository', () => {
    expect(workflowProblems(readWorkflows(process.cwd()), readFileSync('docs/maintenance.md', 'utf8'))).toEqual([])
  })

  it('reads triggers, jobs, names and actions', () => {
    expect(triggers(CI)).toEqual(['pull_request'])
    expect(triggers('on: [push, pull_request]\n')).toEqual(['push', 'pull_request'])
    expect(jobs(CI).map((j) => [j.id, jobName(j)])).toEqual([['checks', 'Types and design system'], ['tests', 'Tests and build']])
    expect(actionRefs(CI)).toEqual([{ ref: `actions/checkout@${SHA}`, comment: 'v7.0.1' }])
  })

  it('passes a clean workflow', () => {
    expect(workflowProblems({ 'ci.yml': CI }, MAINTENANCE)).toEqual([])
  })

  it('fails an action on a tag or branch, or pinned without its version', () => {
    const tag = CI.replace(`@${SHA} # v7.0.1`, '@v7')
    expect(workflowProblems({ 'ci.yml': tag }, MAINTENANCE)).toEqual(['ci.yml: actions/checkout@v7 is not pinned to a full commit SHA'])
    const short = CI.replace(`@${SHA}`, '@3d3c42e')
    expect(workflowProblems({ 'ci.yml': short }, MAINTENANCE)[0]).toMatch(/not pinned to a full commit SHA/)
    const bare = CI.replace(' # v7.0.1', '')
    expect(workflowProblems({ 'ci.yml': bare }, MAINTENANCE)).toEqual([`ci.yml: actions/checkout@${SHA} has no version comment (# vX.Y.Z)`])
    const image = CI.replace(`actions/checkout@${SHA} # v7.0.1`, 'docker://alpine:3')
    expect(workflowProblems({ 'ci.yml': image }, MAINTENANCE)).toEqual(['ci.yml: docker://alpine:3 is not pinned to an image digest'])
  })

  it('fails a workflow without top-level permissions', () => {
    expect(workflowProblems({ 'ci.yml': CI.replace('permissions:\n  contents: read\n', '') }, MAINTENANCE)).toEqual(['ci.yml: no top-level permissions'])
  })

  it('fails a secret, passed secrets or an environment in a job a pull request starts, and pull_request_target', () => {
    const secret = CI.replace('      - run: npm test\n', '      - run: npm test\n        env:\n          KEY: ${{ secrets.CSC_LINK }}\n')
    expect(workflowProblems({ 'ci.yml': secret }, MAINTENANCE)).toEqual(['ci.yml: job tests runs on pull requests and references a secret'])
    // The workflow's own token is not a secret anyone added.
    const token = CI.replace('      - run: npm test\n', '      - run: npm test\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n')
    expect(workflowProblems({ 'ci.yml': token }, MAINTENANCE)).toEqual([])
    const env = CI.replace('    runs-on: windows-2022\n', '    runs-on: windows-2022\n    environment: release\n')
    expect(workflowProblems({ 'ci.yml': env }, MAINTENANCE)).toEqual(['ci.yml: job tests runs on pull requests and deploys to an environment'])
    const target = CI.replace('  pull_request:\n', '  pull_request_target:\n')
    expect(workflowProblems({ 'ci.yml': target }, MAINTENANCE)).toContain('ci.yml: uses pull_request_target, which runs with secrets and a write token on fork pull requests')
  })

  it('follows a reusable workflow a pull request calls, and fails secrets passed to it or reached without a condition', () => {
    const caller = `on:
  pull_request:
permissions:
  contents: read
jobs:
  build:
    uses: ./.github/workflows/build.yml
`
    const called = (condition: string) => `on:
  workflow_call:
permissions:
  contents: read
jobs:
  sign:
${condition}    runs-on: ubuntu-24.04
    environment: release
    steps:
      - run: echo "\${{ secrets.SIGNING_KEY }}"
`
    const files = (c: string, callerText = caller) => ({ 'ci.yml': CI, 'dry.yml': callerText, 'build.yml': c })
    expect(workflowProblems(files(called('    if: inputs.sign\n')), MAINTENANCE)).toEqual([])
    expect(workflowProblems(files(called('')), MAINTENANCE)).toEqual(['build.yml: job sign reaches secrets or an environment unconditionally, and dry.yml calls it on pull requests'])
    const passing = `${caller}    secrets: inherit\n`
    expect(workflowProblems(files(called('    if: inputs.sign\n'), passing), MAINTENANCE)).toEqual(['dry.yml: job build runs on pull requests and passes secrets to a reusable workflow'])
    expect(workflowProblems({ 'ci.yml': CI, 'dry.yml': caller }, MAINTENANCE)).toEqual(['dry.yml: calls ./.github/workflows/build.yml, which doesn\'t exist'])
  })

  it('fails when a required check name in docs/maintenance.md no longer names a pull-request job', () => {
    const renamed = CI.replace('name: Tests and build', 'name: Tests')
    expect(workflowProblems({ 'ci.yml': renamed }, MAINTENANCE)).toEqual(['The required check "Tests and build" (docs/maintenance.md) is no longer the name of a job that runs on pull requests'])
    const matrix = CI.replace('    runs-on: windows-2022\n', '    runs-on: windows-2022\n    strategy:\n      matrix:\n        os: [a, b]\n')
    expect(workflowProblems({ 'ci.yml': matrix }, MAINTENANCE)).toEqual(['The required check "Tests and build" is a matrix job, whose check names carry the matrix values'])
    expect(workflowProblems({ 'ci.yml': CI }, 'No list here.')).toEqual(['docs/maintenance.md no longer says "The required check names are `…` and `…`."'])
    // A job of that name in a workflow that pull requests don't start doesn't count.
    const manual = CI.replace('  pull_request:\n    branches: [main]\n', '  workflow_dispatch:\n')
    expect(workflowProblems({ 'ci.yml': manual }, MAINTENANCE)).toHaveLength(2)
  })
})
