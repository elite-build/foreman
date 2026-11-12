// The Codex app-server's wire types, taken from the generated protocol (./protocol, pinned by protocolPins.json) and the few
// places where the adapter narrows them. Nothing here is written by hand that the schema already says: a field or method the
// pinned CLI doesn't have fails the typecheck instead of failing a turn.
//
// Type-only: the generated folder holds no runtime code.
import type { InitializeResponse } from './protocol/InitializeResponse'
import type { ServerNotification } from './protocol/ServerNotification'
import type { ServerRequest } from './protocol/ServerRequest'
import type { AccountLoginCompletedNotification } from './protocol/v2/AccountLoginCompletedNotification'
import type { CancelLoginAccountParams } from './protocol/v2/CancelLoginAccountParams'
import type { LoginAccountParams } from './protocol/v2/LoginAccountParams'
import type { LoginAccountResponse } from './protocol/v2/LoginAccountResponse'
import type { Model } from './protocol/v2/Model'
import type { ModelListParams } from './protocol/v2/ModelListParams'
import type { ModelListResponse } from './protocol/v2/ModelListResponse'
import type { ThreadCompactStartParams } from './protocol/v2/ThreadCompactStartParams'
import type { ThreadCompactStartResponse } from './protocol/v2/ThreadCompactStartResponse'
import type { ThreadForkParams } from './protocol/v2/ThreadForkParams'
import type { ThreadForkResponse } from './protocol/v2/ThreadForkResponse'
import type { ThreadGoal } from './protocol/v2/ThreadGoal'
import type { ThreadGoalClearParams } from './protocol/v2/ThreadGoalClearParams'
import type { ThreadGoalClearResponse } from './protocol/v2/ThreadGoalClearResponse'
import type { ThreadGoalSetParams } from './protocol/v2/ThreadGoalSetParams'
import type { ThreadGoalSetResponse } from './protocol/v2/ThreadGoalSetResponse'
import type { ThreadResumeParams } from './protocol/v2/ThreadResumeParams'
import type { ThreadResumeResponse } from './protocol/v2/ThreadResumeResponse'
import type { ThreadRevertParams } from './protocol/v2/ThreadRevertParams'
import type { ThreadRevertResponse } from './protocol/v2/ThreadRevertResponse'
import type { ThreadStartParams } from './protocol/v2/ThreadStartParams'
import type { ThreadStartResponse } from './protocol/v2/ThreadStartResponse'
import type { ThreadTurnsListParams } from './protocol/v2/ThreadTurnsListParams'
import type { ThreadTurnsListResponse } from './protocol/v2/ThreadTurnsListResponse'
import type { Turn } from './protocol/v2/Turn'
import type { TurnInterruptParams } from './protocol/v2/TurnInterruptParams'
import type { TurnInterruptResponse } from './protocol/v2/TurnInterruptResponse'
import type { TurnStartParams } from './protocol/v2/TurnStartParams'
import type { TurnStartResponse } from './protocol/v2/TurnStartResponse'
import type { TurnSteerParams } from './protocol/v2/TurnSteerParams'
import type { TurnSteerResponse } from './protocol/v2/TurnSteerResponse'
import type { ThreadItem } from './protocol/v2/ThreadItem'
import type { WindowsSandboxReadinessResponse } from './protocol/v2/WindowsSandboxReadinessResponse'

export type { InitializeResponse, ServerNotification, ServerRequest, ThreadGoal, ThreadItem, Turn, Model }
export type { AskForApproval } from './protocol/v2/AskForApproval'
export type { CollaborationMode } from './protocol/CollaborationMode'
export type { CommandExecutionApprovalDecision } from './protocol/v2/CommandExecutionApprovalDecision'
export type { CommandExecutionRequestApprovalParams } from './protocol/v2/CommandExecutionRequestApprovalParams'
export type { CommandExecutionRequestApprovalResponse } from './protocol/v2/CommandExecutionRequestApprovalResponse'
export type { FileChangeRequestApprovalParams } from './protocol/v2/FileChangeRequestApprovalParams'
export type { FileChangeRequestApprovalResponse } from './protocol/v2/FileChangeRequestApprovalResponse'
export type { FileUpdateChange } from './protocol/v2/FileUpdateChange'
export type { GrantedPermissionProfile } from './protocol/v2/GrantedPermissionProfile'
export type { McpServerElicitationRequestResponse } from './protocol/v2/McpServerElicitationRequestResponse'
export type { PermissionsRequestApprovalParams } from './protocol/v2/PermissionsRequestApprovalParams'
export type { PermissionsRequestApprovalResponse } from './protocol/v2/PermissionsRequestApprovalResponse'
export type { SandboxMode } from './protocol/v2/SandboxMode'
export type { SandboxPolicy } from './protocol/v2/SandboxPolicy'
export type { WindowsSandboxReadiness } from './protocol/v2/WindowsSandboxReadiness'
export type { ToolRequestUserInputParams } from './protocol/v2/ToolRequestUserInputParams'
export type { ToolRequestUserInputResponse } from './protocol/v2/ToolRequestUserInputResponse'
export type { UserInput } from './protocol/v2/UserInput'
export type { AccountLoginCompletedNotification, LoginAccountResponse, ModelListResponse, ThreadStartParams, TurnStartParams }

