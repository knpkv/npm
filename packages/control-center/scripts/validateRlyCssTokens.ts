import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { declaredRlyCssTokens } from "./rlyCssTokens.js"
import { inspectRlyCssTokenWorkspace, RLY_CSS_TOKEN_SOURCE_ROOTS } from "./rlyCssTokenValidation.js"

class RlyCssTokenValidationError extends Data.TaggedError("RlyCssTokenValidationError")<{
  readonly reason: string
}> {
  override get message(): string {
    return this.reason
  }
}

const program = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const workspaceRoot = path.dirname(path.dirname(packageRoot))
  const generatedTokenPath = path.join(workspaceRoot, "packages", "rly", "src", "styles", "generated-tokens.css")
  const generatedTokenSource = yield* fileSystem.readFileString(generatedTokenPath)
  const generatedTokens = declaredRlyCssTokens(generatedTokenSource)
  if (generatedTokens.size === 0) {
    return yield* new RlyCssTokenValidationError({ reason: "The generated rly token contract contains no tokens" })
  }

  const { filesChecked, violations } = yield* inspectRlyCssTokenWorkspace(workspaceRoot, generatedTokens)

  if (violations.length > 0) {
    return yield* new RlyCssTokenValidationError({
      reason: violations
        .map(({ column, line, sourcePath, token }) =>
          `${sourcePath}:${line}:${column} unresolved rly custom property ${token}`
        )
        .join("\n")
    })
  }

  yield* Console.log(
    `Workspace rly CSS token references checked ${filesChecked} stylesheets across ${RLY_CSS_TOKEN_SOURCE_ROOTS.length} source trees`
  )
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error.message)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
