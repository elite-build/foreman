import { describe, expect, it } from 'vitest'
import { exportsOf, LABEL, newComponentProblems } from '../scripts/check-new-components.mjs'

// The pull-request check (scripts/check-new-components.mjs, run by .github/workflows/design-system.yml): a new
// design-system export comes labelled, tested, in a gallery, and in a pull request of its own.

const BASE = `export { Button, type ButtonProps } from './Button'\nexport { flash, flashTargets, type FlashOptions } from './flash'\n`
const WITH_STEPPER = `${BASE}export {\n  Stepper,\n  type StepperProps\n} from './Stepper'\n`

const complete = {
  baseIndex: BASE,
  headIndex: WITH_STEPPER,
  changed: ['src/renderer/src/ui/Stepper.tsx', 'src/renderer/src/ui/index.ts', 'tests/ui/Stepper.test.tsx', 'docs/design-system.md'],
  labels: [LABEL],
  has: (path: string) => path === 'tests/ui/Stepper.test.tsx',
  gallery: '<Stepper value={1} />'
}

describe('check-new-components', () => {
  it('reads value exports from ui/index.ts, leaving types out', () => {
    expect([...exportsOf(WITH_STEPPER)]).toEqual([
      ['Button', 'Button'],
      ['flash', 'flash'],
      ['flashTargets', 'flash'],
      ['Stepper', 'Stepper']
    ])
  })

  it('a change with no new export passes, whatever else it touches', () => {
    expect(newComponentProblems({ ...complete, headIndex: BASE, labels: [], changed: ['src/renderer/src/components/Home.tsx'] })).toEqual([])
  })

  it('a complete new component in its own labelled pull request passes', () => {
    expect(newComponentProblems(complete)).toEqual([])
  })

  it('a new export needs the label', () => {
    const problems = newComponentProblems({ ...complete, labels: ['enhancement'] })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/Stepper: a new design-system export needs the "new-component" label/)
  })

  it('the label is not checked when the labels are unknown (a local run)', () => {
    expect(newComponentProblems({ ...complete, labels: null })).toEqual([])
  })

  it('a new export needs its test and a gallery sample', () => {
    const problems = newComponentProblems({ ...complete, has: () => false, gallery: '' })
    expect(problems.join('\n')).toMatch(/Stepper: no tests\/ui\/Stepper\.test\.tsx/)
    expect(problems.join('\n')).toMatch(/Stepper: not in any ui\/gallery\/ page/)
  })

  it('a new function export needs a test but no gallery sample', () => {
    const headIndex = BASE.replace('flash, flashTargets', 'flash, flashTargets, flashAll')
    const problems = newComponentProblems({ ...complete, headIndex, has: () => false, gallery: '' })
    expect(problems).toEqual(['flash: no tests/ui/flash.test.tsx. A ui/ component ships with its keyboard and ARIA tests.'])
  })

  it('the change that brings ui/ in (no ui/index.ts at the base) passes', () => {
    expect(newComponentProblems({ ...complete, baseIndex: '', labels: [], changed: [...complete.changed, 'src/renderer/src/components/Home.tsx'] })).toEqual([])
  })

  it('a new export may not arrive together with feature code that uses it', () => {
    const changed = [...complete.changed, 'src/renderer/src/components/Home.tsx', 'src/renderer/src/styles/home.css']
    const problems = newComponentProblems({ ...complete, changed })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/feature code changes too \(src\/renderer\/src\/components\/Home\.tsx, src\/renderer\/src\/styles\/home\.css\)/)
  })
})
