import { BunRuntime } from "@effect/platform-bun"
import { Context, Effect } from "effect"
import { CodeCommitServerLive } from "./server/Server.js"

const RuntimeContextMarker = Context.Service<unknown, unknown>("@knpkv/codecommit-web/RuntimeContextMarker")

BunRuntime.runMain(
  Effect.scoped(CodeCommitServerLive).pipe(
    Effect.provide(Context.make(RuntimeContextMarker, undefined))
  )
)
