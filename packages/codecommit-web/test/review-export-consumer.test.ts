import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { Config, Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import type * as PlatformError from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { createRequire } from "node:module"

class ExportConsumerFixtureError extends Schema.TaggedError<ExportConsumerFixtureError>()(
  "ExportConsumerFixtureError",
  { detail: Schema.String }
) {}

const ExportTarget = Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])
const ExportMap = Schema.Record(Schema.String, ExportTarget)
const Dependencies = Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
const Manifest = Schema.Struct({
  name: Schema.Literal("@knpkv/codecommit-web"),
  type: Schema.Literal("module"),
  exports: ExportMap,
  publishConfig: Schema.Struct({ exports: ExportMap }),
  dependencies: Dependencies,
  devDependencies: Dependencies,
  peerDependencies: Dependencies
})
const BuildResult = Schema.Struct({ phase: Schema.Literal("bundle"), errors: Schema.Array(Schema.String) })

const viewEntry = `
import {
  ReviewDifferentRevisionView, ReviewFindingCard, ReviewFindingsIndexView,
  ReviewReadAgainButton, ReviewRunFallbackView, ReviewSummaryView,
  ReviewThreadMessagesView, ReviewThreadsFallbackView, ReviewWorkspaceNotices,
  ReviewWorkspaceView, useCodeReviewReading, parseReviewDiffFile, reviewWorkspaceThreads,
  CodeReadStatusView, codeReadFailureMessage, reviewThreadElementId, ReviewDiffFileError, canRenderCodeText
} from "@knpkv/codecommit-web/views"
import type { ReviewWorkspaceViewProps } from "@knpkv/codecommit-web/views"
export type ConsumerProps = ReviewWorkspaceViewProps
export const runtimeViews = [
  ReviewDifferentRevisionView, ReviewFindingCard, ReviewFindingsIndexView,
  ReviewReadAgainButton, ReviewRunFallbackView, ReviewSummaryView,
  ReviewThreadMessagesView, ReviewThreadsFallbackView, ReviewWorkspaceNotices,
  ReviewWorkspaceView, useCodeReviewReading, parseReviewDiffFile, reviewWorkspaceThreads,
  CodeReadStatusView, codeReadFailureMessage, reviewThreadElementId, ReviewDiffFileError, canRenderCodeText
]
`
const hostEntry = `
import { CodeReviewResult, CodeReviewReading, CodeReviewPresentation, CodeReviewThreadTarget } from "@knpkv/codecommit-web/host"
import * as Schema from "effect/Schema"
const reading = Schema.decodeUnknownSync(CodeReviewResult)({ _tag: "Unavailable", reason: "not_configured", host: null })
const diff = { pullRequestId: "pull-1", revisionId: "revision-1", baseCommit: "base", headCommit: "head", readAt: 1, cacheUpdatedAt: 1, files: [] }
const workspace = {
  identity: { namespace: "codecommit", subjectId: "12345678-1234-4123-8123-123456789abc", revisionId: "revision-1", baseRevision: "base", headRevision: "head" },
  observedAt: 1, run: { _tag: "NotRecorded" }, conversations: { _tag: "Unavailable", reason: "not_cached" }, checks: { _tag: "Unknown" }
}
const current = Schema.decodeUnknownSync(CodeReviewReading)({ diff, workspace })
const ready = Schema.decodeUnknownSync(CodeReviewResult)({ _tag: "Ready", reading: current })
console.log(JSON.stringify({
  reading,
  ready: ready._tag,
  thread: Schema.decodeUnknownSync(CodeReviewThreadTarget)({ source: "codecommit", id: "thread-1" }),
  mismatchedRevisionAccepted: Schema.is(CodeReviewReading)({ diff: { ...diff, revisionId: "other" }, workspace }),
  presentation: Schema.decodeUnknownSync(CodeReviewPresentation)("review"),
  malformedAccepted: Schema.is(CodeReviewResult)({ _tag: "Ready", reading: {} }),
  unknownReasonAccepted: Schema.is(CodeReviewResult)({ _tag: "Unavailable", reason: "invented", host: null })
}))
`

