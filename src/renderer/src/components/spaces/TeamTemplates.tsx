// The starting templates in New organization (docs/ai-employees.md §16): a chip per job adds that employee to the team,
// a hover card on the chip says what the job does and hands back, and Compare jobs shows the same choice as a grid of
// cards. Both read and change one picked set, which the dialog owns.
import { Check, Plus } from 'lucide-react'
import { useId, type RefObject } from 'react'
import { EMPLOYEE_TEMPLATES, type EmployeeTemplate, type EmployeeTemplateId } from '../../../../shared/employeeTemplates'
import { useT } from '../../i18n'
import { CardButton, ChipButton, HardHat, HoverCard, Tag } from '../../ui'

type Picked = ReadonlySet<EmployeeTemplateId>
type Toggle = (id: EmployeeTemplateId, on: boolean) => void

/** The job's title, its line and what it hands back, in the person's language. */
export function useTemplateText() {
  const t = useT()
  return (template: EmployeeTemplate) => ({
    title: t(`spaces.template.${template.id}.title`),
    line: t(`spaces.template.${template.id}.line`),
    gives: t(`spaces.template.${template.id}.gives`)
  })
}

/**
 * What a job is, as its card says it: family, hat and title, its line, its access, who you get and what they hand back.
 * `titleId` and `detailId` let a card be named by the title and described by the rest.
 */
function JobFacts({ template, titleId, detailId }: { template: EmployeeTemplate; titleId?: string; detailId?: string }) {
  const t = useT()
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
      </span>
    </span>
  )
}

/** A chip per template; pressing one adds that employee, pressing it again takes them out. */
export function TemplateChips({ picked, onToggle, labelledBy }: { picked: Picked; onToggle: Toggle; labelledBy: string }) {
  const text = useTemplateText()
  return (
    <div className="space-chips" role="group" aria-labelledby={labelledBy}>
      {EMPLOYEE_TEMPLATES.map((template) => {
        const on = picked.has(template.id)
        const { title } = text(template)
        return (
          <HoverCard
            key={template.id}
            label={title}
            width={300}
            openDelay={400}
            trigger={(h) => (
              <ChipButton {...h} pressed={on} onClick={() => onToggle(template.id, !on)}>
                {on ? <Check size={12} aria-hidden /> : <Plus size={12} aria-hidden />}
                {title}
              </ChipButton>
            )}
          >
            <JobFacts template={template} />
          </HoverCard>
        )
      })}
    </div>
  )
}

/** Compare jobs: every template as a card to pick, the same choice as the chips. */
export function CompareJobs({ picked, onToggle, firstRef }: { picked: Picked; onToggle: Toggle; firstRef?: RefObject<HTMLButtonElement | null> }) {
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
            <JobFacts template={template} titleId={titleId} detailId={detailId} />
          </CardButton>
        )
      })}
    </div>
  )
}

/** A picked employee in the team list, as the label of the checkbox that takes them out. */
export function PickedWho({ template }: { template: EmployeeTemplate }) {
  const t = useT()
  const { title } = useTemplateText()(template)
  return (
    <span className="space-team-who">
      <HardHat colour={template.colour} size={18} />
      <span className="space-bring-name">
        {template.name} <span className="faint small">{title}</span>
      </span>
      <Tag>{t(template.access === 'write' ? 'employees.access.write' : 'employees.access.read')}</Tag>
    </span>
  )
}
