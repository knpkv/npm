/**
 * `--attach`: the hub's handshake on stdin, the per-spawn secret checked before anything else, the token held in
 * memory, and the end of stdin as the stop signal.
 */
import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { Cause } from "effect"
import { Effect, Fiber, FileSystem, Layer, Queue, Result, Schedule, Schema, Stdio, Stream } from "effect"
import { TestClock } from "effect/testing"
import { createServer, request as httpRequest, type Server } from "node:http"
import { tmpdir } from "node:os"
import { readHandshake } from "../src/handshake.js"
import { ShellServices } from "../src/hub-client.js"
import { AppId, type AppManifestInput, AppStartError } from "../src/manifest.js"
import { readRunMode, serveAttached } from "../src/node.js"
import { ModuleHandlers, moduleReadRoute } from "../src/route.js"
import { hubHeaders } from "../src/wire.js"

const manifest: AppManifestInput = {
  contract: 1,
  id: Schema.decodeSync(AppId)("probe"),
  package: "@knpkv/probe",
  version: "1.0.0",
  module: {
    id: "probe",
    label: "Probe",
    defaultPage: "overview",
    pages: [{ id: "overview", label: "Overview" }],
    listeners: ["local"],
    requires: ["read"]
  },
  services: ["host"],
  nav: { order: 1, primary: true, mobile: false },
  standalone: { defaultPort: 3199 }
}

const Empty = Schema.fromURLSearchParams(Schema.Struct({}))
const handlers = Layer.effect(
  ModuleHandlers,
  Effect.gen(function*() {
    const shell = yield* ShellServices
    return {
      routes: [
        moduleReadRoute("/host", Empty, Schema.String, () =>
          shell.host.pipe(
            Effect.map((host) => host.host),
            Effect.orDie
          ))
      ]
    }
  })
)

const encoder = new TextEncoder()
const handshakeFor = (endpoint: string, hubUrl: string) => ({
  v: 1,
  endpoint,
  hubUrl,
  hubToken: "spawn-token",
  appSecret: "0123456789abcdef0123456789abcdef"
})
const line = (handshake: ReturnType<typeof handshakeFor>) => encoder.encode(`${JSON.stringify(handshake)}\n`)

