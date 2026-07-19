/** Internal request snapshotting shared by the runtime boundary and deterministic fake. */
import * as Schema from "effect/Schema"

import { AgentRunRequest } from "./model.js"

const decodeAgentRunRequest = Schema.decodeUnknownSync(AgentRunRequest)

/** Decodes and deeply freezes one caller-independent request value. @internal */
export const captureAgentRunRequest = (request: AgentRunRequest): AgentRunRequest => {
  const snapshot = decodeAgentRunRequest(request)
  Object.freeze(snapshot.context)
  Object.freeze(snapshot.continuation)
  return Object.freeze(snapshot)
}
