import { Effect, Layer } from "effect"
import { CodeCommitServerLive } from "./server/Server.js"

console.log("Starting CodeCommit Web on http://localhost:3000")

// Launch the server
const program = Layer.launch(CodeCommitServerLive).pipe(
  Effect.catchAllCause((cause) => Effect.logError("Server error", cause))
)

// Trigger initial refresh after server starts
setTimeout(async () => {
  try {
    console.log("Triggering initial refresh...")
    await fetch("http://localhost:3000/api/prs/refresh", { method: "POST" })
    console.log("Initial refresh complete")
  } catch (e) {
    console.error("Refresh failed:", e)
  }
}, 2000)

Effect.runPromise(program)
