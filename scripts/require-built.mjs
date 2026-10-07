#!/usr/bin/env node
/**
 * Stops a script with one line when a workspace package it imports has not been built.
 *
 * Workspace packages resolve to their build output, as they do once published, so a start or dev
 * script run before that package is built would otherwise fail deep in module resolution. Tests need
 * no build: vitest resolves `@knpkv/*` to source (`vitest.workspace-sources.ts`). Put this in front of
 * the script, naming every workspace package it imports:
 *
 *   node ../../scripts/require-built.mjs @knpkv/codecommit-core && bun src/bin.ts
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Stdio from "effect/Stdio"

import { rootRuntimeFile, workspacePackages } from "./workspace-manifests.mjs"

class NotBuilt extends Data.TaggedError("NotBuilt") {}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const stdio = yield* Stdio.Stdio
  const names = yield* stdio.args
  const packages = yield* workspacePackages
  const missing = yield* Effect.forEach(names, (name) => {
    const found = packages.find(({ manifest }) => manifest.name === name)
    const runtime = found === undefined ? undefined : rootRuntimeFile(found.manifest)
    if (found === undefined || runtime === undefined) {
      return Effect.succeed([`${name} is not a workspace package with a main export; fix the require-built.mjs call.`])
    }
    return fs
      .exists(path.join(found.directory, runtime))
      .pipe(Effect.map((built) => (built ? [] : [`build ${name} first: pnpm --filter "${name}..." build`])))
  })
  const lines = missing.flat()
  if (lines.length > 0) return yield* new NotBuilt({ reason: lines.join("\n") })
})

// One line per missing package, no stack, then a non-zero exit.
const main = program.pipe(
  Effect.tapError((error) => (error._tag === "NotBuilt" ? Console.error(error.reason) : Console.error(error))),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) NodeRuntime.runMain(main, { disableErrorReporting: true })
