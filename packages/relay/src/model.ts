/**
 * The Relay contracts every product and the dock share.
 *
 * **Mental model**
 *
 * - **An {@link ObjectRef} is what a conversation is about.** A pull request, a jcf week, a herdr
 *   goal. Relay keeps one durable session per ref, so the same question about the same object finds
 *   its history again.
 * - **A {@link Capability} is the only way Relay touches a product.** It declares its input, output and
 *   failure as Schema, and its permission class: `read` runs, `write` waits for the user to confirm the
 *   exact action in the dock, `host` waits for a herdr Approval. The harness enforces the class; the
 *   product never sees an unconfirmed write.
 * - **A {@link RelayEvent} is the only thing the dock renders.** Every event carries the session and a
 *   monotonic `seq`. A dock that reconnects receives a `Snapshot` first and the events after it.
 *
 * @module
 */
import type { Effect } from "effect"
import { Schema } from "effect"

const Name = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200))

/** The products Relay can be about. */
export const RelayProduct = Schema.Literals(["codecommit", "jcf", "agent-usage", "control-center", "herdr"])
export type RelayProduct = typeof RelayProduct.Type

/** A product object a Relay session is about. Product-namespaced and stable across restarts. */
export const ObjectRef = Schema.Struct({
  product: RelayProduct,
  kind: Name,
  id: Name
})
export interface ObjectRef extends Schema.Schema.Type<typeof ObjectRef> {}

/** The key a session is stored under. Unique per product, kind and id. */
export const objectRefKey = (ref: ObjectRef): string => `${ref.product}\u0000${ref.kind}\u0000${ref.id}`

/** How much a capability may do without a person deciding first. */
export const CapabilityEffect = Schema.Literals(["read", "write", "host"])
export type CapabilityEffect = typeof CapabilityEffect.Type

/** The exact action a `write` or `host` capability is about to take, shown to the user verbatim. */
export const PendingAction = Schema.Struct({
  verb: Name,
  target: ObjectRef,
  args: Schema.Json
})
export interface PendingAction extends Schema.Schema.Type<typeof PendingAction> {}

/**
 * One thing Relay can do in a product. The handler runs only after the harness has decoded the input
 * and, for `write` and `host`, after a person said yes.
 */
export interface Capability<Input, Output, Failure, Requirements> {
  readonly name: string
  readonly description: string
  readonly input: Schema.Codec<Input, unknown>
  readonly output: Schema.Codec<Output, unknown>
  readonly effect: CapabilityEffect
  /** Shown on the confirmation card: whether the action can be undone. Ignored for `read`. */
  readonly reversible: boolean
  /** The action as the user will see it on the confirmation card. Required for `write` and `host`. */
  readonly describe: (input: Input) => PendingAction
  /** The objects an answer may cite after this call. */
  readonly cites: (output: Output) => ReadonlyArray<ObjectRef>
  readonly handler: (input: Input) => Effect.Effect<Output, Failure, Requirements>
}

/** Declare a capability; a typed identity that keeps the input, output and failure types linked. */
export const defineCapability = <Input, Output, Failure, Requirements>(
  capability: Capability<Input, Output, Failure, Requirements>
): Capability<Input, Output, Failure, Requirements> => capability

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
  effect: CapabilityEffect,
  available: Schema.Boolean,
  unavailableReason: Schema.optional(Schema.String)
})
export interface SessionTool extends Schema.Schema.Type<typeof SessionTool> {}

const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const eventFields = { session: Name, seq: Seq }

/** Everything the dock renders. `seq` is monotonic per session; a reconnect starts from a `Snapshot`. */
export const RelayEvent = Schema.TaggedUnion({
  Snapshot: {
    ...eventFields,
    messages: Schema.Array(Schema.Struct({ role: Schema.Literals(["user", "relay"]), text: Schema.String }))
  },
  TextDelta: { ...eventFields, text: Schema.String },
  ToolStarted: { ...eventFields, call: Name, capability: Name, input: Schema.Json },
  ToolFinished: { ...eventFields, call: Name, ok: Schema.Boolean, cites: Schema.Array(ObjectRef) },
  ConfirmationRequired: { ...eventFields, call: Name, action: PendingAction, reversible: Schema.Boolean },
  ApprovalPending: { ...eventFields, call: Name, approvalId: Name },
  Cancelled: { ...eventFields },
  RunFinished: { ...eventFields },
  RunFailed: { ...eventFields, cause: Schema.String, fix: Schema.String }
})
export type RelayEvent = typeof RelayEvent.Type
