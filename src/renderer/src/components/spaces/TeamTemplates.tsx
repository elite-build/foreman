// The job templates (docs/ai-employees.md §16), in New organization and in Add employee: a chip per job picks that
// employee, a hover card on the chip says what the job does and hands back, and Compare jobs shows the same choice as a
// grid of cards. Both read and change one picked set, which the page or dialog owns: New organization picks several,
// Add employee one (`single`: the owner replaces the choice, and the chips show no ＋). `holders` names who already does
// a job, said on its chip, its hover card and its card.
import { Check, Plus } from 'lucide-react'
import { useId, type RefObject } from 'react'
import { EMPLOYEE_TEMPLATES, type EmployeeTemplate, type EmployeeTemplateId } from '../../../../shared/employeeTemplates'
import { useT } from '../../i18n'
import { CardButton, ChipButton, HardHat, HoverCard, Tag, type HardHatColour } from '../../ui'
import './spaces.css'

type Picked = ReadonlySet<EmployeeTemplateId>
type Toggle = (id: EmployeeTemplateId, on: boolean) => void
/** Per job, the names of the employees who already do it. */
export type JobHolders = Partial<Record<EmployeeTemplateId, readonly string[]>>

/** The job's title, its line and what it hands back, in the person's language. */
export function useTemplateText() {
  const t = useT()
  return (template: EmployeeTemplate) => ({
    title: t(`spaces.template.${template.id}.title`),
    line: t(`spaces.template.${template.id}.line`),
    gives: t(`spaces.template.${template.id}.gives`)
  })
}

/** "Quinn", "Quinn and Ravi": names in a sentence, in the person's language. */
export function useNameList() {
  const t = useT()
  return (list: readonly string[]) => new Intl.ListFormat(t.locale, { type: 'conjunction' }).format(list)
}

/**
 * What a job is, as its card says it: family, hat and title, its line, its access, who you get and what they hand back,
 * and who already does it. `titleId` and `detailId` let a card be named by the title and described by the rest.
 */
function JobFacts({ template, holders, titleId, detailId }: { template: EmployeeTemplate; holders?: readonly string[]; titleId?: string; detailId?: string }) {
  const t = useT()
  const names = useNameList()
  const text = useTemplateText()(template)
  return (
    <span className="space-job">
      <span className="faint small">{t(`spaces.family.${template.family}`)}</span>
      <span className="space-job-title">
        <HardHat colour={template.colour} size={20} />
        <strong id={titleId}>{text.title}</strong>
      </span>
      <span id={detailId} className="space-job">
        <span className="faint small">{text.line}</span>
        <span className="space-job-foot">
          <Tag>{t(template.access === 'write' ? 'employees.access.write' : 'employees.access.read')}</Tag>
          <span className="faint small">{t('spaces.team.handsBack', { name: template.name, what: text.gives })}</span>
        </span>
        {holders?.length ? <strong className="small">{t('spaces.team.youHave', { names: names(holders) })}</strong> : null}
      </span>
    </span>
  )
}

/**
 * A chip per template; pressing one picks that employee, pressing it again takes them out. With `single`, each chip
 * is named by its title and described by its line, its access and who already does the job, for choosing one.
 */
export function TemplateChips({ picked, onToggle, labelledBy, single, holders }: { picked: Picked; onToggle: Toggle; labelledBy: string; single?: boolean; holders?: JobHolders }) {
  const t = useT()
  const names = useNameList()
  const text = useTemplateText()
  const base = useId()
  return (
    <div className="space-chips" role="group" aria-labelledby={labelledBy}>
      {EMPLOYEE_TEMPLATES.map((template) => {
        const on = picked.has(template.id)
        const { title, line } = text(template)
        const had = holders?.[template.id]
        const detailId = `${base}-${template.id}`
        const access = t(template.access === 'write' ? 'employees.access.write' : 'employees.access.read')
        return (
          <HoverCard
            key={template.id}
            label={title}
            width={300}
            openDelay={400}
            trigger={(h) => (
              <>
                <ChipButton {...h} pressed={on} aria-describedby={single ? detailId : undefined} onClick={() => onToggle(template.id, !on)}>
                  {on ? <Check size={12} aria-hidden /> : single ? null : <Plus size={12} aria-hidden />}
                  {title}
                  {had?.length ? (
                    <span className="faint" aria-hidden>
                      {' '}
                      {t('spaces.team.youHaveShort', { names: names(had) })}
                    </span>
                  ) : null}
                </ChipButton>
                {single && (
                  <span id={detailId} className="sr-only">
                    {[line, access, had?.length ? t('spaces.team.youHave', { names: names(had) }) : ''].filter(Boolean).join(' · ')}
                  </span>
                )}
              </>
            )}
          >
            <JobFacts template={template} holders={had} />
          </HoverCard>
        )
      })}
    </div>
  )
}

/** Compare jobs: every template as a card to pick, the same choice as the chips. */
export function CompareJobs({ picked, onToggle, firstRef, holders }: { picked: Picked; onToggle: Toggle; firstRef?: RefObject<HTMLButtonElement | null>; holders?: JobHolders }) {
  const base = useId()
  return (
    <div className="space-compare">
      {EMPLOYEE_TEMPLATES.map((template, i) => {
        const on = picked.has(template.id)
        const titleId = `${base}-${template.id}-title`
        const detailId = `${base}-${template.id}-detail`
        return (
          <CardButton
            key={template.id}
            ref={i === 0 ? firstRef : undefined}
            className="space-compare-card"
            selected={on}
            aria-pressed={on}
            aria-labelledby={titleId}
            aria-describedby={detailId}
            onClick={() => onToggle(template.id, !on)}
          >
            <JobFacts template={template} holders={holders?.[template.id]} titleId={titleId} detailId={detailId} />
          </CardButton>
        )
      })}
    </div>
  )
}

/**
 * A picked employee: hat, name, job and access, as the label of the checkbox that takes them out (New organization) or
 * at the head of who Add employee makes. `name`, `colour` and `access` are what will be saved when they differ from the
 * template's own (a name or hat already taken, Write held back for an agent that can't run unattended).
 */
export function PickedWho({ template, name, colour, access, size = 18 }: { template: EmployeeTemplate; name?: string; colour?: HardHatColour; access?: 'read' | 'write'; size?: number }) {
  const t = useT()
  const { title } = useTemplateText()(template)
  return (
    <span className="space-team-who">
      <HardHat colour={colour ?? template.colour} size={size} />
      <span className="space-bring-name">
        {name ?? template.name} <span className="faint small">{title}</span>
      </span>
      <Tag>{t((access ?? template.access) === 'write' ? 'employees.access.write' : 'employees.access.read')}</Tag>
    </span>
  )
}
