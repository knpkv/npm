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
import { Manifest, Name, RunnerFailure } from "../src/schema.js"

/** Capture the merge base with its own code and adapter, then remove this task's temporary checkout. */
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
    const handle = yield* spawner.spawn(ChildProcess.make(args[0] ?? "git", args.slice(1), { cwd, stderr: "inherit" }))
    const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
    const exit = yield* handle.exitCode
    if (exit !== 0) return yield* new RunnerFailure({ detail: `${args.join(" ")} exited ${exit}` })
    return text.trim()
  }, Effect.scoped)
  const baseRef = yield* Config.String("DESIGN_BASE_REF").pipe(Config.withDefault("origin/main"))
  const revision = yield* run(["git", "merge-base", "HEAD", baseRef])
  yield* fs.makeDirectory(output, { recursive: true })
  const manifestFile = `design-refs/${product}/manifest.json`
  const exists = yield* run(["git", "ls-tree", "--name-only", revision, "--", manifestFile])
  if (exists.length === 0) {
    yield* fs.writeFileString(path.join(output, "captures.json"), "[]")
    yield* fs.writeFileString(path.join(output, "new-product.txt"), revision)
    yield* Console.log(`${product}: no base product; every current state is new`)
    return
  }
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "design-conformance-base-" })
  const checkout = path.join(root, "checkout")
  yield* Effect.acquireRelease(
    run(["git", "worktree", "add", "--detach", checkout, revision]),
    () => run(["git", "worktree", "remove", "--force", checkout]).pipe(Effect.orDie)
  )
  const manifest = yield* readJson(path.join(checkout, manifestFile), Manifest)
  const memory = yield* fs.readFileString("/proc/meminfo")
  const available = Number(/MemAvailable:\s+(\d+)/u.exec(memory)?.[1])
  if (!Number.isFinite(available) || available < 3 * 1024 * 1024) {
    return yield* new RunnerFailure({ detail: "Base capture needs at least 3 GiB MemAvailable" })
  }
  yield* run(["pnpm", "install", "--frozen-lockfile"], checkout)
  yield* run(["pnpm", "--filter", `${manifest.live.package}...`, "build"], checkout)
  yield* run([
    "pnpm",
    "--filter",
    "@knpkv/design-conformance",
    "design:check",
    "--product",
    product,
    "--capture-only",
    "--output",
    output
  ], checkout)
}).pipe(Effect.scoped)

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
