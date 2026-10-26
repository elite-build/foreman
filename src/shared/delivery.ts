// How a message typed in a chat reaches the agent, and what the composer tells
// the user afterwards. The receipt comes from what actually happened.
import { createT, type TFunction } from './i18n'
import type { SendDisposition } from './types'

const enT = createT('en')

export type FollowUpMode = 'queue' | 'steer'

export type DeliveryPlan = 'start' | 'steer' | 'queue'

/** What to try for a message. Steering may still fall back to the queue. */
export function planDelivery(input: { starting: boolean; running: boolean; mode: FollowUpMode; canSteer: boolean }): DeliveryPlan {
  // A turn that is still starting counts as running, but can't be steered yet.
  if (input.starting) return 'queue'
  if (!input.running) return 'start'
  return input.mode === 'steer' && input.canSteer ? 'steer' : 'queue'
}

/** The mode a message goes with while a turn runs: an override, else the setting. */
export function effectiveMode(setting: FollowUpMode, override: FollowUpMode | null, canSteer: boolean): FollowUpMode {
  if (!canSteer) return 'queue'
  return override ?? setting
}

export function oppositeMode(mode: FollowUpMode): FollowUpMode {
  return mode === 'steer' ? 'queue' : 'steer'
}

/** The line shown after a send, or null when the message simply started a turn. */
export function receiptText(disposition: SendDisposition, t: TFunction = enT): string | null {
  if (disposition === 'steered') return t('composer.receipt.steered')
  if (disposition === 'queued') return t('composer.receipt.queued')
  return null
}
