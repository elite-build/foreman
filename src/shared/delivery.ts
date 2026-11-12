// How a message typed in a chat reaches the agent, and what the composer tells
// the user afterwards. The receipt comes from what actually happened.
import { createT, type TFunction } from './i18n'
import type { SendDisposition } from './types'

const enT = createT('en')

/** The follow-up the setting stores: into the running turn, or after it. */
export type FollowUpMode = 'queue' | 'steer'

/**
 * What one message can ask for while a turn runs. `interrupt` is never stored as a setting and never the default: it is the
 * explicit choice of an agent that can't take a message mid-turn (`turns.steer` is the `interrupt-restart` fallback), and it
 * cuts work in progress (docs/agents.md, 2.5).
 */
export type SendMode = FollowUpMode | 'interrupt'

export type DeliveryPlan = 'start' | 'steer' | 'queue' | 'interrupt'

/** What to try for a message. Steering may still fall back to the queue. */
export function planDelivery(input: { starting: boolean; running: boolean; mode: SendMode; canSteer: boolean; canInterrupt?: boolean }): DeliveryPlan {
  // A turn that is still starting counts as running, but can't be steered yet.
  if (input.starting) return 'queue'
  if (!input.running) return 'start'
  if (input.mode === 'interrupt') return input.canInterrupt ? 'interrupt' : 'queue'
  return input.mode === 'steer' && input.canSteer ? 'steer' : 'queue'
}

/**
 * The mode a message goes with while a turn runs: an override, else the setting. An agent that can only interrupt always
 * queues unless the person picked "Interrupt and send" for this message.
 */
export function effectiveMode(setting: FollowUpMode, override: SendMode | null, canSteer: boolean, canInterrupt = false): SendMode {
  if (canSteer) return override === 'interrupt' ? setting : override ?? setting
  return canInterrupt && override === 'interrupt' ? 'interrupt' : 'queue'
}

/** The other choice: the one the shortcut and the chip's toggle offer. */
export function oppositeMode(mode: SendMode, canInterrupt = false): SendMode {
  if (mode === 'interrupt') return 'queue'
  if (mode === 'steer') return 'queue'
  return canInterrupt ? 'interrupt' : 'steer'
}

/** The line shown after a send, or null when the message simply started a turn. */
export function receiptText(disposition: SendDisposition, t: TFunction = enT): string | null {
  if (disposition === 'steered') return t('composer.receipt.steered')
  if (disposition === 'queued') return t('composer.receipt.queued')
  return null
}
