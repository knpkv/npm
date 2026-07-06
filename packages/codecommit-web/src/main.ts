import { Context, Effect } from "effect"
import { CodeCommitServerLive } from "./server/Server.js"

const program = CodeCommitServerLive.pipe(
  Effect.catchCause((cause) => Effect.logError("Server error", cause)),
  Effect.asVoid
)
const RuntimeContextMarker = Context.Service<unknown, unknown>("@knpkv/codecommit-web/RuntimeContextMarker")
const runtimeContext = Context.make(RuntimeContextMarker, undefined)

Effect.runPromiseWith(runtimeContext)(Effect.scoped(program))
