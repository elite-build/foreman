// A template's start model: the agent and model a template asks for when it
// starts a new chat. It never touches an existing chat, and never permissions.
import { isSameModel, modelInfo } from './agents'
import { createT, type TFunction } from './i18n'
import type { Loadout, PromptTemplate, TemplateStartModel } from './types'

const enT = createT('en')

export function startModelLoadout(start: TemplateStartModel): Loadout {
  return { agent: start.agent, model: start.model, effort: start.effort, fast: false }
}

/**
 * The model a new chat starts with. An explicit choice always wins, then the
 * template's start model; with neither, `undefined` leaves the default loadout.
 */
export function chooseStartLoadout(explicit: Loadout | undefined, template: Pick<PromptTemplate, 'startModel'> | undefined): { loadout: Loadout | undefined; source: 'explicit' | 'template' | 'default' } {
  if (explicit) return { loadout: explicit, source: 'explicit' }
  if (template?.startModel) return { loadout: startModelLoadout(template.startModel), source: 'template' }
  return { loadout: undefined, source: 'default' }
}

/** "Start in a new chat with Opus 5.5", offered when a template with a start model goes into a chat on another model. */
export function newChatHint(template: Pick<PromptTemplate, 'startModel'> | undefined, current: { agent: string; model: string }, t: TFunction = enT): string | null {
  const start = template?.startModel
  if (!start) return null
  if (start.agent === current.agent && isSameModel(start.agent, start.model, current.model)) return null
  return t('startModel.newChatHint', { model: modelInfo(start.agent, start.model).label })
}
