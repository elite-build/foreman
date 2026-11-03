// Controlling Foreman on another computer: the window on one computer shows and drives the Foreman of a paired
// computer, and everything (agents, git, terminals, files) keeps running where it is. This file is the contract the two
// sides share: what they say to each other over the paired channel (main/remote/), which window calls stay on this
// computer, and which events cross. Pure, so main, the renderer and the tests read the same rules.
import type { Api, MainEvent, Signals } from './types'

/** Bumped when the frames change. Both computers must also run the same Foreman version (every Api call can change). */
export const REMOTE_PROTOCOL = 1

/** How many workspaces are working and how many need you, on one computer. */
export interface ComputerSummary {
  running: number
  needsYou: number
}

/** A background link only hears summaries and notifications; a control link carries the whole window. */
export type RemoteMode = 'background' | 'control'

/**
 * A paired computer as the computer chip shows it.
 * online: linked. connecting: trying now. offline: can't be reached. mismatch: a different Foreman version.
 * refused: it doesn't let other computers control it. unknown: no address to dial.
 */
export type ComputerStatus = 'online' | 'connecting' | 'offline' | 'mismatch' | 'refused' | 'unknown'

export interface ComputerRow {
  id: string
  name: string
  platform?: string
  status: ComputerStatus
  summary?: ComputerSummary
  // mismatch: the other computer's version.
  version?: string
}

/** The computer this window shows, when it isn't this one. */
export interface ComputerViewing {
  id: string
  name: string
  // connected: live. waiting: the other computer is asking whether to let you in. lost: the link dropped and is retrying.
  state: 'connected' | 'waiting' | 'lost'
}

/** Someone on another computer is controlling this one (shown to the person sitting here). */
export interface ComputerController {
  id: string
  name: string
  platform?: string
  since: string
}

/** A paired computer asked to take control and is waiting for Allow or Deny here. */
export interface ControlRequest {
  id: string
  deviceId: string
  name: string
  platform?: string
}

export interface ComputersView {
  self: { id: string; name: string; platform: string; summary: ComputerSummary }
  computers: ComputerRow[]
  viewing: ComputerViewing | null
  // Switching to this computer: waiting for the link, or for the person there to let this one in.
  joining: { id: string; name: string; waiting: boolean } | null
  controllers: ComputerController[]
  requests: ControlRequest[]
}

// ---- the frames ----

/** Sent once, sealed, right after the paired handshake. */
export interface RemoteHello {
  protocol: number
  version: string
  platform: string
  name: string
}

export interface RemoteWelcome {
  ok: boolean
  version: string
  platform: string
  name: string
  // Why not: 'version' (different Foreman versions), 'protocol', or 'off' (control isn't allowed here).
  refused?: 'version' | 'protocol' | 'off'
}

export type ClientFrame =
  | { t: 'call'; id: number; method: string; args: unknown[] }
  | { t: 'signal'; method: string; args: unknown[] }
  | { t: 'mode'; mode: RemoteMode }
  | { t: 'ping' }

export type ServerFrame =
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: string }
  | { t: 'event'; event: MainEvent }
  | { t: 'summary'; summary: ComputerSummary }
  | { t: 'notify'; event: Extract<MainEvent, { type: 'notify' }> }
  // The answer to a mode change. waiting: the person there is being asked. error: why control was refused.
  | { t: 'mode'; mode: RemoteMode; waiting?: boolean; error?: 'denied' | 'off' | 'timeout' }
  | { t: 'pong' }

// ---- which calls run where ----

type Method = keyof Api

/**
 * Window calls that stay on this computer while it shows another: the app itself (quitting, updates, diagnostics),
 * dictation (the microphone is here), opening a link (the browser is here) and the computer chip's own calls.
 */