// This child is a standalone bundler invocation, not Vitest's workspace resolver.
// Only dependency packages are external. The package under test must resolve and bundle normally.
const bundlerEntry = `
import { argv, stdout } from "node:process"
import { pathToFileURL } from "node:url"
const tool = await import(pathToFileURL(argv[2]).href)
try {
  await tool.build({
    entryPoints: [argv[3]], outfile: argv[4], absWorkingDir: argv[5],
    external: JSON.parse(argv[6]), platform: argv[7], format: "esm",
    bundle: true, logLevel: "silent", tsconfigRaw: { compilerOptions: {} }, loader: { ".css": "empty" }
  })
  stdout.write(JSON.stringify({ phase: "bundle", errors: [] }))
} catch (cause) {
  stdout.write(JSON.stringify({ phase: "bundle", errors: cause.errors.map((error) =>
    [error.text, ...error.notes.map((note) => note.text)].join("\\n")
  ) }))
  process.exitCode = 1
} finally { tool.stop() }
`

const runtimeTarget = (exports: typeof ExportMap.Type, entry: string): string => {
  const target = exports[entry]
  const runtime = Schema.is(Schema.String)(target) ? target : target?.default
  if (runtime === undefined || !runtime.startsWith("./dist/")) {
    throw new ExportConsumerFixtureError({ detail: `Missing built runtime export: ${entry}` })
  }
  return runtime
}

const run = Effect.fn("ExportConsumer.run")(function*(cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(ChildProcess.make("node", args, {
    cwd,
    env: { NODE_OPTIONS: "--max-old-space-size=512", NODE_PATH: "", ESBUILD_BINARY_PATH: "" },
    extendEnv: true
  }))
  return yield* Effect.all({
    code: child.exitCode,
    stdout: Stream.mkString(Stream.decodeText(child.stdout)),
    stderr: Stream.mkString(Stream.decodeText(child.stderr))
  }, { concurrency: "unbounded" })
})

/** Find the latest build-input edit so an older build cannot count as consumer evidence. */
const newestInput = Effect.fn("ExportConsumer.newestInput")(function*(directory: string): Effect.fn.Return<
  number,
  ExportConsumerFixtureError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const own = yield* fs.stat(directory)
  if (Option.isNone(own.mtime)) return yield* new ExportConsumerFixtureError({ detail: `Missing mtime: ${directory}` })
  let newest = own.mtime.value.getTime()
  if (own.type === "Directory") {
    for (const name of yield* fs.readDirectory(directory)) {
      newest = Math.max(newest, yield* newestInput(path.join(directory, name)))
    }
  }
  return newest
})

/** Reject old output before it can be copied into a successful consumer fixture. */
const readBuiltTargets = Effect.fn("ExportConsumer.readBuiltTargets")(function*(
  packageDir: string,
  targets: ReadonlySet<string>,
  minimum: number
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const snapshots = new Map<string, string>()
  for (const target of targets) {
    const file = path.join(packageDir, target)
    const info = yield* fs.stat(file)
    if (Option.isNone(info.mtime) || info.mtime.value.getTime() < minimum) {
      return yield* new ExportConsumerFixtureError({ detail: `Stale build target: ${target}` })
    }
    snapshots.set(target, yield* fs.readFileString(file))
  }
  return snapshots
})