type Method<T extends { method: string }, M extends T['method']> = Extract<T, { method: M }>

/** The params of the notification the app-server sends under `M`. */
export type NotificationParams<M extends ServerNotification['method']> = Method<ServerNotification, M> extends { params: infer P } ? P : never

/** The params of the request the app-server sends under `M`. */
export type RequestParams<M extends ServerRequest['method']> = Method<ServerRequest, M>['params']

/** The requests the adapter sends, with their params and result: only what it calls, each from the generated types. */
export interface Calls {
  'thread/start': [ThreadStartParams, ThreadStartResponse]
  // docs/agents.md 8: on Windows, whether the sandbox every read-only and scoped-writes promise rests on is set up. No params.
  'windowsSandbox/readiness': [undefined, WindowsSandboxReadinessResponse]
  'thread/resume': [ThreadResumeParams, ThreadResumeResponse]
  // docs/agents.md 3: a native fork through a turn, compaction on request, the thread's goal, and history rollback.
  'thread/fork': [ThreadForkParams, ThreadForkResponse]
  'thread/compact/start': [ThreadCompactStartParams, ThreadCompactStartResponse]
  'thread/goal/set': [ThreadGoalSetParams, ThreadGoalSetResponse]
  'thread/goal/clear': [ThreadGoalClearParams, ThreadGoalClearResponse]
  'thread/revert': [ThreadRevertParams, ThreadRevertResponse]
  'thread/turns/list': [ThreadTurnsListParams, ThreadTurnsListResponse]
  'turn/start': [TurnStartParams, TurnStartResponse]
  'turn/steer': [TurnSteerParams, TurnSteerResponse]
  'turn/interrupt': [TurnInterruptParams, TurnInterruptResponse]
  'model/list': [ModelListParams, ModelListResponse]
  'account/login/start': [LoginAccountParams, LoginAccountResponse]
  'account/login/cancel': [CancelLoginAccountParams, unknown]
}

/** The thread settings Foreman sends on thread/start and thread/resume (resume adds the thread's id). */
export type ThreadSettings = Pick<ThreadStartParams, 'model' | 'cwd' | 'approvalPolicy' | 'sandbox' | 'developerInstructions' | 'serviceTier' | 'config'>

/** A turn as the adapter reads it: the generated fields it uses, the rest optional (an older CLI, a test's partial frame). */
export type TurnInfo = Pick<Turn, 'status'> & { id?: string; error?: { message?: string } | null }

/** One entry of `model/list`, with only the fields the adapter reads. */
export type ModelEntry = Pick<Model, 'id' | 'model' | 'displayName' | 'description' | 'hidden' | 'defaultReasoningEffort' | 'isDefault'> & {
  supportedReasoningEfforts: { reasoningEffort: string }[]
  serviceTiers?: { id: string }[]
}

/**
 * A notification off the wire. The method is a string until it is checked: `switch (n.method)` then narrows `n.params` to the
 * generated type, and a method the pinned CLI doesn't have is a compile error in the `case`.
 */
export function notification(method: string, params: unknown): ServerNotification {
  return { method, params } as ServerNotification
}

/** A request off the wire, narrowed the same way. */
export function serverRequest(method: string, params: unknown): ServerRequest {
  return { method, params } as ServerRequest
}

/** `server.request` with the method's own params and result types. */
export function call<M extends keyof Calls>(server: { request<T>(method: string, params: unknown): Promise<T> }, method: M, params: Calls[M][0]): Promise<Calls[M][1]> {
  return server.request<Calls[M][1]>(method, params)
}
