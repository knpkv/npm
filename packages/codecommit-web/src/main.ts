import { Effect } from "effect"
import { CodeCommitServerLive } from "./server/Server.js"

const program = CodeCommitServerLive.pipe(
  Effect.catchCause((cause) => Effect.logError("Server error", cause)),
  Effect.asVoid
) as Effect.Effect<void>

Effect.runPromise(program)
