/** Read retained inventory progress using each first-party provider's checkpoint contract. @module */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { PluginCheckpointV1 } from "../../../domain/plugins/events.js"
import type { PluginStreamRecord } from "../../persistence/repositories/pluginRuntimeModels.js"
import { codeCommitInventoryIsComplete } from "../../plugins/codecommit/CodeCommitPluginDefinition.js"
import { codePipelineInventoryIsComplete } from "../../plugins/codepipeline/CodePipelinePluginDefinition.js"
import { confluenceInventoryIsComplete } from "../../plugins/confluence/ConfluencePageAdapter.js"
import { jiraInventoryIsComplete } from "../../plugins/jira/JiraReadPlugin.js"

/** A terminal invocation alone cannot certify a fully observed provider inventory. */
export const readinessInventoryIsComplete = Effect.fn("ReadinessEvaluation.inventoryIsComplete")(function*(
  stream: PluginStreamRecord
) {
  if (stream.headPageTerminal !== true || stream.checkpointJson === null) return false
  const checkpoint = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.NullOr(PluginCheckpointV1)))(
    stream.checkpointJson
  )
  switch (stream.providerId) {
    case "jira":
      return yield* jiraInventoryIsComplete(checkpoint)
    case "codecommit":
      return yield* codeCommitInventoryIsComplete(checkpoint)
    case "codepipeline":
      return yield* codePipelineInventoryIsComplete(checkpoint)
    case "confluence":
      return yield* confluenceInventoryIsComplete(checkpoint)
    case "clockify":
      return false
    default: {
      const unsupported: never = stream.providerId
      return unsupported
    }
  }
})
