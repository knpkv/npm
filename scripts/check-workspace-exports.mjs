#!/usr/bin/env node
/**
 * Fails when a workspace package's entry points cannot be loaded by Node, linked or published.
 *
 * A package whose `exports` (or `main`, without exports) resolve to TypeScript works under tsx, Bun
 * and Vitest but not under Node, so its own linked executable, and every dependent's, crashes with
 * ERR_MODULE_NOT_FOUND. Point the runtime condition at the build output; `types` may stay on the
 * sources:
 *
 *   ".": { "types": "./src/index.ts", "default": "./dist/index.js" }
 *
 * `publishConfig.exports` replaces `exports` on publish, so it must list the same subpaths; one it
 * lacks falls through to a wildcard that may name a file that does not exist.
 *
 * A private package with no executable is exempt from the TypeScript rule: it is only ever loaded by
 * a TypeScript-aware tool, as `@knpkv/storybook-config` is by Storybook.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"

import { exportEntries, runtimeTargets, workspacePackages } from "./workspace-manifests.mjs"

const typeScriptFile = /\.(?:c|m)?tsx?$/

/** `"<subpath> -> <target>"` for each entry point of `manifest` that Node would load as TypeScript. */
export const typeScriptRuntimeExports = (manifest) => {
  if (manifest.private === true && manifest.bin === undefined) return []
  if (manifest.exports === undefined) {
    return [
      ["main", manifest.main],
      ["module", manifest.module]
    ].flatMap(([field, target]) =>
      target !== undefined && typeScriptFile.test(target) ? [`${field} -> ${target}`] : []
    )
  }
  return exportEntries(manifest.exports).flatMap(([subpath, entry]) =>
    runtimeTargets(entry)
      .filter((target) => typeScriptFile.test(target))
      .map((target) => `${subpath} -> ${target}`)
  )
}

/** Subpaths the workspace exports but the published manifest does not, or the reverse. */
export const unpublishedSubpaths = (manifest) => {
  const published = manifest.publishConfig?.exports
  const comparable = (exports) => exports !== undefined && !Predicate.isString(exports) && !Array.isArray(exports)
  if (!comparable(manifest.exports) || !comparable(published)) return []
  const workspaceKeys = exportEntries(manifest.exports).map(([subpath]) => subpath)
  const publishedKeys = exportEntries(published).map(([subpath]) => subpath)
  return [
    ...workspaceKeys
      .filter((key) => !publishedKeys.includes(key))
      .map((key) => `${key} is not in publishConfig.exports`),
    ...publishedKeys
      .filter((key) => !workspaceKeys.includes(key))
      .map((key) => `${key} is only in publishConfig.exports`)
  ]
}

class WorkspaceExportsError extends Data.TaggedError("WorkspaceExportsError") {}

const program = Effect.gen(function* () {
  const packages = yield* workspacePackages
  const problems = packages.flatMap(({ manifest }) =>
    [...typeScriptRuntimeExports(manifest), ...unpublishedSubpaths(manifest)].map(
      (problem) => `${manifest.name}: ${problem}`
    )
  )
  if (problems.length > 0) {
    return yield* new WorkspaceExportsError({
      reason: [
        "Package entry points that Node cannot load, linked or published:",
        ...problems.map((problem) => `  ${problem}`),
        'Point runtime conditions at the build output, keep "types" on the source, and give publishConfig.exports the same subpaths.'
      ].join("\n")
    })
  }
  yield* Console.log("Workspace exports resolve to JavaScript at runtime")
})

// Report a failure as its message alone (no stack), then exit non-zero.
const main = program.pipe(
  Effect.tapError((error) =>
    error._tag === "WorkspaceExportsError" ? Console.error(error.reason) : Console.error(error)
  ),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) NodeRuntime.runMain(main, { disableErrorReporting: true })
