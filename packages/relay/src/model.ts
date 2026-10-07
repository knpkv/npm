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

/** What setup shows for one backend. */
export const BackendStatus = Schema.TaggedUnion({
  Ready: { backend: RelayBackendId },
  Unavailable: { backend: RelayBackendId, cause: BackendUnavailableCause, fix: Schema.String }
})
export type BackendStatus = typeof BackendStatus.Type

/** One tool as the dock lists it for a session. */
export const SessionTool = Schema.Struct({
  name: Name,
  access: CapabilityAccess,
  available: Schema.Boolean,
  unavailableReason: Schema.optional(Schema.String)
})
export interface SessionTool extends Schema.Schema.Type<typeof SessionTool> {}

const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const eventFields = { session: Name, seq: Seq }

/** Everything the dock renders. `seq` counts up within one subscription; a reconnect starts from a `Snapshot`. */
export const RelayEvent = Schema.TaggedUnion({
  Snapshot: {
    ...eventFields,
    messages: Schema.Array(Schema.Struct({ role: Schema.Literals(["user", "relay"]), text: Schema.String }))
  },
  TextDelta: { ...eventFields, text: Schema.String },
  ToolStarted: { ...eventFields, call: Name, capability: Name, input: Schema.Json },
  ToolFinished: { ...eventFields, call: Name, ok: Schema.Boolean, cites: Schema.Array(Capability.ObjectRef) },
  ConfirmationRequired: { ...eventFields, call: Name, action: Capability.PendingAction, reversible: Schema.Boolean },
  ApprovalPending: { ...eventFields, call: Name, approvalId: Name },
  Cancelled: { ...eventFields },
  RunFinished: { ...eventFields },
  RunFailed: { ...eventFields, cause: Schema.String, fix: Schema.String }
})
export type RelayEvent = typeof RelayEvent.Type
