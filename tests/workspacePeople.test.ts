import { describe, expect, it } from 'vitest'
import { pickWorkspaceName } from '../src/main/names'
import { findWorkspacePerson, WORKSPACE_PEOPLE, workspacePerson } from '../src/shared/workspacePeople'

describe('workspace names and introductions', () => {
  it('bundles over 2,000 distinct, branch-safe names with sourced contribution summaries', () => {
    expect(WORKSPACE_PEOPLE.length).toBeGreaterThan(2000)
    expect(new Set(WORKSPACE_PEOPLE.map((person) => person.name)).size).toBe(WORKSPACE_PEOPLE.length)
    expect(new Set(WORKSPACE_PEOPLE.map((person) => person.source)).size).toBe(WORKSPACE_PEOPLE.length)
    for (const person of WORKSPACE_PEOPLE) {
      expect(person.name).toMatch(/^[a-z]+(?:-[a-z]+)*$/)
      expect(person.fullName.length).toBeGreaterThan(2)
      expect(person.contribution.length).toBeGreaterThan(25)
      expect(person.contribution.length).toBeLessThan(300)
      expect(person.contribution).toMatch(/\.$/)
      expect(person.contribution).not.toMatch(/\b[A-Z]\.$/)
      expect(person.contribution).not.toMatch(/named after|lifelong friendship/i)
      expect(person.source).toMatch(/^https:\/\/en\.wikipedia\.org\/wiki\//)
    }
  })

  it('includes the approved examples and their contributions', () => {
    expect(findWorkspacePerson('tesla')).toMatchObject({
      fullName: 'Nikola Tesla',
      contribution: 'He helped shape how electricity powers our world, pioneering AC motors and power systems.'
    })
    expect(findWorkspacePerson('newton')?.contribution).toContain('gravitation')
    expect(findWorkspacePerson('aristotle')?.contribution).toContain('logic')
    expect(findWorkspacePerson('plato')?.fullName).toBe('Plato')
    expect(findWorkspacePerson('confucius')?.fullName).toBe('Confucius')
  })

  it('exhausts the base pool without reusing a name, then resolves numbered introductions', () => {
    const taken = new Set<string>(['reykjavik'])
    for (let i = 0; i < WORKSPACE_PEOPLE.length; i++) {
      const name = pickWorkspaceName(taken, () => 0)
      expect(taken.has(name)).toBe(false)
      expect(findWorkspacePerson(name)?.name).toBe(name)
      taken.add(name)
    }
    const suffixed = pickWorkspaceName(taken, () => 0)
    expect(suffixed).toBe(`${WORKSPACE_PEOPLE[0].name}-2`)
    expect(findWorkspacePerson(suffixed)).toBe(WORKSPACE_PEOPLE[0])
    taken.add(suffixed)
    expect(pickWorkspaceName(taken, () => 0)).toBe(`${WORKSPACE_PEOPLE[0].name}-3`)
  })

  it('keeps the original introduction after a task renames the workspace and branch', () => {
    expect(workspacePerson({ namesake: 'tesla-2', name: 'fix-login', branch: 'user/fix-login' })?.name).toBe('tesla')
    expect(workspacePerson({ placeholderBranch: 'user/tesla-2', name: 'fix-login', branch: 'user/fix-login' })?.name).toBe('tesla')
  })

  it('supports old sessions and manually named branches without inventing facts for unknown names', () => {
    expect(workspacePerson({ name: 'Tesla', branch: 'user/Tesla-12' })?.name).toBe('tesla')
    expect(workspacePerson({ name: 'reykjavik', branch: 'user/reykjavik' })).toBeUndefined()
    expect(findWorkspacePerson(undefined)).toBeUndefined()
    expect(findWorkspacePerson('fix-login')).toBeUndefined()
  })
})
