import { Check } from 'lucide-react'
import type { HTMLAttributes, ReactNode, Ref } from 'react'

export type StepperStatus = 'done' | 'current' | 'upcoming'

export type StepperTone = 'ok' | 'warn' | 'error' | 'info'

export type StepperStep = {
  id: string
  label: ReactNode
  status: StepperStatus
  // The mark's colour. Default: ok (green) when done, neutral when current. An upcoming step is always hollow.
  tone?: StepperTone
  // Replaces the default mark (a tick when done, a dot when current), sized 12px by the caller.
  icon?: ReactNode
}

export type StepperProps = Omit<HTMLAttributes<HTMLOListElement>, 'children' | 'aria-label'> & {
  // The list's accessible name ("Pull request progress"). Required.
  label: string
  steps: StepperStep[]
  // Read after a done or upcoming step's label, so its state isn't the mark alone. The current step is aria-current="step".
  statusText: { done: string; upcoming: string }
  ref?: Ref<HTMLOListElement>
}

// Read-only progress through a few fixed stages (a pull request: committed, opened, checks, merged): a row of marks
// joined by a line, each with its label beneath. Not a wizard: the steps aren't controls.
export function Stepper({ label, steps, statusText, className, ref, ...rest }: StepperProps) {
  const cls = ['ui-stepper', className].filter(Boolean).join(' ')
  return (
    <ol {...rest} ref={ref} className={cls} aria-label={label}>
      {steps.map((step) => {
        const tone = step.status === 'upcoming' ? undefined : (step.tone ?? (step.status === 'done' ? 'ok' : undefined))
        return (
          <li key={step.id} className="ui-stepper__step" data-status={step.status} data-tone={tone} aria-current={step.status === 'current' ? 'step' : undefined}>
            <span className="ui-stepper__mark" aria-hidden="true">
              {step.icon ?? (step.status === 'done' ? <Check size={11} strokeWidth={3} /> : step.status === 'current' ? <span className="ui-stepper__dot" /> : null)}
            </span>
            <span className="ui-stepper__label">
              {step.label}
              {step.status !== 'current' && <span className="ui-stepper__state">, {statusText[step.status]}</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
