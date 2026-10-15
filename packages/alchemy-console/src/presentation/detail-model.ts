import type { SourceFailureReason } from "../api.js"
import type { ResourceSummary, StackState } from "../schema.js"

/** A host may have a broader lifecycle model. The standalone persisted reader never manufactures failed/unknown events. */
export interface ResourcePresentation extends Omit<ResourceSummary, "status"> {
  readonly status: ResourceSummary["status"] | "failed" | null
}

/** SafeText requires the host's explicit non-sensitive proof. Persisted plaintext and marker absence are insufficient. */
export interface OutputPresentation {
  readonly key: string
  readonly value: { readonly _tag: "Hidden" } | {
    readonly _tag: "SafeText"
    readonly text: string
    readonly proof: "explicit-non-sensitive"
  }
  readonly description: string | null
}

/** Normalized authenticated presentation data, never raw state. Null output data means unavailable; [] proves empty. */
export interface StackPresentation extends Omit<StackState, "resources" | "outputs"> {
  readonly resources: ReadonlyArray<ResourcePresentation>
  readonly outputs: ReadonlyArray<OutputPresentation> | null
}

export type StackTab = "resources" | "outputs" | "state" | "plan"

/** Refresh and navigation replace the whole state, so a failed read cannot retain the previous stack. */
export type StackDetailState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly stack: StackPresentation }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Unauthorized"; readonly reason: "bootstrap" | "session" }
  | { readonly _tag: "Failed"; readonly reason: typeof SourceFailureReason.Type | "transport" | "forbidden" }
