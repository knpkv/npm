import { Effect, Layer } from "effect"
import { makeCodeCommitServer } from "./server/Server.js"

const startServer = (port: number): Effect.Effect<never> =>
  Effect.logInfo(`Starting CodeCommit Web on http://localhost:${port}`).pipe(
    Effect.andThen(Effect.suspend(() => Layer.launch(makeCodeCommitServer(port)))),
    Effect.catchAllDefect((defect) =>
      defect instanceof Error && defect.message.includes("port") && port < 3010
        ? Effect.logWarning(`Port ${port} in use, trying ${port + 1}`).pipe(
          Effect.andThen(startServer(port + 1))
        )
        : Effect.die(defect)
    )
  )

const program = startServer(3000).pipe(
  Effect.catchAllCause((cause) => Effect.logError("Server error", cause)),
  Effect.asVoid
)

Effect.runPromise(program)
