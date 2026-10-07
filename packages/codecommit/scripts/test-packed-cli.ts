/**
 * The published `codecommit` executable starts with Node alone.
 *
 * Every workspace package in the production closure is packed with `pnpm pack` (so `files` and
 * `publishConfig` apply as on npm) and installed into an empty consumer with `pnpm install`, each
 * `@knpkv` dependency overridden to its tarball. The installed bin then runs with a PATH that holds
 * `node` and the few POSIX tools pnpm's bin shim needs, but no Bun: `--help`, one read command
 * against a loopback CodeCommit stand-in, and the TUI, which must say in one line that it needs Bun.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Console, Effect, FileSystem, Path, Predicate, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { createServer } from "node:http"

class PackedCliError extends Schema.TaggedError<PackedCliError>()("PackedCliError", {
  message: Schema.String
}) {}

const Manifest = Schema.fromJsonString(Schema.Struct({
  name: Schema.String,
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String))
}))

/**
 * The production install's budget: 82 packages and 398,512 KiB measured once codecommit-web's client
 * libraries and build tooling became devDependencies, plus about 10%. Raise it in review, for a
 * dependency the CLI runs.
 */
const maxPackages = 90
const maxKib = 440_000

/**
 * Packages a user never runs: build and test tooling (the web client ships prebuilt), and the model
 * SDKs that Relay bundles what it needs from. A `@scope/*` entry covers the whole scope. `typescript`
 * is absent on purpose: @opentui/core's bun-ffi-structs requires it as a peer, so every install gets it.
 */
const neverInstalled = [
  "vite",
  "rollup",
  "esbuild",
  "@esbuild/*",
  "lightningcss",
  "tailwindcss",
  "@tailwindcss/*",
  "@vitejs/plugin-react",
  "vitest",
  "@playwright/test",
  "playwright",
  "@anthropic-ai/sdk",
  "openai",
  "@google/genai",
  "@aws-sdk/client-bedrock-runtime",
  "@earendil-works/*"
]
const isNeverInstalled = (name: string) =>
  neverInstalled.some((denied) => denied.endsWith("/*") ? name.startsWith(denied.slice(0, -1)) : name === denied)

/** `@scope+name@1.2.3_peer@4` in node_modules/.pnpm is `@scope/name`. */
const pnpmEntryName = (entry: string): string => {
  const version = entry.indexOf("@", 1)
  return (version === -1 ? entry : entry.slice(0, version)).replace("+", "/")
}

const tuiNeedsBun = "codecommit: the terminal UI needs Bun. Install it from https://bun.sh and run codecommit again, " +
  "or run `codecommit web` for the browser UI."

/** A CodeCommit stand-in on a loopback port that knows no repositories and no pull requests. */
const standIn = Effect.acquireRelease(
  Effect.callback<{ readonly port: number; readonly close: () => void }, PackedCliError>((resume) => {
    const server = createServer((request, response) => {
      const target = String(request.headers["x-amz-target"] ?? "")
      response.setHeader("content-type", "application/x-amz-json-1.1")
      response.end(target.endsWith("ListPullRequests") ? "{\"pullRequestIds\":[]}" : "{\"repositories\":[]}")
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || Predicate.isString(address)) {
        resume(Effect.fail(new PackedCliError({ message: "The stand-in has no port" })))
        return
      }
      resume(Effect.succeed({ port: address.port, close: () => server.close() }))
    })
  }),
  (server) => Effect.sync(server.close)
)

