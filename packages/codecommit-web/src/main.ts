import { BunRuntime, BunServices } from "@effect/platform-bun"
import { ChildEnv } from "@knpkv/codecommit-core"
import { Context, Effect, Layer } from "effect"
import { CodeCommitServerLive } from "./server/Server.js"

const RuntimeContextMarker = Context.Service<unknown, unknown>("@knpkv/codecommit-web/RuntimeContextMarker")

BunRuntime.runMain(
  Effect.scoped(CodeCommitServerLive).pipe(
    // The executable boundary is the only place permitted to read the host process;
    // profile-scoped spawns need the environment they will actually inherit so the
    // ambient AWS variables can be tombstoned under whatever casing they carry.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeContextMarker, undefined),
        ChildEnv.layerHostEnvironment(process.env),
        BunServices.layer
      )
    )
  )
)