const fixture = Effect.fn("ExportConsumer.fixture")(function*(published: boolean) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const ownPackage = path.resolve(import.meta.dirname, "..")
  const packageDir = yield* Config.String("CODE_REVIEW_EXPORT_PACKAGE_DIR").pipe(Config.withDefault(ownPackage))
  const barrier = yield* Config.Finite("CODE_REVIEW_EXPORT_BUILD_STARTED_AT").pipe(Config.withDefault(0))
  const manifestText = yield* fs.readFileString(path.join(packageDir, "package.json"))
  const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(manifestText)
  const exports = published ? manifest.publishConfig.exports : manifest.exports
  const views = runtimeTarget(exports, "./views")
  const host = runtimeTarget(exports, "./host")
  let minimum = barrier
  for (
    const input of [
      "src",
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "vite.views.config.ts",
      "scripts/build-host-assets.mjs"
    ]
  ) {
    minimum = Math.max(minimum, yield* newestInput(path.join(packageDir, input)))
  }
  const targets = new Set([views, host])
  for (const target of Object.values(manifest.publishConfig.exports)) {
    if (!Schema.is(Schema.String)(target) && target.types !== undefined && target.types.startsWith("./dist/")) {
      targets.add(target.types)
    }
  }
  const snapshots = yield* readBuiltTargets(packageDir, targets, minimum)

  // Cleanup is registered by the scoped constructor before copying or decoding any fixture identity.
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "review-export-consumer-" })
  const installed = path.join(root, "node_modules", "@knpkv", "codecommit-web")
  yield* fs.makeDirectory(installed, { recursive: true })
  yield* fs.copy(path.join(packageDir, "dist"), path.join(installed, "dist"), { preserveTimestamps: true })
  const fixtureManifest = { name: manifest.name, type: manifest.type, exports }
  yield* fs.writeFileString(path.join(installed, "package.json"), JSON.stringify(fixtureManifest))
  // A changed build during the copy is a setup failure, never negative-test evidence.
  for (const [target, content] of snapshots) {
    expect(yield* fs.readFileString(path.join(packageDir, target))).toBe(content)
    expect(yield* fs.readFileString(path.join(installed, target))).toBe(content)
  }
  expect(yield* fs.readFileString(path.join(packageDir, "package.json"))).toBe(manifestText)
  const dependencies = [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {})
    ])
  ]
  for (const name of dependencies) {
    const destination = path.join(root, "node_modules", name)
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true })
    yield* fs.symlink(path.join(packageDir, "node_modules", name), destination)
  }
  const tool = yield* Effect.try({
    try: () => createRequire(import.meta.resolve("tsx/package.json")).resolve("esbuild"),
    catch: () => new ExportConsumerFixtureError({ detail: "Installed esbuild is unavailable" })
  })
  const bundler = path.join(root, "bundle.mjs")
  yield* fs.writeFileString(bundler, bundlerEntry)
  const bundle = Effect.fn("ExportConsumer.bundle")(function*(entry: string, platform: "browser" | "node") {
    const input = path.join(root, `${platform}.ts`)
    const output = path.join(root, `${platform}.mjs`)
    yield* fs.writeFileString(input, entry)
    const result = yield* run(root, [bundler, tool, input, output, root, JSON.stringify(dependencies), platform])
    expect(result.stderr).toBe("")
    const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BuildResult))(result.stdout)
    return { ...body, code: result.code, output }
  })
  const verify = Effect.fn("ExportConsumer.verify")(function*() {
    const browser = yield* bundle(viewEntry, "browser")
    expect(browser).toMatchObject({ code: 0, errors: [] })
    const node = yield* bundle(hostEntry, "node")
    expect(node).toMatchObject({ code: 0, errors: [] })
    const actual = yield* run(root, [node.output])
    expect(actual.code, actual.stderr).toBe(0)
    expect(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(actual.stdout)).toEqual({
      reading: { _tag: "Unavailable", reason: "not_configured", host: null },
      ready: "Ready",
      thread: { source: "codecommit", id: "thread-1" },
      mismatchedRevisionAccepted: false,
      presentation: "review",
      malformedAccepted: false,
      unknownReasonAccepted: false
    })
  })
  return { root, installed, fixtureManifest, views, host, minimum, bundle, verify }
})

