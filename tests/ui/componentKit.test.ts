import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Every component in ui/ is a whole component: exported from ui/index.ts (so features import it from one place),
// tested in tests/ui/, and drawn in a ui/gallery/ page (so the gallery screenshots show it). Its doc section is rule 8 of
// tests/designSystem.test.ts. A .tsx file in ui/ that is none of these is a component that skipped the design system.

const UI = 'src/renderer/src/ui'
const files = readdirSync(UI).filter((f) => f.endsWith('.tsx')).map((f) => f.replace(/\.tsx$/, ''))
const index = readFileSync(`${UI}/index.ts`, 'utf8')
const gallery = readdirSync(`${UI}/gallery`).map((f) => readFileSync(`${UI}/gallery/${f}`, 'utf8')).join('\n')

describe('every ui/ component is complete', () => {
  it('finds the components', () => {
    expect(files.length).toBeGreaterThan(30)
  })

  it.each(files)('%s is exported from ui/index.ts, tested, and in a gallery', (name) => {
    expect(index, `ui/index.ts exports nothing from './${name}'`).toContain(`from './${name}'`)
    expect(existsSync(`tests/ui/${name}.test.tsx`), `tests/ui/${name}.test.tsx is missing`).toBe(true)
    expect(gallery, `no <${name} in ui/gallery/`).toMatch(new RegExp(`<${name}\\b`))
  })
})
