import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"

import { readJson } from "../src/references.js"
import { BaseComparison, Manifest, Name, RunnerFailure } from "../src/schema.js"
import { discoverReferenceManifests, gitChildEnvironment } from "./discovery.js"
import { checkBaseMemory } from "./memory.js"
import { baseCaptureMode, captureBaseProduct, isReferenceOnlyChange } from "./product.js"

/** Capture merge-base application code using the PR's gate, refs and adapter. */
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  const repository = yield* path.fromFileUrl(new URL("../../../", import.meta.url))
  const product = yield* Schema.decodeUnknownEffect(Name)(args[0])
  const output = path.resolve(args[1] ?? path.join(repository, "test-results/design-conformance/base", product))
  const run = Effect.fn("DesignBase.command")(function*(args: ReadonlyArray<string>, cwd = repository) {
    const handle = yield* spawner.spawn(ChildProcess.make(args[0] ?? "git", args.slice(1), {
      cwd,
      env: gitChildEnvironment,
      extendEnv: true,
      stderr: "inherit"
    }))
    const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
    const exit = yield* handle.exitCode
    if (exit !== 0) return yield* new RunnerFailure({ detail: `${args.join(" ")} exited ${exit}` })
    return text.trim()
  }, Effect.scoped)
  const baseRef = yield* Config.String("DESIGN_BASE_REF").pipe(Config.withDefault("origin/main"))
  const revision = yield* run(["git", "merge-base", "HEAD", baseRef])
  yield* fs.makeDirectory(output, { recursive: true })
  const manifestFile = `design-refs/${product}/manifest.json`
  const manifest = yield* readJson(path.join(repository, manifestFile), Manifest)
  const changedFiles = yield* run(["git", "diff", "--name-only", "--no-renames", "-z", revision, "HEAD"])
  const manifests = yield* discoverReferenceManifests(repository, baseRef)
  yield* fs.writeFileString(
    path.join(output, "comparison.json"),
    yield* Schema.encodeEffect(Schema.fromJsonString(BaseComparison))({
      referenceOnly: isReferenceOnlyChange(
        changedFiles.split("\0").filter((file) => file.length > 0),
        [...manifests.current, ...manifests.base]
      )
    })
  )
  const packageFile = `packages/${manifest.live.package.slice("@knpkv/".length)}/package.json`
  const exists = yield* run(["git", "ls-tree", "--name-only", revision, "--", packageFile])
  if ((yield* baseCaptureMode(manifest, manifests.base, exists.length > 0)) === "new") {
    yield* fs.writeFileString(path.join(output, "captures.json"), "[]")
    yield* Console.log(`${product}: no merge-base live package; live states are new`)
    return
  }
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "design-conformance-base-" })
  const checkout = path.join(root, "checkout")
  yield* Effect.acquireRelease(
    run(["git", "worktree", "add", "--detach", checkout, revision]),
    () => run(["git", "worktree", "remove", "--force", checkout]).pipe(Effect.orDie)
  )
  yield* checkBaseMemory()
  yield* run(["pnpm", "install", "--frozen-lockfile"], checkout)
  yield* run(["pnpm", "--filter", `${manifest.live.package}...`, "build"], checkout)
  yield* captureBaseProduct(repository, checkout, product, output)
}).pipe(Effect.scoped)

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
