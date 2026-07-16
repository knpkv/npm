import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { inspectPackageContract } from "./package-contract.js"
import { inspectProductionSourceBoundaries } from "./source-boundary-validation.js"

class BoundaryValidationError extends Data.TaggedError("BoundaryValidationError")<{
  readonly reason: string
}> {}

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const packageSource = yield* fs.readFileString(path.join(packageRoot, "package.json"))
  const packageData = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(packageSource).pipe(
    Effect.mapError(() => new BoundaryValidationError({ reason: "package.json is not valid JSON" }))
  )
  const packageViolations = inspectPackageContract(packageData)
  if (packageViolations.length > 0) {
    return yield* Effect.fail(
      new BoundaryValidationError({
        reason: `Control Center package-contract violations:\n${packageViolations.join("\n")}`
      })
    )
  }

  const violations = yield* inspectProductionSourceBoundaries(packageRoot)

  if (violations.length > 0) {
    const details = violations
      .map(({ importPath, reason, sourcePath }) => `${sourcePath}: ${reason} (${JSON.stringify(importPath)})`)
      .join("\n")
    return yield* Effect.fail(
      new BoundaryValidationError({ reason: `Control Center source-boundary violations:\n${details}` })
    )
  }
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
