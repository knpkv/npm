/**
 * The Relay contracts every product and the dock share.
 *
 * **Mental model**
 *
 * - **An {@link ObjectRef} is what a conversation is about.** A pull request, a jcf week, a herdr
 *   goal. Relay keeps one durable session per ref, so the same question about the same object finds
 *   its history again.
 * - **A capability (`@knpkv/capability`) is the only way Relay touches a product.** Its contract declares
 *   input, output and failure as Schema, and its access: `read` runs, `write` waits for the person to
 *   confirm the exact action in the dock, `host` waits for a herdr Approval. The harness enforces it; the
 *   product never sees an unconfirmed write.
 * - **A {@link RelayEvent} is the only thing the dock renders.** Every event carries the session and a
 *   `seq` that counts up within one subscription. A dock that reconnects starts a new subscription: a
 *   `Snapshot` first (with any run in flight and any pending confirmation), then live events. `seq` is not
 *   comparable across subscriptions; render the Snapshot rather than deduplicating by `seq`.
 *
 * @module
 */
import * as Capability from "@knpkv/capability"
import { Schema } from "effect"

const Name = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200))

/** The products Relay can be about. */
export const RelayProduct = Schema.Literals(["codecommit", "jcf", "agent-usage", "control-center", "herdr"])
export type RelayProduct = typeof RelayProduct.Type

/** A product object a Relay session is about. Relay keeps sessions only for the products it knows. */
export const ObjectRef = Schema.Struct({
  product: RelayProduct,
  kind: Name,
  id: Name
})
export interface ObjectRef extends Schema.Schema.Type<typeof ObjectRef> {}

/** The key a session is stored under. Unique per product, kind and id: JSON-encoded, so no field can contain the separator. */
export const objectRefKey = (ref: ObjectRef): string => JSON.stringify([ref.product, ref.kind, ref.id])

/** Who must agree before a capability runs, as the dock lists it. */
export const CapabilityAccess = Schema.Literals(["read", "write", "host"])
export type CapabilityAccess = typeof CapabilityAccess.Type

/** Why a backend can't answer yet, and the one action that fixes it. */
export const BackendUnavailableCause = Schema.Literals(["NotInstalled", "SignedOut", "Misconfigured", "NoCapability"])
export type BackendUnavailableCause = typeof BackendUnavailableCause.Type

/** The backends Relay supports: each runs on the user's own CLI login, never on a token Relay holds. */
export const RelayBackendId = Schema.Literals(["claude-code", "codex-cli"])
export type RelayBackendId = typeof RelayBackendId.Type

const backendFields = { backend: RelayBackendId, label: Schema.String }

/**
 * What setup shows for one backend. `Unverified` (installed, version known, never answered yet) until a turn
 * answers (`Ready`) or is refused for sign-in (`Unavailable` with `SignedOut`). Not persisted: every start is
 * `Unverified` or `Unavailable` again. `fix` is one line the person can act on.
 */
export const BackendStatus = Schema.TaggedUnion({
  Unverified: { ...backendFields, version: Schema.String },
  Ready: { ...backendFields, version: Schema.String },
  Unavailable: {
    ...backendFields,
    version: Schema.optionalKey(Schema.String),
    cause: BackendUnavailableCause,
    fix: Schema.String
  }
})
export type BackendStatus = typeof BackendStatus.Type

/** Why a confirmation can't be answered: answered already, withdrawn with its run, or never asked. */
export const DecisionState = Schema.TaggedUnion({
  Decided: { allow: Schema.Boolean },
  Expired: {},
  Unknown: {}
})
export type DecisionState = typeof DecisionState.Type

/** One tool as the dock lists it for a session. */
export const SessionTool = Schema.Struct({
  name: Name,
  access: CapabilityAccess,
  available: Schema.Boolean,
  unavailableReason: Schema.optional(Schema.String)
})
export interface SessionTool extends Schema.Schema.Type<typeof SessionTool> {}

/**
 * What the dock shows for a session: its tools, the backend its next turn runs on, and whether a run can
 * be stopped (the dock offers Stop only when `cancel` is true).
 */
export const SessionInfo = Schema.Struct({
  tools: Schema.Array(SessionTool),
  backend: RelayBackendId,
  cancel: Schema.Boolean
})
export interface SessionInfo extends Schema.Schema.Type<typeof SessionInfo> {}

/**
 * What a confirmed write did, as the product projects it: a display-safe line, the provider's id for what
 * was made, and where to see it.
 */
export const WriteReceipt = Schema.Struct({
  summary: Schema.String,
  providerId: Schema.String,
  link: Schema.optionalKey(Schema.String)
})
export interface WriteReceipt extends Schema.Schema.Type<typeof WriteReceipt> {}

const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const eventFields = { session: Name, seq: Seq }

/** The `requestId`s of the messages a run answers: one run can take several queued messages. */
const RunIds = Schema.Array(Name)

/** Everything the dock renders. `seq` counts up within one subscription; a reconnect starts from a `Snapshot`. */
export const RelayEvent = Schema.TaggedUnion({
  Snapshot: {
    ...eventFields,
    messages: Schema.Array(
      Schema.Struct({ id: Name, role: Schema.Literals(["user", "relay"]), text: Schema.String })
    ),
    /** The run in flight, empty when idle. */
    runIds: RunIds,
    /** Messages accepted but not yet in the transcript, oldest first: they wait for the run in flight. */
    queued: RunIds
  },
  /**
   * A message the server accepted that waits for the run in flight. It joins the transcript with its own
   * `MessagePlaced`, or leaves with `MessageWithdrawn`.
   */
  MessageQueued: { ...eventFields, requestId: Name },
  /** A message the server placed in the transcript; `id` is its transcript id, as a later Snapshot names it. */
  MessagePlaced: { ...eventFields, id: Name, requestId: Name, text: Schema.String },
  /** A queued message the person withdrew before any run took it. */
  MessageWithdrawn: { ...eventFields, requestId: Name },
  RunStarted: { ...eventFields, runIds: RunIds },
  TextDelta: { ...eventFields, text: Schema.String },
  /** `summary` is a server-built, display-safe line; `input` is the call's typed arguments. */
  ToolStarted: { ...eventFields, call: Name, capability: Name, summary: Schema.String, input: Schema.Json },
  /** `receipt` is set when a write completed and its capability projects one. */
  ToolFinished: {
    ...eventFields,
    call: Name,
    ok: Schema.Boolean,
    summary: Schema.String,
    cites: Schema.Array(Capability.ObjectRef),
    receipt: Schema.optionalKey(WriteReceipt)
  },
  ConfirmationRequired: { ...eventFields, call: Name, action: Capability.PendingAction, reversible: Schema.Boolean },
  /** The server's outcome for a confirmation: the card turns to past tense only on this. */
  ConfirmationResolved: {
    ...eventFields,
    call: Name,
    decision: Schema.Literals(["confirmed", "declined", "expired"])
  },
  ApprovalPending: { ...eventFields, call: Name, approvalId: Name },
  Cancelled: { ...eventFields, runIds: RunIds },
  RunFinished: { ...eventFields, runIds: RunIds },
  RunFailed: { ...eventFields, runIds: RunIds, cause: Schema.String, fix: Schema.String }
})
export type RelayEvent = typeof RelayEvent.Type
