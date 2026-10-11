/** Server-private coordinates for a persisted opaque reference; never a browser DTO. @module */
import { Schema } from "effect"
import type { Effect } from "effect"
import type { CodeReference } from "../host-contract.js"
import { CodeUnavailable } from "../host-contract.js"

export const CodeCoordinates = Schema.Struct({
  accountId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  region: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  repository: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256))
})
export type CodeCoordinates = typeof CodeCoordinates.Type

export class CodeHostReadError extends Schema.TaggedError<CodeHostReadError>()("CodeHostReadError", {
  reason: Schema.Union([CodeUnavailable.fields.reason, Schema.Literal("not_found")])
}) {}

/** A host-owned private map; references persist across restart and have no locator encoding. */
export interface CodeReferenceStore {
  readonly reference: (coordinates: CodeCoordinates) => Effect.Effect<CodeReference, CodeHostReadError>
  readonly resolve: (reference: CodeReference) => Effect.Effect<CodeCoordinates | null, CodeHostReadError>
}