export const LOCAL_METHODS: ReadonlySet<Method> = new Set<Method>([
  'quitPlan', 'quitNow', 'quitWhenFinished', 'quitKeepRunning', 'cancelQuit',
  'checkForUpdates', 'dismissUpdate', 'downloadUpdate', 'stopUpdateDownload', 'installUpdateOnQuit', 'restartToUpdate', 'cancelUpdateRestart', 'releaseNotes', 'dismissUpdated',
  'saveDiagnostics', 'reportDiagnostics', 'fullDiskAccess', 'openFullDiskAccessSettings', 'cliStatus', 'installCli',
  'sttStart', 'sttAudio', 'sttStop', 'sttCancel', 'sttModelStatus', 'sttDownloadModel',
  'openExternal', 'takeLaunchFolders',
  'computers', 'viewComputer', 'answerControlRequest', 'disconnectController'
])

/**
 * Calls that need this computer's screen or files and mean nothing for another computer's work: file pickers, Open in…,
 * previews (served from the worktree, which is over there) and import/export files. Refused while another computer is
 * shown, with a reason. (Whether a run script's preview URL answers, probePreview, is asked over there: that is where
 * the server runs.)
 */
export const UNAVAILABLE_REMOTELY: ReadonlySet<Method> = new Set<Method>([
  'pickDirectory', 'pickFiles', 'pickPath', 'classifyFolders',
  'openPath', 'openInEditor', 'openInApps', 'openInIcons', 'openIn', 'openRepoSettingsFile',
  'previewUrl', 'openPreview',
  'exportWorkspace', 'stageImport', 'importStaged', 'discardImport'
])

/**
 * Calls that read a saved secret back (an environment variable, an agent or provider key). A computer controlling this
 * one can set them, as it can everything else, but never reads their values: keys stay on the computer they belong to.
 */
export const SECRET_METHODS: ReadonlySet<Method> = new Set<Method>(['revealEnvVar', 'revealAgentKey', 'revealProviderKey'])

/** What a computer refuses from one that controls it: its own screen, local file paths and its secrets' values. */
export function hostAccepts(method: string): boolean {
  const m = method as Method
  return !LOCAL_METHODS.has(m) && !UNAVAILABLE_REMOTELY.has(m) && !SECRET_METHODS.has(m) && m !== 'attachFiles'
}

/** Signals that are about this computer's window (the unread badge, the battery), never forwarded. */
export const LOCAL_SIGNALS: ReadonlySet<keyof Signals> = new Set<keyof Signals>(['setUnread', 'setBattery'])

// ---- which events cross ----

// Events about a computer's own window and app: its menu, tray, built-in browser, dictation and the computer chip.
const WINDOW_EVENTS: ReadonlySet<MainEvent['type']> = new Set<MainEvent['type']>([
  'browser-open', 'browser-state', 'browser-shortcut',
  'show-workspace', 'show-setting', 'report-problem', 'tour', 'launch-folders', 'quit-requested', 'open-link', 'navigate',
  'stt-partial', 'stt-error', 'stt-model', 'window-visibility',
  'computers', 'computer-notify', 'computer-left'
])

/** The events a computer sends to the one controlling it. */
export function hostForwards(event: MainEvent): boolean {
  return !WINDOW_EVENTS.has(event.type)
}

/** This computer's own events that still reach the window while it shows another computer. */
export function localWhileViewing(event: MainEvent): boolean {
  return WINDOW_EVENTS.has(event.type) && event.type !== 'browser-open' && event.type !== 'browser-state' && event.type !== 'browser-shortcut'
}

export function sameSummary(a: ComputerSummary | undefined, b: ComputerSummary | undefined): boolean {
  return a?.running === b?.running && a?.needsYou === b?.needsYou
}

/** Needs-you across the other computers, for the chip's badge (this one's own count is on the rail already). */
export function othersNeedYou(view: ComputersView | null): number {
  if (!view) return 0
  const others = view.computers.filter((c) => c.id !== view.viewing?.id).reduce((n, c) => n + (c.status === 'online' ? (c.summary?.needsYou ?? 0) : 0), 0)
  return others + (view.viewing ? view.self.summary.needsYou : 0)
}
