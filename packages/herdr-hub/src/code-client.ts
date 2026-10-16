/** Host-local reads only: no peer address, provider locator, owner cookie or mutation request. @module */
import {
  CodeCanvasResult,
  CodeDetail,
  type CodeDiffContentQuery,
  CodeDiffContentResult,
  CodeDiffResult,
  CodeQueue,
  type CodeQueueQuery,
  type CodeReference,
  CodeReviewResult
} from "@knpkv/codecommit-web/host"
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { Effect, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"

export class CodeReadFailed extends Schema.TaggedError<CodeReadFailed>()("CodeReadFailed", {
  reason: Schema.Literals(["not_found", "unauthorized", "network", "status", "invalid_response", "timeout"])
}) {}

export interface CodeModuleReads {
  readonly queue: (query: CodeQueueQuery) => Effect.Effect<CodeQueue, CodeReadFailed>
  readonly detail: (ref: CodeReference) => Effect.Effect<CodeDetail, CodeReadFailed>
  readonly review: (ref: CodeReference) => Effect.Effect<CodeReviewResult, CodeReadFailed>
  readonly diff: (ref: CodeReference) => Effect.Effect<CodeDiffResult, CodeReadFailed>
  readonly content: (query: CodeDiffContentQuery) => Effect.Effect<CodeDiffContentResult, CodeReadFailed>
  readonly canvas: (ref: CodeReference) => Effect.Effect<CodeCanvasResult, CodeReadFailed>
}

const load = Effect.fn("CodeClient.load")(
  function*<A>(path: string, schema: Schema.Codec<A, unknown, never, never>, maxBytes: number) {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(`/v1/modules/code/${path}`).pipe(
      Effect.mapError(() => new CodeReadFailed({ reason: "network" }))
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* new CodeReadFailed({
        reason: response.status === 404 ? "not_found" : response.status === 401 ? "unauthorized" : "status"
      })
    }
    return yield* decodeBoundedResponseJson(response, schema, maxBytes).pipe(
      Effect.mapError(() => new CodeReadFailed({ reason: "invalid_response" }))
    )
  },
  Effect.timeout("20 seconds"),
  Effect.catchTag("TimeoutError", () => Effect.fail(new CodeReadFailed({ reason: "timeout" })))
)

export const loadCodeQueue = (query: CodeQueueQuery) =>
  load(
    `queue?${new URLSearchParams({
      filter: query.filter,
      search: query.search,
      offset: String(query.offset)
    })}`,
    CodeQueue,
    524_288
  )
export const loadCodeDetail = (ref: CodeReference) =>
  load(`detail?${new URLSearchParams({ ref })}`, CodeDetail, 131_072)
export const loadCodeDiff = (ref: CodeReference) =>
  load(`diff?${new URLSearchParams({ ref })}`, CodeDiffResult, 8_388_608)
export const loadCodeReview = (ref: CodeReference) =>
  load(
    `review?${new URLSearchParams({ ref })}`,
    CodeReviewResult.check(Schema.makeFilter(
      (result) => result._tag === "Unavailable" || result.reading.workspace.identity.subjectId === ref,
      { expected: "review reading belongs to the requested opaque Code reference" }
    )),
    12_582_912
  )
export const loadCodeContent = (query: CodeDiffContentQuery) =>
  load(
    `diff-content?${new URLSearchParams({
      ref: query.ref,
      revisionId: query.revisionId,
      baseCommit: query.baseCommit,
      headCommit: query.headCommit,
      fileIndex: String(query.fileIndex)
    })}`,
    CodeDiffContentResult,
    16_777_216
  )
export const loadCodeCanvas = (ref: CodeReference) =>
  load(`canvas?${new URLSearchParams({ ref })}`, CodeCanvasResult, 8_388_608)
