// `foreman phone status|link|pending|approve|deny|revoke`: phones and browsers signing in, from a terminal. Each one sends
// a request and prints the answer's `text` (or the JSON with --json); the app does the matching and the wording.
import type { MobileAccess } from '../../shared/mobile'
import { MOBILE_ACCESS } from '../../shared/mobile'
import { usageError } from '../client'
import type { Context, Run } from '../command'
import { declinedNote, noMoreWords, printText, str } from './automationKit'

const show =
  (method: string, usage: string): Run =>
  async (ctx) => {
    noMoreWords(ctx, 0, usage)
    printText(ctx, await ctx.send<{ text: string }>(method))
  }

const status: Run = async (ctx) => {
  if (ctx.args.length > 1 || (ctx.args[0] !== undefined && ctx.args[0] !== 'status')) throw usageError('foreman phone takes no words, or just “status”.', 'foreman phone [status]')
  printText(ctx, await ctx.send<{ text: string }>('phone-status'))
}

/** --lan or --private (not both), or neither: the app picks private when it has the address. */
function modeOf(ctx: Context): 'lan' | 'private' | undefined {
  if (ctx.opts.lan && ctx.opts.private) throw usageError('Choose --lan or --private, not both.')
  return ctx.opts.lan ? 'lan' : ctx.opts.private ? 'private' : undefined
}

const link: Run = async (ctx) => {
  noMoreWords(ctx, 0, 'foreman phone link [--lan | --private] [--browser] [--qr]')
  const mode = modeOf(ctx)
  printText(ctx, await ctx.send<{ text: string }>('phone-link', { mode, kind: ctx.opts.browser ? 'browser' : 'phone', qr: ctx.opts.qr ? true : undefined }))
}

const approve: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman phone approve <code> [--access read|operate|admin]')
  const [code] = ctx.args
  if (!code) throw usageError('Give the six-digit code the phone or browser shows. `foreman phone pending` says which device is asking.')
  const access = str(ctx.opts.access)
  if (access !== undefined && !(MOBILE_ACCESS as readonly string[]).includes(access)) throw usageError(`--access is one of ${MOBILE_ACCESS.join(', ')}.`)
  printText(ctx, await ctx.send<{ text: string }>('phone-approve', { code, access: access as MobileAccess | undefined }))
}

const revoke: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman phone revoke <device>')
  const [device] = ctx.args
  if (!device) throw usageError('Name a device: its id or name (`foreman phone` lists them).')
  if (!(await ctx.confirm(`Revoke “${device}”? It is signed out at once and needs a new link to sign in again.`))) return declinedNote(ctx, 'Nothing revoked.')
  printText(ctx, await ctx.send<{ text: string }>('phone-revoke', { device }))
}

export const phoneRunners: Record<string, Run> = {
  phone: status,
  'phone status': show('phone-status', 'foreman phone status'),
  'phone link': link,
  'phone pending': show('phone-pending', 'foreman phone pending'),
  'phone approve': approve,
  'phone deny': show('phone-deny', 'foreman phone deny'),
  'phone revoke': revoke
}
