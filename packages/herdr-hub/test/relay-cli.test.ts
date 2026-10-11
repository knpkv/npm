import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { type ConnectPostBody, ConnectPostRequest, UnboundAgent } from "@knpkv/herdr-connect"
import type { HostConfiguration } from "@knpkv/herdr-fleet"
import { Effect, FileSystem, Path, Result, Schema } from "effect"
import { Command } from "effect/cli"
import { HttpClient, HttpClientResponse } from "effect/http"
import { makeRelayPostCommand, resolveReportingAgent, submitRelayPost } from "../src/internal/relay-cli.js"

const makeRelayCommand = <A, E, R>(report: (body: ConnectPostBody) => Effect.Effect<A, E, R>) =>
  Command.make("relay").pipe(Command.withSubcommands([makeRelayPostCommand(report)]))

it.layer(NodeServices.layer)("relay post", (it) => {
  it.effect("retries unavailable responses with one event ID and targets only the configured canonical hub", () =>
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
      const client = HttpClient.make((request) =>
        Effect.gen(function*() {
          expect(request.url).toBe("https://hub.example.test/v1/connect/posts")
          if (request.body._tag !== "Uint8Array") return yield* Effect.die("JSON body missing")
          const body = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectPostRequest))(
            new TextDecoder().decode(request.body.body)
          )
          received.push(body)
          return HttpClientResponse.fromWeb(
            request,
            received.length === 1
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

  it.effect("root and help avoid transport; domain failures stay tagged", () =>
    Effect.gen(function*() {
      const command = makeRelayCommand(() => Effect.fail(new UnboundAgent({ agentId: "agent-one" })))
      for (const args of [[], ["--help"], ["post", "--help"]]) {
        const help = yield* Effect.result(
          Command.runWith(command, { version: "0" })(args)
        )
        if (args.length === 0) expect(Result.isFailure(help) && help.failure._tag).toBe("ShowHelp")
        else expect(Result.isSuccess(help)).toBe(true)
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
