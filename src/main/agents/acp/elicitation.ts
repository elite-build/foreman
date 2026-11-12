// ACP elicitation (`elicitation/create`, unstable v1 schema) as the question card (docs/agents.md 3): the agent asks for
// structured input with a form schema; Foreman shows each property as one question (a choice list for an enum, a boolean or a
// multi-select, the card's own text box for anything typed) and maps the answers back to the values the schema asks for.
// Pure: the adapter (index.ts) owns the connection, this owns the shape.
import type * as acp from '@agentclientprotocol/sdk/unstable'
import type { ApprovalResponse, Question } from '../../../shared/types'

/** What one property needs to be turned back from the card's answer. */
interface Field {
  key: string
  kind: 'choice' | 'multi' | 'boolean' | 'text' | 'number' | 'integer'
  required: boolean
  // Option label → the value the agent defined for it (an enum's `const`, or the string itself).
  values: Map<string, string>
}

export interface Elicitation {
  questions: Question[]
  fields: Map<string, Field>
}

/** The words Foreman puts on a boolean property's two choices. */
export const BOOLEAN_LABELS = { yes: 'Yes', no: 'No' } as const

type Property = acp.ElicitationPropertySchema
type Options = { label: string; description?: string; value: string }[]

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function enumOptions(p: { enum?: string[] | null; oneOf?: acp.EnumOption[] | null }): Options | undefined {
  if (p.oneOf?.length) return p.oneOf.map((o) => ({ label: o.title || o.const, description: text(o.description), value: o.const }))
  if (p.enum?.length) return p.enum.map((v) => ({ label: v, value: v }))
  return undefined
}

function multiOptions(p: acp.MultiSelectPropertySchema): Options | undefined {
  const items = p.items as { enum?: string[]; anyOf?: acp.EnumOption[] }
  if (items.anyOf?.length) return items.anyOf.map((o) => ({ label: o.title || o.const, description: text(o.description), value: o.const }))
  if (items.enum?.length) return items.enum.map((v) => ({ label: v, value: v }))
  return undefined
}

/**
 * The questions for a form elicitation, or undefined when Foreman can't show it: a URL or unknown mode (not advertised, so an agent
 * shouldn't send them), a property type it doesn't know, or a form with nothing to ask. The caller declines those.
 */
export function elicitationQuestions(params: acp.CreateElicitationRequest): Elicitation | undefined {
  if (params.mode !== 'form') return undefined
  const form = params as acp.ElicitationFormMode & { message: string }
  const entries = Object.entries(form.requestedSchema?.properties ?? {})
  if (!entries.length) return undefined
  const required = new Set(form.requestedSchema.required ?? [])
  const questions: Question[] = []
  const fields = new Map<string, Field>()
  for (const [index, [key, property]] of entries.entries()) {
    const p = property as Property
    const header = text((p as { title?: string | null }).title) ?? key
    const described = text((p as { description?: string | null }).description)
    let options: Options = []
    let kind: Field['kind']
    let multiSelect = false
    switch (p.type) {
      case 'string': {
        const found = enumOptions(p as acp.StringPropertySchema)
        kind = found ? 'choice' : 'text'
        options = found ?? []
        break
      }
      case 'number':
      case 'integer':
        kind = p.type
        break
      case 'boolean':
        kind = 'boolean'
        options = [
          { label: BOOLEAN_LABELS.yes, value: 'true' },
          { label: BOOLEAN_LABELS.no, value: 'false' }
        ]
        break
      case 'array': {
        const found = multiOptions(p as acp.MultiSelectPropertySchema)
        if (!found) return undefined
        kind = 'multi'
        multiSelect = true
        options = found
        break
      }
      default:
        return undefined
    }
    // The card keys answers by the question's text, so it must be there and different for every property.
    let question = [index === 0 ? text(form.message) : undefined, described ?? (index === 0 && text(form.message) ? undefined : header)].filter(Boolean).join('\n') || key
    while (fields.has(question)) question += ` (${key})`
    questions.push({ question, header, ...(multiSelect ? { multiSelect: true } : {}), options: options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })) })
    fields.set(question, { key, kind, required: required.has(key), values: new Map(options.map((o) => [o.label, o.value])) })
  }
  return { questions, fields }
}

/**
 * The agent's answer to what the person chose. Skipped is a decline (they saw it and said no); a required property left empty, or
 * a number that isn't one, is a decline too, since the schema can't be satisfied. Properties the person left out are omitted.
 */
export function elicitationResponse(elicitation: Elicitation, answer: Extract<ApprovalResponse, { kind: 'question' }>): acp.CreateElicitationResponse {
  if (answer.skipped || !answer.answers) return { action: 'decline' }
  const content: Record<string, acp.ElicitationContentValue> = {}
  for (const [question, field] of elicitation.fields) {
    const given = answer.answers[question]?.trim()
    const present = given && given !== '(no answer)' ? given : undefined
    const value = present === undefined ? undefined : valueOf(field, present)
    if (value === undefined) {
      if (field.required) return { action: 'decline' }
      continue
    }
    content[field.key] = value
  }
  return { action: 'accept', content }
}

function valueOf(field: Field, given: string): acp.ElicitationContentValue | undefined {
  switch (field.kind) {
    case 'boolean':
      return field.values.get(given) === 'true' ? true : field.values.get(given) === 'false' ? false : /^(true|yes)$/i.test(given) ? true : /^(false|no)$/i.test(given) ? false : undefined
    case 'number': {
      const n = Number(given)
      return Number.isFinite(n) ? n : undefined
    }
    case 'integer': {
      const n = Number(given)
      return Number.isInteger(n) ? n : undefined
    }
    case 'multi': {
      // The card joins the chosen labels with ", ": the labels this property knows, in its own order.
      const chosen = given.split(', ')
      const picked = [...field.values].filter(([label]) => chosen.includes(label)).map(([, value]) => value)
      return picked.length ? picked : undefined
    }
    case 'choice':
      // A choice the person typed instead of picking goes as typed; the agent checks it against its enum.
      return field.values.get(given) ?? given
    default:
      return given
  }
}
