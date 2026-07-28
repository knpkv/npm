import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

import { PluginConnectionId } from "../domain/identifiers.js"
import {
  PluginPipelineArtifactRangeRequestV1,
  PluginPipelineLogPageRequestV1,
  PluginPipelineLogPageV1
} from "../domain/plugins/index.js"
import {
  ConflictApiError,
  ForbiddenApiError,
  NotFoundApiError,
  RateLimitedApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError,
  UnauthorizedApiError
} from "./errors.js"
import { SessionCookieAuth } from "./session.js"

/** Workspace-scoped request for one bounded CodePipeline action log page. */
export const CodePipelineLogReadRequest = Schema.Struct({
  pluginConnectionId: PluginConnectionId,
  request: PluginPipelineLogPageRequestV1
})

/** Workspace-scoped request for one bounded CodePipeline action artifact range. */
export const CodePipelineArtifactReadRequest = Schema.Struct({
  pluginConnectionId: PluginConnectionId,
  request: PluginPipelineArtifactRangeRequestV1
})

const readErrors = [
  UnauthorizedApiError,
  ForbiddenApiError,
  NotFoundApiError,
  ConflictApiError,
  RateLimitedApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError
]

const logs = HttpApiEndpoint.post("logs", "/logs", {
  payload: CodePipelineLogReadRequest,
  success: PluginPipelineLogPageV1,
  error: readErrors
}).middleware(SessionCookieAuth)

const artifact = HttpApiEndpoint.post("artifact", "/artifact", {
  payload: CodePipelineArtifactReadRequest,
  success: HttpApiSchema.StreamUint8Array({ contentType: "application/octet-stream" }),
  error: readErrors
}).middleware(SessionCookieAuth)

/** Authenticated workspace-scoped CodePipeline evidence proxy. */
export class CodePipelineApiGroup extends HttpApiGroup.make("codepipeline")
  .add(logs)
  .add(artifact)
  .prefix("/api/v1/codepipeline")
{}
