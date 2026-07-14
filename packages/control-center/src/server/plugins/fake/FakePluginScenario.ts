import type * as Deferred from "effect/Deferred"

/** One untrusted fake-provider response decoded by the same Schema boundary as a real adapter. */
export type FakePluginResponse =
  | { readonly _tag: "success"; readonly value: unknown }
  | { readonly _tag: "authentication" }
  | { readonly _tag: "authorization" }
  | { readonly _tag: "rate-limit"; readonly retryAt: unknown }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "malformed"; readonly diagnosticCode: string }
  | { readonly _tag: "outage" }
  | { readonly _tag: "cancellation" }

/** Deterministic latch used to prove in-flight provider effects are interruptible. */
export interface FakePluginExecutionGate {
  readonly entered: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}

/** Fully deterministic script for one fake connection runtime. */
export interface FakePluginScenario {
  readonly descriptor: unknown
  readonly discover: FakePluginResponse
  readonly health: FakePluginResponse
  readonly sync: Readonly<Record<string, ReadonlyArray<FakePluginResponse>>>
  readonly readEntity: FakePluginResponse
  readonly proposeAction: FakePluginResponse
  readonly preflight: FakePluginResponse
  readonly executeAuthorizedAction: FakePluginResponse
  readonly executeAuthorizedActionGate?: FakePluginExecutionGate
  readonly requestCancellation: FakePluginResponse
  readonly reconcile: Readonly<Record<string, ReadonlyArray<FakePluginResponse>>>
}

/** Stable lookup key for replayable sync scripts. */
export const fakeSyncScriptKey = (streamKey: string, checkpoint: string | null): string =>
  `${streamKey}:${checkpoint ?? "initial"}`

/** Stable lookup key for ambiguous-outcome reconciliation scripts. */
export const fakeReconciliationScriptKey = (reconciliationKey: string, idempotencyKey: string): string =>
  `${reconciliationKey}:${idempotencyKey}`
