import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { McpSchema } from "effect/ai"
import { build } from "esbuild"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { relayVersion } from "../src/internal/relay-version.js"

/** Match the hub's CLI bundle fixtures, with no inherited configuration or credentials. */
const runRelay = (
  entry: string,
  cwd: string,
  args: ReadonlyArray<string>,
  initialization?: string
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env: { HOME: cwd, XDG_CONFIG_HOME: cwd, XDG_DATA_HOME: cwd },
      timeout: 10_000
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk
      if (initialization !== undefined && stdout.includes("\n")) child.kill()
    })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, stdout, stderr }))
    if (initialization === undefined) child.stdin.end()
    else child.stdin.write(initialization)
  })

it.layer(NodeServices.layer)((it) => {
  it.effect("uses the released package version for CLI and MCP startup", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const manifestPath = yield* paths.fromFileUrl(new URL("../package.json", import.meta.url))
      const manifest = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString }))
      )(yield* fs.readFileString(manifestPath))
      expect(relayVersion).toBe(manifest.version)
    }))

  it.effect(
    "runs version, help and MCP initialization from a relocated standalone Relay bundle",
    () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "relay-bundle-" })
        const built = join(root, "build", "relay.mjs")
        yield* Effect.promise(() =>
          build({
            bundle: true,
            entryPoints: [join(import.meta.dirname, "../src/relay.ts")],
            format: "esm",
            outfile: built,
            platform: "node",
            banner: {
              js: "import { createRequire } from \"node:module\"; const require = createRequire(import.meta.url);"
            }
          })
        )
        const relocated = join(root, "empty")
        yield* fs.makeDirectory(relocated)
        const entry = join(relocated, "relay.mjs")
        yield* fs.copyFile(built, entry)
        expect(yield* fs.readDirectory(relocated)).toEqual(["relay.mjs"])
        const manifest = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString }))
        )(yield* fs.readFileString(join(import.meta.dirname, "../package.json")))
        const version = yield* Effect.promise(() => runRelay(entry, relocated, ["--version"]))
        expect(version.code, JSON.stringify(version)).toBe(0)
        expect(version.stdout.trim()).toBe(`relay v${manifest.version}`)
        const help = yield* Effect.promise(() => runRelay(entry, relocated, ["--help"]))
        expect(help.code, help.stderr).toBe(0)
        expect(help.stdout).toContain("relay")
        expect(help.stdout).toContain("mcp")
        expect(help.stdout).toContain("me")
        const initialization = `${
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "bundle-test-client", version: "1.0.0" }
            }
          })
        }\n`
        const mcp = yield* Effect.promise(() => runRelay(entry, relocated, ["mcp"], initialization))
        expect(mcp.stdout, mcp.stderr).not.toBe("")
        const response = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
          jsonrpc: Schema.Literal("2.0"),
          id: Schema.Literal(1),
          result: McpSchema.InitializeResult
        })))(mcp.stdout)
        expect(response.result.protocolVersion).toBe("2025-06-18")
        expect(response.result.serverInfo).toEqual({ name: "relay", version: manifest.version })
      }),
    30_000
  )
})
