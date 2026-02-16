import { Effect } from "effect"
import { CodeCommitServerLive } from "./server/Server.js"

const program = CodeCommitServerLive.pipe(
  Effect.catchAllCause((cause) => Effect.logError("Server error", cause)),
  Effect.asVoid
)

Effect.runPromise(program)
