/**
 * The published `codecommit` executable starts with Node alone.
 *
 * Every workspace package in the production closure is packed with `pnpm pack` (so `files` and
 * `publishConfig` apply as on npm) and installed into an empty consumer with `pnpm install`, each
 * `@knpkv` dependency overridden to its tarball. The installed bin then runs with a PATH that holds
 * `node` and the few POSIX tools pnpm's bin shim needs, but no Bun: `--help`, one read command
 * against a loopback CodeCommit stand-in, and the TUI, which must say in one line that it needs Bun.
 *
 * The install is also held to a budget: no provider SDK, bundler or Pi package may reach a user's
 * install (Relay bundles what it uses from Pi), and the installed tree stays under a size ceiling.
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

const tuiNeedsBun = "codecommit: the terminal UI needs Bun. Install it from https://bun.sh and run codecommit again, " +
  "or run `codecommit web` for the browser UI."

/** Installed package directories (pnpm's `.pnpm/<name>@<version>`) that must never ship with codecommit. */
const forbiddenInstalls = [
  "@anthropic-ai+sdk@",
  "openai@",
  "@google+genai@",
  "@aws-sdk+client-bedrock-runtime@",
  "esbuild@",
  "@esbuild+",
  "@earendil-works+"
]

/** Installed size ceiling in KiB: 700_000 measured with Relay mounted (2026-10-07), plus 5%. Raise it on purpose, never to pass. */
const installBudgetKiB = 735_000

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

    const installed = yield* fs.readDirectory(path.join(consumer, "node_modules", ".pnpm")).pipe(
      Effect.mapError(() => new PackedCliError({ message: "The install has no node_modules/.pnpm" }))
    )
    const forbidden = installed.filter((entry) => forbiddenInstalls.some((prefix) => entry.startsWith(prefix)))
    if (forbidden.length > 0) {
      return yield* new PackedCliError({ message: `The install ships forbidden packages: ${forbidden.join(", ")}` })
    }
    // `du` counts each file once and does not follow pnpm's symlinks.
    const sizeKiB = Number(
      (yield* spawner.string(ChildProcess.make("du", ["-sk", "node_modules"], { cwd: consumer })).pipe(
        Effect.mapError(() => new PackedCliError({ message: "Could not measure the install" }))
      )).split("\t", 1)[0]
    )
    yield* Console.log(`codecommit installs ${installed.length} packages, ${sizeKiB} KiB`)
    if (!(sizeKiB > 0 && sizeKiB <= installBudgetKiB)) {
      return yield* new PackedCliError({
        message: `The install is ${sizeKiB} KiB, over its ${installBudgetKiB} KiB budget`
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
