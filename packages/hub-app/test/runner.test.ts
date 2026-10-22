/** The app runner: its arguments, and the attached listener's caller, grant and shell services. */
import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Result, Schedule, Schema } from "effect"
import { createServer, request as httpRequest, type Server } from "node:http"
import { tmpdir } from "node:os"
import { ShellServices } from "../src/hub-client.js"
import {
  AppId,
  type AppManifestInput,
  hubHeaders,
  ModuleHandlers,
  moduleReadRoute,
  ModuleRouteFailure
} from "../src/index.js"
import { readRunMode, serveAttached } from "../src/node.js"
import { moduleWriteRoute } from "../src/route.js"

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
  services: ["jobs.submit"],
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
        moduleReadRoute("/who", Empty, Schema.String, (_query, caller) => Effect.succeed(caller.login)),
        moduleWriteRoute("POST", "/job", Empty, Schema.Json, Schema.String, (payload) =>
          shell.submitJob(payload).pipe(
            Effect.map((accepted) => accepted.jobId),
            Effect.mapError((error) => new ModuleRouteFailure({ status: 503, code: error._tag }))
          ))
      ]
    }
  })
)

/** One request over a unix socket. */
const onSocket = (socket: string, method: string, path: string, headers: Record<string, string>, body?: string) =>
  Effect.callback<{ readonly status: number; readonly body: string }, Error>((resume) => {
    const outgoing = httpRequest({ socketPath: socket, method, path, headers }, (incoming) => {
      const chunks: Array<Buffer> = []
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
      incoming.on(
        "end",
        () => resume(Effect.succeed({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
      )
    })
    outgoing.on("error", (error) => resume(Effect.fail(error)))
    outgoing.end(body)
  })

describe("readRunMode", () => {
  it("is attached with --socket, reading the hub from the environment", () => {
    const mode = readRunMode(manifest, ["--socket", "/run/probe.sock"], {
      HUB_URL: "http://127.0.0.1:3101",
      HUB_APP_TOKEN_FILE: "/run/probe.token"
    })
    expect(mode).toEqual(Result.succeed({
      _tag: "Attached",
      socket: "/run/probe.sock",
      hubUrl: "http://127.0.0.1:3101",
      tokenFile: "/run/probe.token"
    }))
  })

  it("is standalone otherwise, on the manifest's port unless --port says", () => {
    expect(readRunMode(manifest, [], {})).toEqual(Result.succeed({ _tag: "Standalone", port: 3199, open: true }))
    expect(readRunMode(manifest, ["serve", "--port", "4000", "--no-open"], {})).toEqual(
      Result.succeed({ _tag: "Standalone", port: 4000, open: false })
    )
  })

  it("refuses attached without the hub's environment, and unknown arguments", () => {
    expect(Result.isFailure(readRunMode(manifest, ["--socket", "/run/probe.sock"], {}))).toBe(true)
    expect(Result.isFailure(readRunMode(manifest, ["launch"], {}))).toBe(true)
    expect(Result.isFailure(readRunMode(manifest, ["--port", "seventy"], {}))).toBe(true)
  })
})

describe("attached runner", () => {
  it.layer(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp), { excludeTestServices: true })((it) => {
    it.effect("answers with the hub's caller, refuses without one, and hands the grant to shell services", () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "hub-app-" })
        const clientDirectory = `${directory}/client`
        yield* fileSystem.makeDirectory(clientDirectory)
        yield* fileSystem.writeFileString(`${clientDirectory}/client.js`, "export default {}\n")
        yield* fileSystem.writeFileString(`${directory}/token`, "app-token\n")

        // A stand-in hub: records what the app sent to the jobs service.
        const seen: Array<
          { readonly authorization: string | undefined; readonly app: unknown; readonly body: string }
        > = []
        const hub = yield* Effect.acquireRelease(
          Effect.callback<Server>((resume) => {
            const server = createServer((request, response) => {
              const chunks: Array<Buffer> = []
              request.on("data", (chunk: Buffer) => chunks.push(chunk))
              request.on("end", () => {
                seen.push({
                  authorization: request.headers.authorization,
                  app: request.headers[hubHeaders.app],
                  body: Buffer.concat(chunks).toString()
                })
                response.writeHead(200, { "content-type": "application/json" })
                response.end(JSON.stringify({ jobId: "job-1", status: "queued" }))
              })
            })
            server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
          }),
          (server) =>
            Effect.callback<void>((resume) => {
              server.close(() => resume(Effect.void))
            })
        )
        const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(hub.address())

        const socket = `${directory}/probe.sock`
        yield* serveAttached({ manifest, handlers, clientDirectory }, {
          _tag: "Attached",
          socket,
          hubUrl: `http://127.0.0.1:${port}`,
          tokenFile: `${directory}/token`
        }).pipe(Effect.forkScoped)
        yield* onSocket(socket, "GET", "/app/health", {}).pipe(
          Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 })
        )

        const served = yield* onSocket(socket, "GET", "/app/manifest", {})
        expect(JSON.parse(served.body).client).toEqual({ entry: "client.js", css: [] })

        expect((yield* onSocket(socket, "GET", "/v1/modules/probe/who", {})).status).toBe(403)
        const caller = JSON.stringify({ login: "viewer", sameNode: false, provenance: "authenticated_remote" })
        const who = yield* onSocket(socket, "GET", "/v1/modules/probe/who", { [hubHeaders.caller]: caller })
        expect(JSON.parse(who.body)).toBe("viewer")

        const grant = "g".repeat(43)
        const job = yield* onSocket(socket, "POST", "/v1/modules/probe/job", {
          [hubHeaders.caller]: caller,
          [hubHeaders.grant]: grant,
          "content-type": "application/json"
        }, JSON.stringify({ kind: "noop" }))
        expect(JSON.parse(job.body)).toBe("job-1")
        expect(seen).toEqual([{
          authorization: "Bearer app-token",
          app: "probe",
          body: JSON.stringify({ grant, payload: { kind: "noop" } })
        }])

        const ungranted = yield* onSocket(socket, "POST", "/v1/modules/probe/job", {
          [hubHeaders.caller]: caller,
          "content-type": "application/json"
        }, "{}")
        expect(JSON.parse(ungranted.body)).toEqual({ code: "GrantInvalid" })
        expect(seen).toHaveLength(1)
      }).pipe(Effect.scoped))
  })
})
