import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { readJson } from "../src/references.js"
import { Manifest, RunnerFailure } from "../src/schema.js"

/** Hook-local Git routing and identity must not leak into another checkout or fixture. */
export const gitChildEnvironment = {
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_AUTHOR_DATE: undefined,
  GIT_AUTHOR_EMAIL: undefined,
  GIT_AUTHOR_NAME: undefined,
  GIT_CEILING_DIRECTORIES: undefined,
  GIT_COMMITTER_DATE: undefined,
  GIT_COMMITTER_EMAIL: undefined,
  GIT_COMMITTER_NAME: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_CONFIG: undefined,
  GIT_CONFIG_COUNT: undefined,
  GIT_CONFIG_PARAMETERS: undefined,
  GIT_DIR: undefined,
  GIT_GRAFT_FILE: undefined,
  GIT_IMPLICIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_NAMESPACE: undefined,
  GIT_NO_REPLACE_OBJECTS: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_PREFIX: undefined,
  GIT_REPLACE_REF_BASE: undefined,
  GIT_SHALLOW_FILE: undefined,
  GIT_WORK_TREE: undefined
}

/** Keep command arguments separate, including repository paths and Git revisions. */
export const gitText = Effect.fn("DesignConformance.gitText")(
  function*(repository: string, args: ReadonlyArray<string>) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("git", args, {
      cwd: repository,
      env: gitChildEnvironment,
      extendEnv: true,
      stderr: "inherit"
    }))
    const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
    if ((yield* handle.exitCode) !== 0) return yield* new RunnerFailure({ detail: `git ${args.join(" ")} failed` })
    return text
  },
  Effect.scoped
)

/** Base-only products remain discoverable so deleting refs cannot delete their CI job. */
export const discoverReferenceManifests = Effect.fn("DesignConformance.discoverReferenceManifests")(
  function*(repository: string, baseRef: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const revision = (yield* gitText(repository, ["merge-base", "HEAD", baseRef])).trim()
    const baseFiles =
      (yield* gitText(repository, ["ls-tree", "-r", "--name-only", "-z", revision, "--", "design-refs"]))
        .split("\0").filter((file) => /^design-refs\/[^/]+\/manifest\.json$/u.test(file))
    const base: Array<Manifest> = []
    for (const file of baseFiles) {
      const text = yield* gitText(repository, ["show", `${revision}:${file}`])
      const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(text)
      if (file !== `design-refs/${manifest.product}/manifest.json`) {
        return yield* new RunnerFailure({ detail: "Manifest product differs from directory" })
      }
      base.push(manifest)
    }
    const current: Array<Manifest> = []
    const root = path.join(repository, "design-refs")
    if (yield* fs.exists(root)) {
      for (const name of (yield* fs.readDirectory(root)).sort()) {
        const directory = path.join(root, name)
        if ((yield* fs.stat(directory)).type !== "Directory") continue
        const manifest = yield* readJson(path.join(directory, "manifest.json"), Manifest)
        if (manifest.product !== name) {
          return yield* new RunnerFailure({ detail: "Manifest product differs from directory" })
        }
        current.push(manifest)
      }
    }
    return { current, base }
  }
)

/** Current package metadata wins for retained products; deleted products retain base metadata. */
const hasImplementedState = (manifest: Manifest) => manifest.states.some((state) => state.status === "implemented")

/**
 * One gate job per product with an implemented state in the PR or its base. A refs-only product, every state still
 * designed on both sides, has no live screen to compare yet; its refs are hash-checked by the matrix step instead.
 */
export const productMatrix = (current: ReadonlyArray<Manifest>, base: ReadonlyArray<Manifest>) => {
  const gated = new Set([...base, ...current].filter(hasImplementedState).map((manifest) => manifest.product))
  return {
    include: Array.from(new Map(
      [...base, ...current].filter((manifest) => gated.has(manifest.product)).map((
        manifest
      ) => [manifest.product, { product: manifest.product, package: manifest.live.package }])
    ).values()).sort((
      left,
      right
    ) => left.product.localeCompare(right.product))
  }
}

/** Products the matrix leaves out because every state is still designed; their refs must still verify. */
export const refsOnlyProducts = (current: ReadonlyArray<Manifest>, base: ReadonlyArray<Manifest>) => {
  const gated = new Set(productMatrix(current, base).include.map((item) => item.product))
  return current.filter((manifest) => !gated.has(manifest.product)).map((manifest) => manifest.product)
}
