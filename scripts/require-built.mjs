#!/usr/bin/env node
/**
 * Stops a script with one line when a workspace package it imports is not built, or was built
 * before its last source change.
 *
 * Workspace packages resolve to their build output, as they do once published, so a start or dev
 * server would otherwise fail deep in module resolution, or worse, run old code without a word.
 * Start and dev scripts first run an incremental `tsc -b` of the packages they import (fast when
 * nothing changed), then this check, which fails loudly if that build left anything behind:
 *
 *   tsc -b ../codecommit-core && node ../../scripts/require-built.mjs @knpkv/codecommit-core && bun src/bin.ts
 *
 * Tests need no build: vitest resolves `@knpkv/*` to source (`vitest.workspace-sources.ts`).
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Stdio from "effect/Stdio"

import { rootRuntimeFile, workspacePackages } from "./workspace-manifests.mjs"

class NotBuilt extends Data.TaggedError("NotBuilt") {}

/** The newest modification time of any file below `directory`, in milliseconds; 0 when it is empty. */
const newestFile = (directory) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const entries = yield* fs.readDirectory(directory, { recursive: true })
    const times = yield* Effect.forEach(entries, (entry) =>
      fs
        .stat(path.join(directory, entry))
        .pipe(
          Effect.map((info) =>
            info.type === "File" ? Option.match(info.mtime, { onNone: () => 0, onSome: (mtime) => mtime.getTime() }) : 0
          )
        )
    )
    return Math.max(0, ...times)
  })

/** Why `name` cannot be run from its build output, or `undefined` when its build is current. */
const problem = (packages, name) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const found = packages.find(({ manifest }) => manifest.name === name)
    const runtime = found === undefined ? undefined : rootRuntimeFile(found.manifest)
    if (found === undefined || runtime === undefined) {
      return `${name} is not a workspace package with a main export; fix the require-built.mjs call.`
    }
    const rebuild = `pnpm --filter "${name}..." build`
    if (!(yield* fs.exists(path.join(found.directory, runtime)))) return `build ${name} first: ${rebuild}`
    // The build output as a whole ("dist"), since tsc rewrites only changed files, and the package's
    // own build info, which tsc -b refreshes even when a source edit changes no output.
    const outputRoot = path.join(found.directory, runtime.replace(/^\.\//u, "").split("/")[0] ?? "dist")
    const buildInfo = (yield* fs.readDirectory(found.directory)).filter((entry) => entry.endsWith(".tsbuildinfo"))
    const buildInfoTimes = yield* Effect.forEach(buildInfo, (entry) =>
      fs
        .stat(path.join(found.directory, entry))
        .pipe(Effect.map((info) => Option.match(info.mtime, { onNone: () => 0, onSome: (mtime) => mtime.getTime() })))
    )
    const [source, output] = yield* Effect.all([newestFile(path.join(found.directory, "src")), newestFile(outputRoot)])
    return source > Math.max(output, ...buildInfoTimes)
      ? `${name} was built before its last source change; rebuild it: ${rebuild}`
      : undefined
  })

const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const names = yield* stdio.args
  const packages = yield* workspacePackages
  const lines = (yield* Effect.forEach(names, (name) => problem(packages, name))).filter((line) => line !== undefined)
  if (lines.length > 0) return yield* new NotBuilt({ reason: lines.join("\n") })
})

// One line per unbuilt or stale package, no stack, then a non-zero exit.
const main = program.pipe(
  Effect.tapError((error) => (error._tag === "NotBuilt" ? Console.error(error.reason) : Console.error(error))),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) NodeRuntime.runMain(main, { disableErrorReporting: true })
