import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { BrowserOpener } from "@knpkv/browser-pairing/launch"
import { type ConnectSelfBody, ConnectSelfState } from "@knpkv/herdr-connect"
import type { HostConfiguration } from "@knpkv/herdr-fleet"
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Result, Schema } from "effect"
import { Command } from "effect/cli"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { makeRelaySelfCommand } from "../src/internal/relay-cli.js"
import { RelayProbe, relayRootCommand } from "../src/internal/relay-open.js"
import { submitRelaySelf } from "../src/internal/relay-self.js"

const layer = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(BrowserOpener, BrowserOpener.of({ open: () => Effect.die("self/help must not open a browser") })),
  Layer.succeed(
    RelayProbe,
    RelayProbe.of({
      tailnetOnline: () => Effect.die("self/help must not discover Relay"),
      answers: () => Effect.die("self/help must not probe Relay")
    })
  )
)

it.layer(layer)("relay me", (it) => {
  it.effect("parses optional mood, trimmed words and accessory without accepting an identity override", () =>
    Effect.gen(function*() {
      const received: Array<ConnectSelfBody> = []
      const command = relayRootCommand.pipe(Command.withSubcommands([makeRelaySelfCommand((body) =>
        Effect.sync(() => {
          received.push(body)
        })
      )]))
      yield* Command.runWith(command, { version: "0" })([
        "me",
        "--mood",
        "focused",
        "--say",
        "  Running tests  ",
        "--accessory",
        "glasses"
      ])
      yield* Command.runWith(command, { version: "0" })(["me", "--say", "x".repeat(140)])
      expect(received).toEqual([{ mood: "focused", say: "Running tests", accessory: "glasses" }, {
        say: "x".repeat(140)
      }])
      const invalid = yield* Effect.result(
        Command.runWith(command, { version: "0" })(["me", "--mood", "happy", "--agent", "agent-two"])
      )
      expect(Result.isFailure(invalid)).toBe(true)
      expect(received).toHaveLength(2)
    }))

  for (
    const fixture of [
      { args: ["me"], detail: "at least one of mood or say" },
      { args: ["me", "--accessory", "glasses"], detail: "at least one of mood or say" },
      { args: ["me", "--say", "x".repeat(141)], detail: "140" },
      { args: ["me", "--say", " "], detail: "1" },
      { args: ["me", "--mood", "angry"], detail: "mood" },
      { args: ["me", "--mood", "happy", "--accessory", "crown"], detail: "accessory" },
      { args: ["me", "--say", "line\nbreak"], detail: "say" }
    ]
  ) {
    it.effect(`rejects invalid input before transport: ${fixture.detail}, ${fixture.args[1] ?? "no flags"}`, () =>
      Effect.gen(function*() {
        const command = relayRootCommand.pipe(
          Command.withSubcommands([makeRelaySelfCommand(() => Effect.die("invalid self reached transport"))])
        )
        const result = yield* Effect.result(Command.runWith(command, { version: "0" })(fixture.args))
        if (Result.isSuccess(result)) return yield* Effect.die("invalid self accepted")
        expect(result.failure).toMatchObject({ _tag: "InvalidReport", detail: expect.stringContaining(fixture.detail) })
      }))
  }

  it.effect("help does not resolve identity or submit state", () =>
    Effect.gen(function*() {
      const command = relayRootCommand.pipe(
        Command.withSubcommands([makeRelaySelfCommand(() => Effect.die("help reached transport"))])
      )
      yield* Command.runWith(command, { version: "0" })(["me", "--help"])
    }))

  it.effect("preserves exhausted store failures and current-pane authorization without retrying", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "relay-self-" })
      const herdrCommand = paths.join(directory, "herdr-test")
      const writeIdentity = (paneId: string) =>
        fs.writeFileString(
          herdrCommand,
          `#!/bin/sh\nprintf '%s\\n' '${
            JSON.stringify({
              result: {
                agent: {
                  agent: "worker",
                  pane_id: paneId,
                  tokens: { agent_id: "agent-one", lineage_version: "hostd.agent-lineage.v1" }
                }
              }
            })
          }'\n`
        )
      yield* writeIdentity("w1:p1")
      yield* fs.chmod(herdrCommand, 0o700)
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
        herdrCommand,
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
      let requests = 0
      let limited = false
      let busy = false
      let delayed = false
      const slowStarted = yield* Deferred.make<void>()
      const client = HttpClient.make((request) =>
        Effect.gen(function*() {
          requests++
          expect(request.url).toBe("https://hub.example.test/v1/connect/me")
          expect(request.headers["x-herdr-agent-id"]).toBe("agent-one")
          if (request.body._tag !== "Uint8Array") throw new TypeError("JSON body missing")
          expect(new TextDecoder().decode(request.body.body)).toBe(JSON.stringify({ say: "Ready" }))
          if (delayed) {
            yield* Deferred.succeed(slowStarted, undefined)
            yield* Effect.sleep("11 seconds")
          }
          return HttpClientResponse.fromWeb(
            request,
            busy
              ? Response.json({
                error: "ConnectStoreBusyError",
                operation: "self.update",
                timeoutMillis: 5_000,
                cause: "private SQLite detail"
              }, {
                status: 503
              })
              : limited
              ? Response.json({ error: "TooManySelfUpdates", retryAfterMillis: 10_000 }, { status: 429 })
              : Response.json({ say: "Ready", accessory: "none", at: 1, replyTo: null })
          )
        })
      )
      const submit = () =>
        submitRelaySelf(config, "w1:p1", { say: "Ready" }).pipe(Effect.provideService(HttpClient.HttpClient, client))
      expect(Schema.is(ConnectSelfState)(yield* submit())).toBe(true)
      limited = true
      const rateFailure = yield* Effect.result(submit())
      expect(Result.isFailure(rateFailure) && rateFailure.failure).toMatchObject({
        _tag: "TooManySelfUpdates",
        retryAfterMillis: 10_000
      })
      expect(requests).toBe(2)
      busy = true
      expect(yield* Effect.result(submit())).toMatchObject({
        failure: { _tag: "ConnectStoreBusyError", operation: "self.update", timeoutMillis: 5_000, cause: 503 }
      })
      expect(requests).toBe(3)
      delayed = true
      const pending = yield* Effect.forkScoped(Effect.result(submit()))
      yield* Deferred.await(slowStarted)
      yield* TestClock.adjust("11 seconds")
      expect(yield* Fiber.join(pending)).toMatchObject({
        failure: { _tag: "ConnectStoreBusyError", operation: "self.update", timeoutMillis: 5_000, cause: 503 }
      })
      expect(requests).toBe(4)
      yield* writeIdentity("w1:p2")
      const identityFailure = yield* Effect.result(submit())
      expect(Result.isFailure(identityFailure) && identityFailure.failure._tag).toBe("UnboundAgent")
      expect(requests).toBe(4)
    }).pipe(Effect.scoped))
})
