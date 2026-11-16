// The person and the program manager on an organization's Team page (docs/ai-employees.md §15). The person is one of
// the team: a column of their own with their hat, what they do (approve plans, check results, answer what employees
// ask, approve what leaves the computer) and the projects that wait for them now. An organization made before program
// managers (or whose making of her failed) gets a line to add her.
import { useState } from 'react'
import { useNeedsYou } from '../../needsYou'
import { useT } from '../../i18n'
import { api, attempt, openEmployees, useStore } from '../../store'
import { Button, Callout, Card, HardHat, LinkButton, Status } from '../../ui'

/** The person's column: who they are on the team and what waits for them in this organization. */
export function PersonColumn({ orgId }: { orgId: string }) {
  const t = useT()
  const { counts } = useNeedsYou()
  const waiting = counts.bySpace.get(orgId) ?? 0
  const projects = useStore((s) => s.snapshot!.projects?.[orgId])
  const gates = (projects ?? []).filter((p) => p.phase !== 'closed' && p.waits.length > 0)
  return (
    <Card as="li" className="team-person">
      <div className="employee-card-head">
        <HardHat colour="slate" size={40} />
        <div className="employee-card-who">
          <span className="employee-subheading">{t('projects.you')}</span>
          <span className="employee-faint">{t('projects.person.role')}</span>
        </div>
      </div>
      <div className="employee-card-state">
        <Status tone={waiting ? 'warn' : 'off'} label={waiting ? t('employees.needsYou.count', { count: waiting }) : t('projects.person.nothing')} />
      </div>
      <p className="employee-faint">{t('projects.person.does')}</p>
      {gates.length > 0 && (
        <ul className="employee-card-duties" aria-label={t('projects.person.gates')}>
          {gates.map((p) => (
            <li key={p.id}>
              <LinkButton onClick={() => openEmployees({ orgId, page: 'project', id: p.id })}>{p.title}</LinkButton>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/** An organization without a program manager: add her (made and approved, as at New organization). */
export function AddProgramManager({ orgId }: { orgId: string }) {
  const t = useT()
  const missing = useStore((s) => !s.snapshot!.organizations?.find((o) => o.id === orgId)?.programManagerId)
  const [adding, setAdding] = useState(false)
  if (!missing) return null
  return (
    <Callout
      tone="info"
      title={t('projects.pmMissing.title')}
      actions={
        <Button
          size="sm"
          variant="primary"
          disabled={adding}
          onClick={() => {
            setAdding(true)
            void attempt(() => api.addProgramManager(orgId)).finally(() => setAdding(false))
          }}
        >
          {t('projects.pmMissing.add', { name: t('projects.pmDefault') })}
        </Button>
      }
    >
      {t('projects.pmMissing.body')}
    </Callout>
  )
}
