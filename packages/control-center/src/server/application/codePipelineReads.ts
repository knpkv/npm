import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"

import {
  ApplicationConflict,
  ApplicationRateLimited,
  ApplicationServiceUnavailable,
  CodePipelineReads,
  type CompleteDiffReadError
} from "../api/ApplicationServices.js"
import { type PluginFailure, PluginUnsupportedCapabilityFailure } from "../plugins/failures.js"
import { PluginConnection, type PluginPipelineReaderV1 } from "../plugins/PluginConnection.js"
import type { PluginConnectionMapV1 } from "../plugins/PluginConnectionMap.js"

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

const mapPluginFailure = (failure: PluginFailure): CompleteDiffReadError => {
  switch (failure._tag) {
    case "PluginConflictFailure":
      return new ApplicationConflict()
    case "PluginRateLimitFailure":
      return new ApplicationRateLimited({ retryAt: failure.retryAt })
    case "PluginAuthenticationFailure":
    case "PluginAuthorizationFailure":
    case "PluginCancellationFailure":
    case "PluginConfigurationFailure":
    case "PluginMalformedResponseFailure":
    case "PluginOutageFailure":
    case "PluginTimeoutFailure":
    case "PluginUnknownOutcomeFailure":
    case "PluginUnsupportedCapabilityFailure":
      return unavailable()
  }
}

const withPipeline = <A>(
  pluginConnections: PluginConnectionMapV1 | null,
  capabilityId: "pipeline.logs" | "pipeline.artifact",
  scope: {
    readonly workspaceId: Parameters<CodePipelineReads["Service"]["logs"]>[0]["workspaceId"]
    readonly pluginConnectionId: Parameters<CodePipelineReads["Service"]["logs"]>[0]["pluginConnectionId"]
  },
  use: (pipeline: PluginPipelineReaderV1) => Effect.Effect<A, PluginFailure>
): Effect.Effect<A, CompleteDiffReadError> => {
  if (pluginConnections === null) return Effect.fail(unavailable())
  return Effect.scoped(
    Effect.gen(function*() {
      const context = yield* pluginConnections.contextEffect(scope)
      const connection = Context.get(context, PluginConnection)
      if (connection.pipeline === undefined || Option.isNone(connection.pipeline)) {
        return yield* new PluginUnsupportedCapabilityFailure({
          capabilityId,
          requestedVersion: 1,
          diagnosticCode: "codepipeline-read-capability-unavailable"
        })
      }
      return yield* use(connection.pipeline.value)
    })
  ).pipe(Effect.mapError(mapPluginFailure))
}

/** Build workspace-scoped CodePipeline evidence reads over the lazy plugin registry. */
export const makeCodePipelineReads = (
  pluginConnections: PluginConnectionMapV1 | null
): CodePipelineReads["Service"] => ({
  logs: Effect.fn("CodePipelineReads.logs")(function*(input) {
    return yield* withPipeline(
      pluginConnections,
      "pipeline.logs",
      input,
      (pipeline) => pipeline.readLogPage(input.request)
    )
  }),
  artifact: Effect.fn("CodePipelineReads.artifact")(function*(input) {
    const range = yield* withPipeline(
      pluginConnections,
      "pipeline.artifact",
      input,
      (pipeline) => pipeline.readArtifactRange(input.request)
    )
    const bytes = yield* Effect.fromResult(Encoding.decodeBase64(range.bytesBase64)).pipe(
      Effect.mapError(() => unavailable())
    )
    return {
      body: Stream.succeed(bytes),
      contentLength: bytes.byteLength,
      filename: range.filename,
      offset: input.request.offset,
      totalBytes: range.totalBytes
    }
  })
})

/** CodePipeline evidence read layer for a configured scoped provider registry. */
export const codePipelineReadsLayer = (
  pluginConnections: PluginConnectionMapV1 | null
): Layer.Layer<CodePipelineReads> => Layer.succeed(CodePipelineReads, makeCodePipelineReads(pluginConnections))