const program = Effect.scoped(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
    const workspaceRoot = path.resolve(packageRoot, "../..")
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "codecommit-packed-" })

    const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
      spawner.exitCode(ChildProcess.make(command, args, { cwd, stdout: "inherit", stderr: "inherit" })).pipe(
        Effect.mapError(() => new PackedCliError({ message: `${command} could not run` })),
        Effect.flatMap((code) =>
          code === ChildProcessSpawner.ExitCode(0)
            ? Effect.void
            : Effect.fail(new PackedCliError({ message: `${command} ${args.join(" ")} exited ${code}` }))
        )
      )

    // Pack codecommit and every workspace package its production dependencies reach.
    const archives = path.join(temporary, "archives")
    yield* fs.makeDirectory(archives)
    const tarballs = new Map<string, string>()
    const pending = [packageRoot]
    for (let root = pending.pop(); root !== undefined; root = pending.pop()) {
      const manifest = yield* fs.readFileString(path.join(root, "package.json")).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Manifest)),
        Effect.mapError(() => new PackedCliError({ message: `Could not read the manifest in ${root}` }))
      )
      if (tarballs.has(manifest.name)) continue
      const before = new Set(yield* fs.readDirectory(archives))
      yield* run("pnpm", ["pack", "--pack-destination", archives], root)
      const packed = (yield* fs.readDirectory(archives)).find((file) => !before.has(file))
      if (packed === undefined) return yield* new PackedCliError({ message: `pnpm pack wrote nothing for ${root}` })
      tarballs.set(manifest.name, path.join(archives, packed))
      for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
        if (range.startsWith("workspace:")) {
          pending.push(yield* fs.realPath(path.join(root, "node_modules", dependency)))
        }
      }
    }

    // An empty consumer: the tarball as the only dependency, every @knpkv package overridden to its tarball.
    const consumer = path.join(temporary, "consumer")
    yield* fs.makeDirectory(consumer)
    yield* fs.writeFileString(
      path.join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: { "@knpkv/codecommit": `file:${tarballs.get("@knpkv/codecommit")}` }
      })
    )
    yield* fs.writeFileString(
      path.join(consumer, "pnpm-workspace.yaml"),
      `overrides:\n${[...tarballs].map(([name, file]) => `  "${name}": "file:${file}"`).join("\n")}\n`
    )
    // The workspace's store holds every third-party package; the registry is only a fallback.
    const store = (yield* spawner.string(ChildProcess.make("pnpm", ["store", "path"], { cwd: workspaceRoot })).pipe(
      Effect.mapError(() => new PackedCliError({ message: "Could not find the pnpm store" }))
    )).trim()
    yield* run("pnpm", ["install", "--prefer-offline", "--prod", "--store-dir", store], consumer)

    // What a user downloads: nothing on the never-installed list, and a size within the budget.
    const installed = path.join(consumer, "node_modules")
    const packages = (yield* fs.readDirectory(path.join(installed, ".pnpm")))
      .filter((entry) => entry !== "node_modules" && entry !== "lock.yaml")
      .map(pnpmEntryName)
    // Two `du` runs: one counts a file once across all its operands, so the total needs its own.
    const du = (script: string) =>
      spawner.string(ChildProcess.make("sh", ["-c", script], { cwd: installed })).pipe(
        Effect.mapError(() => new PackedCliError({ message: "Could not measure the install" })),
        Effect.map((output) =>
          output.trim().split("\n").map((line) => {
            const [size = "0", entry = ""] = line.split("\t")
            return { kib: Number(size), name: pnpmEntryName(entry.replace(/^\.pnpm\/|\/$/gu, "")) }
          })
        )
      )
    const kib = (yield* du("du -sk ."))[0]?.kib
    if (kib === undefined || !Number.isFinite(kib)) {
      return yield* new PackedCliError({ message: "du printed no total for the install" })
    }
    const largest = (yield* du("du -sk .pnpm/*/ | sort -rn | head -n 10"))
      .map(({ kib, name }) => `  ${String(kib).padStart(7)} KiB  ${name}`)
    yield* Console.log(`codecommit installs ${packages.length} packages, ${kib} KiB. Largest:\n${largest.join("\n")}`)
    const unwanted = [...new Set(packages.filter(isNeverInstalled))]
    if (unwanted.length > 0) {
      return yield* new PackedCliError({
        message: `The install pulls in ${unwanted.join(", ")}, which a user never runs. Make it a devDependency.`
      })
    }
    if (packages.length > maxPackages || kib > maxKib) {
      return yield* new PackedCliError({
        message: `The install is ${packages.length} packages, ${kib} KiB: over the budget of ${maxPackages} ` +
          `packages, ${maxKib} KiB. Move what the CLI never runs to devDependencies, or raise the budget in review.`
      })
    }

    // A PATH with node and what pnpm's sh shim needs, and no Bun.
    const onlyNode = path.join(temporary, "bin")
    yield* fs.makeDirectory(onlyNode)
    const node = yield* spawner.string(ChildProcess.make("sh", ["-c", "command -v node"])).pipe(
      Effect.mapError(() => new PackedCliError({ message: "node is not on PATH" }))
    )
    yield* fs.symlink(node.trim(), path.join(onlyNode, "node"))
    for (const tool of ["dirname", "sed", "uname"]) {
      const found = yield* spawner.string(ChildProcess.make("sh", ["-c", `command -v ${tool}`])).pipe(
        Effect.mapError(() => new PackedCliError({ message: `${tool} is not on PATH` }))
      )
      yield* fs.symlink(found.trim(), path.join(onlyNode, tool))
    }
    const home = path.join(temporary, "home")
    yield* fs.makeDirectory(home)
    const server = yield* standIn

    const binary = path.join(consumer, "node_modules", "@knpkv", "codecommit", "dist", "src", "bin.js")
    const shebang = (yield* fs.readFileString(binary)).split("\n", 1)[0]
    if (shebang !== "#!/usr/bin/env node") {
      return yield* new PackedCliError({ message: `The published shebang is ${shebang}, not node` })
    }

    /** Run the installed bin link the way a user does, with only node reachable. */
    const codecommit = (args: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        const handle = yield* spawner.spawn(
          ChildProcess.make(path.join(consumer, "node_modules", ".bin", "codecommit"), args, {
            env: {
              PATH: onlyNode,
              HOME: home,
              CODECOMMIT_MOCK_ENDPOINT: `http://127.0.0.1:${server.port}`
            },
            extendEnv: false
          })
        )
        const [stdout, stderr, code] = yield* Effect.all([
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode
        ], { concurrency: "unbounded" })
        return { code: Number(code), stdout, stderr }
      }).pipe(
        Effect.scoped,
        Effect.mapError(() => new PackedCliError({ message: `codecommit ${args.join(" ")} could not run` }))
      )
    const expect = (ok: boolean, message: string, result: { readonly stdout: string; readonly stderr: string }) =>
      ok ? Effect.void : Effect.fail(new PackedCliError({ message: `${message}\n${result.stdout}\n${result.stderr}` }))

    const help = yield* codecommit(["--help"])
    yield* expect(
      help.code === 0 && help.stdout.includes("codecommit <subcommand> [flags]") &&
        help.stdout.includes("Serve the browser UI on this machine and open it"),
      "--help",
      help
    )
    const list = yield* codecommit(["pr", "list", "--repo", "payments-api", "--json", "--region", "eu-west-1"])
    yield* expect(list.code === 0 && list.stdout.trim() === "[]", "pr list", list)
    const tui = yield* codecommit(["tui"])
    yield* expect(tui.code === 1 && tui.stderr.trim() === tuiNeedsBun, "tui without Bun", tui)
    yield* Console.log("codecommit runs with Node only: --help, pr list, and the TUI's one-line Bun message")
  })
)

// The script is its own entry point: it owns the Node platform layer.
NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
