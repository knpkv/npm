import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { BrowserOpener } from "@knpkv/browser-pairing/launch"
import { type ConnectPostBody, ConnectPostRequest, UnboundAgent } from "@knpkv/herdr-connect"
import type { HostConfiguration } from "@knpkv/herdr-fleet"
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Result, Schema } from "effect"
import { Command } from "effect/cli"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { makeRelayPostCommand, resolveReportingAgent, submitRelayPost } from "../src/internal/relay-cli.js"
import { RelayProbe, relayRootCommand } from "../src/internal/relay-open.js"
import { ownerPaths } from "./fixtures/hub-paths.js"

const makeRelayCommand = <A, E, R>(report: (body: ConnectPostBody) => Effect.Effect<A, E, R>) =>
  relayRootCommand.pipe(Command.withSubcommands([makeRelayPostCommand(report)]))

const invalidTextCases = [
  {
    kind: "status",
    text: "x".repeat(241),
    detail: "text is 241 characters; status posts are limited to 240 (other kinds 1024)"
  },
  { kind: "note", text: "x".repeat(1025), detail: "text is 1025 characters; note posts are limited to 1024" },
  { kind: "status", text: "", detail: "text is empty" },
  { kind: "note", text: " \t\n ", detail: "text is empty" }
] satisfies ReadonlyArray<{ readonly kind: ConnectPostBody["kind"]; readonly text: string; readonly detail: string }>

const postLayer = Layer.mergeAll(
  NodeServices.layer,
  ownerPaths(),
  Layer.succeed(BrowserOpener, BrowserOpener.of({ open: () => Effect.die("Post/help must not open a browser") })),
  Layer.succeed(
    RelayProbe,
    RelayProbe.of({
      tailnetOnline: () => Effect.die("Post/help must not discover Relay"),
      answers: () => Effect.die("Post/help must not probe Relay")
    })
  )
)