layer(NodeServices.layer, { excludeTestServices: true })("review package-name consumers", (it) => {
  it.effect("rejects a stale artifact even when the package-name consumer could load it", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const consumer = yield* fixture(true)
      yield* consumer.verify()
      yield* fs.utimes(path.join(consumer.installed, consumer.host), 0, 0)
      const failure = yield* readBuiltTargets(consumer.installed, new Set([consumer.host]), consumer.minimum).pipe(
        Effect.flip
      )
      expect(failure).toMatchObject({
        _tag: "ExportConsumerFixtureError",
        detail: `Stale build target: ${consumer.host}`
      })
    }).pipe(Effect.scoped), 30_000)

  for (const published of [false, true]) {
    const condition = published ? "published" : "workspace"
    it.effect(`${condition}: bundles real views and decodes the host contract`, () =>
      Effect.gen(function*() {
        const consumer = yield* fixture(published)
        yield* consumer.verify()
      }).pipe(Effect.scoped), 30_000)

    it.effect(
      `${condition}: missing runtime entry fails, while type-only imports are erased`,
      () =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const consumer = yield* fixture(published)
          yield* consumer.verify()
          const { ["./host"]: _host, ["./views"]: _views, ...withoutViews } = consumer.fixtureManifest.exports
          yield* fs.writeFileString(
            path.join(consumer.installed, "package.json"),
            JSON.stringify({
              ...consumer.fixtureManifest,
              exports: withoutViews
            })
          )
          const missing = yield* consumer.bundle(viewEntry, "browser")
          expect(missing.code).toBe(1)
          expect(missing.errors.join("\n")).toContain("not exported")
          yield* Effect.logInfo("ExportConsumerCounterfactual", {
            condition,
            kind: "missing-entry",
            errors: missing.errors
          })
          const missingHost = yield* consumer.bundle(hostEntry, "node")
          expect(missingHost.code).toBe(1)
          expect(missingHost.errors.join("\n")).toContain("not exported")
          yield* Effect.logInfo("ExportConsumerCounterfactual", {
            condition,
            kind: "missing-host-entry",
            errors: missingHost.errors
          })
          const erased = yield* consumer.bundle(
            `import type { ReviewWorkspaceViewProps } from "@knpkv/codecommit-web/views"; export const erased = true`,
            "browser"
          )
          expect(erased).toMatchObject({ code: 0, errors: [] })
        }).pipe(Effect.scoped),
      30_000
    )

    it.effect(
      `${condition}: an erased host target cannot hide behind a valid view bundle`,
      () =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const consumer = yield* fixture(published)
          yield* consumer.verify()
          yield* fs.remove(path.join(consumer.installed, consumer.host))
          expect(yield* consumer.bundle(viewEntry, "browser")).toMatchObject({ code: 0, errors: [] })
          const erased = yield* consumer.bundle(hostEntry, "node")
          expect(erased.code).toBe(1)
          expect(erased.errors.join("\n")).toContain("was not found")
          yield* Effect.logInfo("ExportConsumerCounterfactual", {
            condition,
            kind: "erased-host-target",
            errors: erased.errors
          })
        }).pipe(Effect.scoped),
      30_000
    )

    it.effect(`${condition}: a missing runtime view name fails the real consumer`, () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const consumer = yield* fixture(published)
        yield* consumer.verify()
        const file = path.join(consumer.installed, consumer.views)
        const original = yield* fs.readFileString(file)
        const changed = original.replace(/\bas ReviewWorkspaceView\b/, "as RemovedReviewWorkspaceView")
        expect(changed).not.toBe(original)
        yield* fs.writeFileString(file, changed)
        const missing = yield* consumer.bundle(viewEntry, "browser")
        expect(missing.code).toBe(1)
        expect(missing.errors.join("\n")).toContain("for import \"ReviewWorkspaceView\"")
        yield* Effect.logInfo("ExportConsumerCounterfactual", {
          condition,
          kind: "missing-name",
          errors: missing.errors
        })
      }).pipe(Effect.scoped), 30_000)
  }
})
