import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { PluginMalformedResponseFailure } from "../failures.js"

const PIPELINE_STATE_STAGE_LIMIT = 50
const PIPELINE_STATE_ACTION_LIMIT = 50

const PipelineStateIdentifier = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024)
)

const CodePipelineStateProviderOutput = Schema.Struct({
  pipelineName: PipelineStateIdentifier,
  pipelineVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  stageStates: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        stageName: PipelineStateIdentifier,
        actionStates: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              actionName: PipelineStateIdentifier,
              currentRevision: Schema.optionalKey(
                Schema.Struct({
                  revisionId: PipelineStateIdentifier,
                  revisionChangeId: Schema.optionalKey(PipelineStateIdentifier),
                  created: Schema.optionalKey(Schema.Date)
                })
              ),
              latestExecution: Schema.optionalKey(
                Schema.Struct({
                  actionExecutionId: Schema.optionalKey(PipelineStateIdentifier),
                  status: Schema.optionalKey(PipelineStateIdentifier),
                  token: Schema.optionalKey(PipelineStateIdentifier),
                  lastStatusChange: Schema.optionalKey(Schema.Date)
                })
              )
            })
          ).check(Schema.isMaxLength(PIPELINE_STATE_ACTION_LIMIT))
        )
      })
    ).check(Schema.isMaxLength(PIPELINE_STATE_STAGE_LIMIT))
  )
})

/**
 * Decode the repository-owned CodePipeline state contract shipped in the
 * published Control Center server bundle.
 *
 * @internal
 */
export const decodeCodePipelineStateProviderOutput = Effect.fn(
  "CodePipelineStateDecoder.decodeCodePipelineStateProviderOutput"
)(function*<UnparsedInput>(value: UnparsedInput) {
  return yield* Schema.decodeUnknownEffect(Schema.toType(CodePipelineStateProviderOutput))(value).pipe(
    Effect.mapError(
      () =>
        new PluginMalformedResponseFailure({
          operation: "codepipeline-get-state",
          diagnosticCode: "codepipeline-provider-response-invalid"
        })
    )
  )
})