it.layer(postLayer)("relay post", (it) => {
  for (const fixture of invalidTextCases) {
    it.effect(`reports the precise text failure: ${fixture.kind}, ${JSON.stringify(fixture.text.length)}`, () =>
      Effect.gen(function*() {
        const command = makeRelayCommand(() => Effect.die("invalid report reached transport"))
        const result = yield* Effect.result(
          Command.runWith(command, { version: "0" })(["post", "--kind", fixture.kind, fixture.text])
        )
        if (Result.isSuccess(result)) return yield* Effect.die("invalid text accepted")
        expect(result.failure).toMatchObject({ _tag: "InvalidReport", detail: fixture.detail })
      }))
  }

  it.effect("accepts a status with a URL at the 240-character limit without changing the text", () =>
    Effect.gen(function*() {
      const text = "https://example.test/status ".padEnd(240, "x")
      const received: Array<ConnectPostBody> = []
      const command = makeRelayCommand((body) =>
        Effect.sync(() => {
          received.push(body)
        })
      )
      yield* Command.runWith(command, { version: "0" })(["post", "--kind", "status", text])
      expect(received).toHaveLength(1)
      expect(received[0]?.text).toBe(text)
    }))

  it.effect("retries unavailable responses but preserves exhausted store failures without retrying", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "relay-post-" })
      const command = paths.join(directory, "herdr-test")
      yield* fs.writeFileString(
        command,
        `#!/bin/sh\nprintf '%s\\n' '{"result":{"agent":{"agent":"worker","pane_id":"w1:p1","tokens":{"agent_id":"agent-one","lineage_version":"hostd.agent-lineage.v1"}}}}'\n`
      )
      yield* fs.chmod(command, 0o700)
      const config: HostConfiguration = {
        allowedUsers: ["user@example.test"],
        applyCommand: null,
        browserMcpRecoverCommand: null,
        applyMachines: [],
        approvalHub: { host: "HOST-B", nodeId: "node-b", url: "https://hub.example.test/" },
        approvalNodes: [],
        approvalPort: 0,
        checkCommand: [],
        coordinatorCommand: [],
        crossHost: true,
        herdrCommand: command,
        host: "HOST-A",
        localPort: 0,
        machines: [{ host: "HOST-A", nodeId: "node-a" }],
        port: 0,
        pushAllowedOrigins: [],
        pushSubject: "mailto:user@example.test",
        repository: directory,
        approvalTls: null,
        stateDirectory: directory,
        tailscaleCommand: "tailscale"
      }
      const received: Array<typeof ConnectPostRequest.Type> = []
      let busy = false
      let delayed = false
      const slowStarted = yield* Deferred.make<void>()
      const client = HttpClient.make((request) =>
        Effect.gen(function*() {
          expect(request.url).toBe("https://hub.example.test/v1/connect/posts")
          if (request.body._tag !== "Uint8Array") return yield* Effect.die("JSON body missing")
          const body = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectPostRequest))(
            new TextDecoder().decode(request.body.body)
          )
          received.push(body)
          if (delayed) {
            yield* Deferred.succeed(slowStarted, undefined)
            yield* Effect.sleep("11 seconds")
          }
          return HttpClientResponse.fromWeb(
            request,
            busy
              ? Response.json({
                error: "ConnectStoreBusyError",
                operation: "posts.post",
                timeoutMillis: 5_000,
                cause: "private SQLite detail"
              }, {
                status: 503
              })
              : received.length === 1
              ? Response.json({ error: "Unavailable", operation: "posts.inventory" }, { status: 503 })
              : Response.json({ ...body, host: "host-a", createdAt: 1, sequence: 1 })
          )
        })
      )
      const body: ConnectPostBody = { kind: "note", text: "Update", eventId: "retry-one" }
      expect(
        (yield* submitRelayPost(config, "w1:p1", body).pipe(Effect.provideService(HttpClient.HttpClient, client)))
          .eventId
      ).toBe("retry-one")
      expect(received).toEqual([{ ...body, agentId: "agent-one" }, { ...body, agentId: "agent-one" }])
      busy = true
      const failed = yield* Effect.result(
        submitRelayPost(config, "w1:p1", { ...body, eventId: "busy-one" }).pipe(
          Effect.provideService(HttpClient.HttpClient, client)
        )
      )
      expect(failed).toMatchObject({
        failure: { _tag: "ConnectStoreBusyError", operation: "posts.post", timeoutMillis: 5_000, cause: 503 }
      })
      expect(received).toHaveLength(3)
      delayed = true
      const pending = yield* Effect.forkScoped(Effect.result(
        submitRelayPost(config, "w1:p1", { ...body, eventId: "slow-busy" }).pipe(
          Effect.provideService(HttpClient.HttpClient, client)
        )
      ))
      yield* Deferred.await(slowStarted)
      yield* TestClock.adjust("11 seconds")
      expect(received).toHaveLength(4)
      expect(yield* Fiber.join(pending)).toMatchObject({
        failure: { _tag: "ConnectStoreBusyError", operation: "posts.post", timeoutMillis: 5_000, cause: 503 }
      })
      expect(received).toHaveLength(4)
    }).pipe(Effect.scoped))

  it.effect("parses bounded reports with a caller-controlled retry identity", () =>
    Effect.gen(function*() {
      const received: Array<ConnectPostBody> = []
      const command = makeRelayCommand((body) =>
        Effect.sync(() => {
          received.push(body)
        })
      )
      yield* Command.runWith(command, { version: "0" })([
        "post",
        "--kind",
        "progress",
        "--event-id",
        "retry-one",
        "--goal-step",
        "step-one",
        "Tests passing"
      ])
      expect(received).toEqual([{
        kind: "progress",
        eventId: "retry-one",
        goalStep: "step-one",
        text: "Tests passing"
      }])
    }))

  it.effect("rejects missing and invalid kinds and oversized text before submitting", () =>
    Effect.gen(function*() {
      const command = makeRelayCommand(() => Effect.die("invalid report reached transport"))
      for (
        const args of [["post", "text"], ["post", "--kind", "transcript", "text"], [
          "post",
          "--kind",
          "status",
          "x".repeat(241)
        ]]
      ) {
        const result = yield* Effect.result(
          Command.runWith(command, { version: "0" })(args)
        )
        expect(Result.isFailure(result)).toBe(true)
      }
    }))

  it.effect("help avoids transport; post domain failures stay tagged", () =>
    Effect.gen(function*() {
      const command = makeRelayCommand(() => Effect.fail(new UnboundAgent({ agentId: "agent-one" })))
      for (const args of [["--help"], ["post", "--help"]]) {
        const help = yield* Effect.result(
          Command.runWith(command, { version: "0" })(args)
        )
        expect(Result.isSuccess(help)).toBe(true)
      }
      const failed = yield* Effect.result(
        Command.runWith(command, { version: "0" })(["post", "--kind", "note", "text"])
      )
      expect(Result.isFailure(failed) && failed.failure._tag).toBe("UnboundAgent")
    }))

  it.effect("takes identity from the current pane and refuses missing or foreign stable identity", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "relay-identity-" })
      const command = paths.join(directory, "herdr-test")
      const write = (paneId: string, tokens: Readonly<Record<string, string>>) =>
        fs.writeFileString(
          command,
          `#!/bin/sh\nprintf '%s\\n' '${
            JSON.stringify({ result: { agent: { agent: "worker", pane_id: paneId, tokens } } })
          }'\n`
        )
      const tokens = { agent_id: "agent-one", lineage_version: "hostd.agent-lineage.v1" }
      yield* write("w1:p1", tokens)
      yield* fs.chmod(command, 0o700)
      expect(yield* resolveReportingAgent(command, "w1:p1")).toBe("agent-one")
      for (
        const [paneId, metadata] of [["w1:p2", tokens], ["w1:p1", {}]] satisfies ReadonlyArray<
          readonly [string, Readonly<Record<string, string>>]
        >
      ) {
        yield* write(paneId, metadata)
        const failed = yield* Effect.result(resolveReportingAgent(command, "w1:p1"))
        expect(Result.isFailure(failed) && failed.failure._tag).toBe("UnboundAgent")
      }
      const invalid = yield* Effect.result(resolveReportingAgent(command, "--help"))
      expect(Result.isFailure(invalid) && invalid.failure._tag).toBe("UnboundAgent")
    }).pipe(Effect.scoped))
})
