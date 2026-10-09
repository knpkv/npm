/**
 * Relay's wire contract: what a product's `/…/relay` routes accept and send, and what the browser decodes.
 * Browser-safe: it imports only `effect` and `@knpkv/capability`, never the harness, Pi or SQLite, so a page
 * can import `@knpkv/relay/wire` without pulling the server in.
 *
 * **Mental model**
 *
 * - **One stream per conversation.** `GET events?product&kind&id` sends `data: <RelayStreamFrame JSON>`
 *   frames: a `Snapshot` first, then live {@link RelayEvent}s. `Unauthorized` (the browser's session ended)
 *   and `StreamFailed` (the server could not read the session's events) end the stream.
 * - **Writes answer with what happened.** `messages` is 202 {@link RelayMessageAccepted}; `cancel` and
 *   `decisions` are 204, or 409 {@link RelayConflictError} with the state they found. Every route can be 503
 *   {@link RelayUnavailableError} with the fix when Relay could not start in that process.
 *
 * A product narrows `ref` to its own objects and may add a typed `context` to a message; both are its own
 * schema built on these.
 *
 * @module
 */
import { Schema } from "effect"
import { DecisionState, ObjectRef, RelayBackendId, RelayEvent } from "./model.js"

export {
  BackendStatus,
  BackendUnavailableCause,
  CapabilityAccess,
  DecisionState,
  ObjectRef,
  objectRefKey,
  RelayBackendId,
  RelayEvent,
  RelayProduct,
  SessionInfo,
  SessionTool,
  WriteReceipt
} from "./model.js"

const Name = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200))

/** One `data:` frame of the events stream: an event, or why the stream ended. */
export const RelayStreamFrame = Schema.Union([
  RelayEvent,
  Schema.TaggedStruct("Unauthorized", {}),
  Schema.TaggedStruct("StreamFailed", {})
])
export type RelayStreamFrame = typeof RelayStreamFrame.Type

/** The text a message may carry. */
export const RelayMessageText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(20_000))

/**
 * `POST messages`. `requestId` is the client's: a retry with the same one lands once, and the run that
 * answers carries it in `runIds`. `backend` switches the session from its next turn on.
 */
export const RelayMessageRequest = Schema.Struct({
  ref: ObjectRef,
  text: RelayMessageText,
  requestId: Name,
  backend: Schema.optionalKey(RelayBackendId)
})
export interface RelayMessageRequest extends Schema.Schema.Type<typeof RelayMessageRequest> {}

/** `messages` answers 202 with the run id, which is the request id. */
export const RelayMessageAccepted = Schema.Struct({ runId: Schema.String })
export interface RelayMessageAccepted extends Schema.Schema.Type<typeof RelayMessageAccepted> {}

/** `POST cancel`: withdraws a queued message, or stops the run in flight. */
export const RelayCancelRequest = Schema.Struct({ ref: ObjectRef, runId: Name })
export interface RelayCancelRequest extends Schema.Schema.Type<typeof RelayCancelRequest> {}

/** `POST decisions`: the person's answer to one confirmation card. */
export const RelayDecisionRequest = Schema.Struct({ ref: ObjectRef, callId: Name, allow: Schema.Boolean })
export interface RelayDecisionRequest extends Schema.Schema.Type<typeof RelayDecisionRequest> {}

/** What a 409 found instead: the run already over, or the confirmation decided, expired or never asked. */
export const RelayConflictState = Schema.Union([DecisionState, Schema.TaggedStruct("NotRunning", {})])
export type RelayConflictState = typeof RelayConflictState.Type

/** Relay could not start in this process: another one owns its store, or the store is unreadable. */
export class RelayUnavailableError extends Schema.TaggedError<RelayUnavailableError>()(
  "RelayUnavailableError",
  { message: Schema.String, fix: Schema.String },
  { httpApiStatus: 503 }
) {}

/** A run or confirmation is no longer in the state the request assumed; `state` says which it is in. */
export class RelayConflictError extends Schema.TaggedError<RelayConflictError>()(
  "RelayConflictError",
  { state: RelayConflictState },
  { httpApiStatus: 409 }
) {}

/** The request named a backend this server does not offer, or was otherwise malformed. */
export class RelayBadRequestError extends Schema.TaggedError<RelayBadRequestError>()(
  "RelayBadRequestError",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}
