import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

class PackageConsumerError extends Schema.TaggedError<PackageConsumerError>()("PackageConsumerError", {
  detail: Schema.String
}) {}

const ConsumerVersions = Schema.Struct({
  dependencies: Schema.Struct({ effect: Schema.String })
})

const InstalledVersion = Schema.Struct({ version: Schema.String })

/** Run the real package manager and Node resolver outside the workspace and Vitest aliases. */
const run = Effect.fn("ReviewConsumer.run")(function*(cwd: string, command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(ChildProcess.make(command, args, {
    cwd,
    env: {
      NODE_OPTIONS: "--max-old-space-size=512",
      NODE_PATH: "",
      npm_config_ignore_scripts: "true",
      npm_config_offline: "true",
      npm_config_verify_deps_before_run: "false",
      pnpm_config_verify_deps_before_run: "false"
    },
    extendEnv: true
  }))
  const result = yield* Effect.all({
    code: child.exitCode,
    stdout: Stream.mkString(Stream.decodeText(child.stdout)),
    stderr: Stream.mkString(Stream.decodeText(child.stderr))
  }, { concurrency: "unbounded" })
  if (result.code !== 0) {
    return yield* new PackageConsumerError({
      detail: `${command} ${args.join(" ")} exited ${result.code}\n${result.stdout}\n${result.stderr}`
    })
  }
  return result.stdout
})

/** Pack current built bytes; optional UI peers must not be silently supplied by workspace links. */
const consumer = Effect.fn("ReviewConsumer.install")(function*(ui: boolean) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageRoot = path.resolve(import.meta.dirname, "..")
  const versions = yield* fs.readFileString(path.join(packageRoot, "package.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ConsumerVersions)))
  )
  // Offline installs resolve peer ranges against registry metadata, which can name a release the
  // store lacks. Pin React to the workspace's locked install so every consumer stays offline.
  const installed = Effect.fn("ReviewConsumer.installedVersion")(function*(name: string) {
    const manifest = yield* fs.readFileString(path.join(packageRoot, "node_modules", name, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(InstalledVersion)))
    )
    return manifest.version
  })
  const react = yield* installed("react")
  const reactDom = yield* installed("react-dom")
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "review-peer-consumer-" })
  const archives = new Map<string, string>()
  for (const name of ["review", "rly"]) {
    const destination = path.join(temporary, "archives", name)
    yield* fs.makeDirectory(destination, { recursive: true })
    yield* run(path.resolve(packageRoot, "..", name), "pnpm", [
      "--config.ignore-scripts=true",
      "pack",
      "--pack-destination",
      destination
    ])
    const files = yield* fs.readDirectory(destination)
    const tarball = files[0]
    if (files.length !== 1 || tarball === undefined || !tarball.endsWith(".tgz")) {
      return yield* new PackageConsumerError({ detail: `Expected one packed ${name} archive` })
    }
    archives.set(name, `file:${path.join(destination, tarball)}`)
  }
  const directory = path.join(temporary, "consumer")
  yield* fs.makeDirectory(directory)
  const headlessDependencies = {
    "@knpkv/review": archives.get("review"),
    effect: versions.dependencies.effect
  }
  const dependencies = ui
    ? {
      ...headlessDependencies,
      "@knpkv/rly": archives.get("rly"),
      react,
      "react-dom": reactDom
    }
    : headlessDependencies
  yield* fs.writeFileString(
    path.join(directory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies
    })
  )
  // Pin an explicitly installed UI peer to these same built bytes. An optional peer is not
  // installed just because an override exists; the old hard dependency does install it.
  yield* fs.writeFileString(
    path.join(directory, "pnpm-workspace.yaml"),
    `overrides:\n  "@knpkv/rly": "${archives.get("rly")}"\n  react: "${react}"\n  react-dom: "${reactDom}"\n`
  )
  const store = (yield* run(packageRoot, "pnpm", ["store", "path"])).trim()
  yield* run(directory, "pnpm", [
    "install",
    "--offline",
    "--prod",
    "--ignore-scripts",
    "--no-frozen-lockfile",
    "--store-dir",
    store
  ])
  return directory
})

layer(NodeServices.layer, { excludeTestServices: true })("packed review consumers", (it) => {
  it.effect("installs and decodes headless contracts without installing Rly", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* consumer(false)
      yield* run(directory, "node", [
        "--input-type=module",
        "--eval",
        `
        import assert from "node:assert/strict"
        import { ReviewSeverity, ReviewWorkspace } from "@knpkv/review"
        import * as Schema from "effect/Schema"
        assert.equal(Schema.decodeUnknownSync(ReviewSeverity)("P1"), "P1")
        assert.equal(Schema.is(ReviewWorkspace)({}), false)
      `
      ])
      expect(yield* fs.exists(path.join(directory, "node_modules/@knpkv/rly"))).toBe(false)
      const installed = yield* fs.readDirectory(path.join(directory, "node_modules/.pnpm"))
      expect(installed.some((name) => name.startsWith("@knpkv+rly@"))).toBe(false)
    }), { timeout: 60_000 })

  it.effect(
    "renders React controls and exports a guide when the UI consumer installs Rly",
    () =>
      Effect.gen(function*() {
        const directory = yield* consumer(true)
        yield* run(directory, "node", [
          "--input-type=module",
          "--eval",
          `
        import assert from "node:assert/strict"
        import { createElement } from "react"
        import { renderToStaticMarkup } from "react-dom/server"
        import { ReviewProfileControl } from "@knpkv/review/react"
        import { exportGuide } from "@knpkv/review/guide/export"
        import { Effect } from "effect"
        const control = renderToStaticMarkup(createElement(ReviewProfileControl, {
          profiles: [], selectedProfileId: null, onProfileChange() {}
        }))
        assert.match(control, /Select a profile/)
        const page = await Effect.runPromise(exportGuide({
          guide: {
            title: "Package consumer", intent: "Read the recorded change.",
            sections: [{ title: "Change", overview: "One change.", diffs: [{ file: "a.ts", summary: "Update." }] }],
            unplacedFiles: [], review: { gitRef: "head" }
          },
          patch: "diff --git a/a.ts b/a.ts\\n--- a/a.ts\\n+++ b/a.ts\\n@@ -1 +1 @@\\n-before\\n+after\\n"
        }))
        assert.equal(page.files, 1)
        assert.match(page.html, /data-rly-patch-diff/)
      `
        ])
      }),
    { timeout: 60_000 }
  )
})
