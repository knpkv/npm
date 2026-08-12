import { BunRuntime } from "@effect/platform-bun"
import { ChildEnv } from "@knpkv/codecommit-core"
import { Context, Effect } from "effect"
import { CodeCommitServerLive } from "./server/Server.js"

const RuntimeContextMarker = Context.Service<unknown, unknown>("@knpkv/codecommit-web/RuntimeContextMarker")

BunRuntime.runMain(
  Effect.scoped(CodeCommitServerLive).pipe(
    Effect.provide(Context.make(RuntimeContextMarker, undefined)),
    // The executable boundary is the only place permitted to read the host process;
    // profile-scoped spawns need the environment they will actually inherit so the
    // ambient AWS variables can be tombstoned under whatever casing they carry.
    Effect.provide(ChildEnv.layerHostEnvironment(process.env))
  )
)
