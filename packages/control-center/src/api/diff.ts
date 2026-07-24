import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

import { PluginConnectionId } from "../domain/identifiers.js"
import { PluginDiffInventoryEntryV1 } from "../domain/plugins/events.js"
import { Revision, VendorImmutableId } from "../domain/sourceRevision.js"
import {
  ConflictApiError,
  ForbiddenApiError,
  InvalidRequestApiError,
  NotFoundApiError,
  PayloadTooLargeApiError,
  RateLimitedApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError,
  UnauthorizedApiError
} from "./errors.js"
import { SessionCookieAuth } from "./session.js"

const MaximumCompleteDiffFiles = 500

/** Lowercase SHA-256 digest of canonical exact-revision diff-file identity. */
export const DiffFileAnchor = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 diff-file anchor" })
).pipe(Schema.brand("DiffFileAnchor"))

/** Decoded stable diff-file anchor. */
export type DiffFileAnchor = typeof DiffFileAnchor.Type

/** One file from a completely indexed immutable pull-request revision. */
export const CompleteDiffInventoryEntry = Schema.Struct({
  ...PluginDiffInventoryEntryV1.fields,
  anchor: DiffFileAnchor
}).annotate({ identifier: "CompleteDiffInventoryEntry" })

/** Decoded complete-inventory entry. */
export type CompleteDiffInventoryEntry = typeof CompleteDiffInventoryEntry.Type

/** Complete bounded inventory; `ready` is emitted only after pagination ends. */
export const CompleteDiffInventory = Schema.Struct({
  entries: Schema.Array(CompleteDiffInventoryEntry).check(
    Schema.makeFilter((entries) => entries.length <= MaximumCompleteDiffFiles, {
      expected: `at most ${MaximumCompleteDiffFiles} changed files`
    })
  ),
  ready: Schema.Literal(true)
}).annotate({ identifier: "CompleteDiffInventory" })

/** Decoded complete immutable inventory. */
export type CompleteDiffInventory = typeof CompleteDiffInventory.Type

const BoundedOffset = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.check(Schema.isLessThanOrEqualTo(1_048_576))
)
const BoundedLength = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 1_048_576 }))
)
const DiffPath = PluginDiffInventoryEntryV1.fields.path

/** Browser-safe lazy content result for one immutable side and range. */
export const CompleteDiffContentRange = Schema.Struct({
  bytesBase64: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_398_104))),
  totalBytes: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  unavailableReason: Schema.NullOr(
    Schema.Literals(["binary", "generated", "oversized", "missing", "provider-unavailable"])
  )
})
  .check(
    Schema.makeFilter(
      ({ bytesBase64, totalBytes, unavailableReason }) =>
        unavailableReason === null ? bytesBase64 !== null && totalBytes !== null : bytesBase64 === null,
      { expected: "available bounded content or an explicit unavailable reason" }
    )
  )
  .annotate({ identifier: "CompleteDiffContentRange" })

/** Decoded lazy content response. */
export type CompleteDiffContentRange = typeof CompleteDiffContentRange.Type

const diffReadErrors = [
  InvalidRequestApiError,
  UnauthorizedApiError,
  ForbiddenApiError,
  NotFoundApiError,
  ConflictApiError,
  RateLimitedApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError
]

const inventory = HttpApiEndpoint.get("inventory", "/:pluginConnectionId/pull-requests/:vendorImmutableId/inventory", {
  params: Schema.Struct({ pluginConnectionId: PluginConnectionId, vendorImmutableId: VendorImmutableId }),
  query: Schema.Struct({ revision: Revision }),
  success: CompleteDiffInventory,
  error: diffReadErrors
}).middleware(SessionCookieAuth)

export const CompleteDiffContentRequest = Schema.Struct({
  revision: Revision,
  anchor: DiffFileAnchor,
  path: DiffPath,
  previousPath: Schema.NullOr(DiffPath),
  status: PluginDiffInventoryEntryV1.fields.status,
  side: Schema.Literals(["before", "after"]),
  offset: BoundedOffset,
  length: BoundedLength
}).annotate({ identifier: "CompleteDiffContentRequest" })

/** Decoded bounded content-read payload. */
export type CompleteDiffContentRequest = typeof CompleteDiffContentRequest.Type

const content = HttpApiEndpoint.post("content", "/:pluginConnectionId/pull-requests/:vendorImmutableId/content", {
  params: Schema.Struct({ pluginConnectionId: PluginConnectionId, vendorImmutableId: VendorImmutableId }),
  payload: CompleteDiffContentRequest,
  success: CompleteDiffContentRange,
  error: [...diffReadErrors, PayloadTooLargeApiError]
}).middleware(SessionCookieAuth)

/** Authenticated, workspace-scoped, bounded complete-diff reads. */
export class DiffApiGroup extends HttpApiGroup.make("diff").add(inventory).add(content).prefix("/api/v1/diffs") {}
