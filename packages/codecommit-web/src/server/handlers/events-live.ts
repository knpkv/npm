import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { CodeCommitApi } from "../Api.js"

// SSE endpoint - stub for now
export const EventsLive = HttpApiBuilder.group(CodeCommitApi, "events", (handlers) =>
  Effect.succeed(
    handlers.handle("stream", () => Effect.succeed("data: connected\n\n"))
  )
)