/** One request over the app's endpoint. */
const onEndpoint = (endpoint: string, path: string, headers: Record<string, string>) =>
  Effect.callback<{ readonly status: number; readonly body: string }, Error>((resume) => {
    const outgoing = httpRequest({ socketPath: endpoint, path, method: "GET", headers }, (incoming) => {
      const chunks: Array<Buffer> = []
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
      incoming.on(
        "end",
        () => resume(Effect.succeed({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
      )
    })
    outgoing.on("error", (error) => resume(Effect.fail(error)))
    outgoing.end()
  })

const isHandshakeError = (result: Result.Result<unknown, AppStartError>) =>
  Result.isFailure(result) && result.failure.reason === "handshake"

describe("readRunMode --attach", () => {
  it("is attached with --attach alone; the rest arrives on stdin", () => {
    expect(readRunMode(manifest, ["--attach"], {})).toEqual(Result.succeed({ _tag: "Attached" }))
  })

  it("refuses --attach together with --socket", () => {
    const mode = readRunMode(manifest, ["--attach", "--socket", "/run/probe.sock"], {})
    expect(Result.isFailure(mode) && mode.failure).toBeInstanceOf(AppStartError)
  })
})

describe("readHandshake", () => {
  it.effect("reads line 1, then completes `closed` when stdin ends", () =>
    Effect.gen(function*() {
      const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>()
      const reading = yield* readHandshake(Stream.fromQueue(stdin))
      yield* Queue.offer(stdin, line(handshakeFor("/run/probe.sock", "http://127.0.0.1:3111")))
      expect((yield* reading.handshake).endpoint).toBe("/run/probe.sock")
      // Bytes after line 1 are dropped; only the end of stdin stops the app.
      yield* Queue.offer(stdin, encoder.encode("ignored\n"))
      const closed = yield* Effect.forkChild(reading.closed)
      yield* Queue.end(stdin)
      yield* Fiber.join(closed)
    }).pipe(Effect.scoped))

  // Started by hand with no hub: it says so instead of waiting forever.
  it.effect("fails after 5 seconds without a line", () =>
    Effect.gen(function*() {
      const reading = yield* readHandshake(Stream.never)
      const handshake = yield* Effect.forkChild(Effect.result(reading.handshake))
      yield* TestClock.adjust("5 seconds")
      expect(isHandshakeError(yield* Fiber.join(handshake))).toBe(true)
    }).pipe(Effect.scoped))

  it.effect("fails on a line over 4 KiB, on stdin closing first, and on a line that isn't a handshake", () =>
    Effect.gen(function*() {
      for (
        const stdin of [
          Stream.make(new Uint8Array(4_097).fill(97)).pipe(Stream.concat(Stream.never)),
          Stream.empty,
          Stream.make(encoder.encode("{\"v\":1}\n"))
        ]
      ) {
        const reading = yield* readHandshake(stdin)
        expect(isHandshakeError(yield* Effect.result(reading.handshake))).toBe(true)
      }
    }).pipe(Effect.scoped))
})

describe("attached app", () => {
  it.layer(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp), { excludeTestServices: true })((it) => {
    it.effect("answers only with the secret, calls the hub with the handshake's token, and stops when stdin ends", () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "hub-attach-" })
        const clientDirectory = `${directory}/client`
        yield* fileSystem.makeDirectory(clientDirectory)
        yield* fileSystem.writeFileString(`${clientDirectory}/client.js`, "export default {}\n")

        // A stand-in hub: answers `host` and records the token the app sent.
        const authorizations: Array<string | undefined> = []
        const hub = yield* Effect.acquireRelease(
          Effect.callback<Server>((resume) => {
            const server = createServer((request, response) => {
              authorizations.push(request.headers.authorization)
              response.writeHead(200, { "content-type": "application/json" })
              response.end(JSON.stringify({ host: "atlas", isHub: true, hosts: ["atlas"] }))
            })
            server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
          }),
          (server) =>
            Effect.callback<void>((resume) => {
              server.close(() => resume(Effect.void))
            })
        )
        const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(hub.address())

        const endpoint = `${directory}/probe.sock`
        const handshake = handshakeFor(endpoint, `http://127.0.0.1:${port}`)
        const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>()
        yield* Queue.offer(stdin, line(handshake))
        const hubStdin = yield* Layer.build(Stdio.layerTest({ stdin: Stream.fromQueue(stdin) }))
        const app = yield* serveAttached({ manifest, handlers, clientDirectory }).pipe(
          Effect.provideContext(hubStdin),
          Effect.forkChild
        )
        const secret = { [hubHeaders.appSecret]: handshake.appSecret }
        yield* onEndpoint(endpoint, "/app/health", secret).pipe(
          Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 })
        )

        // No secret, a wrong one of another length, or a wrong one of the same length: 403 before anything else.
        for (const headers of [{}, { [hubHeaders.appSecret]: "short" }, { [hubHeaders.appSecret]: "f".repeat(32) }]) {
          const refused = yield* onEndpoint(endpoint, "/app/manifest", headers)
          expect([refused.status, JSON.parse(refused.body)]).toEqual([403, { code: "not_hub" }])
        }
        expect((yield* onEndpoint(endpoint, "/app/manifest", secret)).status).toBe(200)

        const caller = JSON.stringify({ login: "viewer", sameNode: true, provenance: "verified_local_listener" })
        const read = yield* onEndpoint(endpoint, "/v1/modules/probe/host", {
          ...secret,
          [hubHeaders.caller]: caller,
          [hubHeaders.listener]: "local"
        })
        expect([read.status, JSON.parse(read.body)]).toEqual([200, "atlas"])
        expect(authorizations).toEqual(["Bearer spawn-token"])

        // The hub closing stdin stops the app.
        yield* Queue.end(stdin)
        yield* Fiber.join(app).pipe(Effect.timeout("2 seconds"))
      }).pipe(Effect.scoped))
  })
})
