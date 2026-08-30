import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import {
  decodeBoundedResponseJson,
  fleetResponseBodyMaxBytes,
  type HostConfiguration,
  type HostOperations,
  JobRecord,
  JobStore,
  jobTextMaxLength,
  makeFleetService
} from "@knpkv/herdr-fleet"
import { Effect, Result, Schema } from "effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commandOutputMaxBytes, makeHostOperations } from "../src/operations.js"

// Each test effect is an application boundary; @effect/vitest scopes its Node services.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const config = (
  repository: string,
  checkCommand: ReadonlyArray<string>
): HostConfiguration => ({
  allowedUsers: ["andrey@example.com"],
  applyCommand: null,
  browserMcpRecoverCommand: null,
  applyMachines: ["SER8"],
  approvalHub: {
    host: "SER8",
    nodeId: "node-ser8",
    url: "https://ser8.example.test:4779/"
  },
  approvalNodes: ["node-ser8"],
  approvalPort: 4779,
  checkCommand,
  coordinatorCommand: ["coordinator"],
  crossHost: false,
  herdrCommand: "herdr",
  host: "SER8",
  localPort: 4777,
  machines: [{ host: "SER8", nodeId: "node-ser8" }],
  port: 4778,
  pushAllowedOrigins: ["https://push.example.test"],
  pushSubject: "mailto:andrey@example.com",
  repository,
  approvalTls: null,
  stateDirectory: repository,
  tailscaleCommand: "tailscale"
})

describe("host command output", () => {
  it.effect("preserves bounded output and rejects the first byte over the cap", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-command-output-test-"))
    return Effect.gen(function*() {
      const bounded = yield* makeHostOperations(
        config(root, [
          "sh",
          "-c",
          "printf 'exact output'; printf 'diagnostic' >&2"
        ])
      )
      expect(yield* bounded.run({ kind: "nix.check" })).toBe("exact output")

      const failed = yield* makeHostOperations(
        config(root, ["sh", "-c", "printf 'plausible'; printf 'fatal' >&2; exit 7"])
      )
      const failedResult = yield* Effect.result(
        failed.run({ kind: "nix.check" })
      )
      expect(Result.isFailure(failedResult)).toBe(true)
      if (Result.isFailure(failedResult)) {
        expect(failedResult.failure.detail).toContain("code 7")
        expect(failedResult.failure.detail).toContain("fatal")
      }

      const overflowing = yield* makeHostOperations(
        config(root, [
          "sh",
          "-c",
          `dd if=/dev/zero bs=${commandOutputMaxBytes + 1} count=1 2>/dev/null`
        ])
      )
      const result = yield* Effect.result(overflowing.run({ kind: "nix.check" }))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          operation: "nix.check"
        })
        expect(result.failure.detail).toContain("exceeded")
      }

      const exact = yield* makeHostOperations(
        config(root, [
          "sh",
          "-c",
          `dd if=/dev/zero bs=${commandOutputMaxBytes} count=1 2>/dev/null | tr '\\000' x`
        ])
      )
      expect(Buffer.byteLength(yield* exact.run({ kind: "nix.check" }))).toBe(
        commandOutputMaxBytes
      )

      const herdrCommand = join(root, "herdr-test")
      writeFileSync(herdrCommand, "#!/bin/sh\nprintf 'accepted'\n", {
        mode: 0o700
      })
      const nearLimit = yield* makeHostOperations({
        ...config(root, ["true"]),
        herdrCommand
      })
      expect(
        yield* nearLimit.run({
          kind: "agent.message",
          message: "x".repeat(jobTextMaxLength),
          session: "agent-1"
        })
      ).toBe("accepted")

      writeFileSync(
        herdrCommand,
        `#!/bin/sh
printf '%s\n' '{"result":{"agents":[{"agent":"codex","agent_status":"working","cwd":"/","pane_id":"w1:p1","state_change_seq":1},{"agent":"codex","agent_status":"working","cwd":"/repo","pane_id":"w1:p2","state_change_seq":2}]}}'
`,
        { mode: 0o700 }
      )
      expect(yield* nearLimit.listAgents()).toMatchObject({
        agents: [
          { paneId: "w1:p1", work: "root" },
          { paneId: "w1:p2", work: "repo" }
        ],
        available: true,
        error: null
      })

      writeFileSync(
        herdrCommand,
        "#!/bin/sh\nprintf 'fatal agent list' >&2\nexit 7\n",
        { mode: 0o700 }
      )
      expect(yield* nearLimit.listAgents()).toMatchObject({
        available: false,
        error: expect.stringContaining(
          "herdr.agent_list: command exited with code 7: fatal agent list"
        )
      })

      writeFileSync(
        herdrCommand,
        "#!/bin/sh\nprintf 'not-json'\n",
        { mode: 0o700 }
      )
      expect(yield* nearLimit.listAgents()).toMatchObject({
        available: false,
        error: expect.stringContaining("herdr.agent_list.decode:")
      })

      const coordinatorCommand = join(root, "coordinator-test")
      writeFileSync(
        coordinatorCommand,
        "#!/bin/sh\nprintf 'fatal coordinator' >&2\nexit 7\n",
        { mode: 0o700 }
      )
      const coordinator = yield* makeHostOperations({
        ...config(root, ["true"]),
        coordinatorCommand: [coordinatorCommand]
      })
      const commandFailure = yield* Effect.result(
        coordinator.runCoordinatorChat(
          {
            channel: "coordinator_chat",
            kind: "agent.delegate",
            mode: "consult",
            prompt: "status",
            repository: root
          },
          () => Effect.void,
          "job-1"
        )
      )
      expect(commandFailure).toMatchObject({
        failure: {
          detail: expect.stringContaining("code 7: fatal coordinator"),
          operation: "agent.delegate.chat"
        }
      })

      writeFileSync(
        coordinatorCommand,
        "#!/bin/sh\nprintf 'not-json'\n",
        { mode: 0o700 }
      )
      const decodeFailure = yield* Effect.result(
        coordinator.runCoordinatorChat(
          {
            channel: "coordinator_chat",
            kind: "agent.delegate",
            mode: "consult",
            prompt: "status",
            repository: root
          },
          () => Effect.void,
          "job-1"
        )
      )
      expect(decodeFailure).toMatchObject({
        failure: { operation: "agent.delegate.chat.lifecycle" }
      })

      writeFileSync(
        coordinatorCommand,
        `#!/bin/sh
[ "$2" = "job-1" ] || exit 8
printf '%s\n' '{"jobId":"job-1","protocol":"herdr.coordinator.child.v1","requestId":"request-1","type":"started","worker":{"agentId":"agent-child","host":"SER8","name":"Child","paneId":"w1:p2","relationship":{"parentAgentId":"agent-parent","relation":"delegated"}}}'
printf '%s\n' '{"jobId":"job-1","protocol":"herdr.coordinator.child.v1","reply":"fleet healthy","requestId":"request-1","type":"completed"}'
`,
        { mode: 0o700 }
      )
      const started: Array<string> = []
      expect(
        yield* coordinator.runCoordinatorChat(
          {
            channel: "coordinator_chat",
            kind: "agent.delegate",
            mode: "consult",
            prompt: "status",
            repository: root
          },
          (identity) =>
            Effect.sync(() => {
              started.push(`${identity.host}:${identity.agentId}`)
            }),
          "job-1"
        )
      ).toBe("fleet healthy")
      expect(started).toEqual(["SER8:agent-child"])

      writeFileSync(
        coordinatorCommand,
        `#!/bin/sh
[ "$2" = "job-1" ] || exit 8
printf '%s\n' '{"jobId":"job-1","protocol":"herdr.coordinator.child.v1","requestId":"request-1","type":"started","worker":{"agentId":"agent-child","host":"SER8","name":"Child","paneId":"w1:p2","relationship":{"parentAgentId":"agent-parent","relation":"delegated"}}}'
printf '%s\n' '{"jobId":"job-1","protocol":"herdr.coordinator.child.v1","reply":"wrong request","requestId":"request-2","type":"completed"}'
`,
        { mode: 0o700 }
      )
      expect(
        yield* Effect.result(
          coordinator.runCoordinatorChat(
            {
              channel: "coordinator_chat",
              kind: "agent.delegate",
              mode: "consult",
              prompt: "status",
              repository: root
            },
            () => Effect.void,
            "job-1"
          )
        )
      ).toMatchObject({
        failure: { operation: "agent.delegate.chat.lifecycle" }
      })
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("rejects an oversized actor before durable job mutation", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-job-envelope-test-"))
    const operations: HostOperations = {
      inspect: () =>
        Effect.succeed({
          applyConfigured: true,
          branch: "main",
          dirty: false,
          repository: root,
          revision: "abc123"
        }),
      listAgents: () => Effect.succeed({ agents: [], available: true, error: null }),
      run: () => Effect.succeed("\u0001".repeat(commandOutputMaxBytes)),
      runLocal: () => Effect.succeed("ok"),
      runCoordinatorChat: () => Effect.succeed("ok")
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            operations,
            store
          })
          expect(
            yield* Effect.result(
              fleet.submit(
                {
                  payload: {
                    kind: "agent.message",
                    message: "\u0001".repeat(jobTextMaxLength),
                    session: "agent-1"
                  }
                },
                "\u0001".repeat(30_000)
              )
            )
          ).toMatchObject({ failure: { _tag: "FleetValidationError" } })
          expect(yield* fleet.history(1)).toEqual([])

          const submitted = yield* fleet.submit(
            {
              payload: {
                kind: "agent.message",
                message: "\u0001".repeat(jobTextMaxLength),
                session: "agent-1"
              }
            },
            "andrey@example.com"
          )
          if (submitted.approvalNonce === null) {
            return yield* Effect.die("approval nonce missing")
          }
          yield* fleet.approve(
            submitted.id,
            { hash: submitted.hash, nonce: submitted.approvalNonce },
            "andrey@example.com"
          )
          const completed = yield* fleet.run(submitted.id)
          const body = JSON.stringify(completed)
          expect(Buffer.byteLength(body)).toBeLessThanOrEqual(
            fleetResponseBodyMaxBytes
          )
          expect(
            yield* decodeBoundedResponseJson(
              HttpClientResponse.fromWeb(
                HttpClientRequest.get("http://fleet.test/job"),
                new Response(body)
              ),
              JobRecord
            )
          ).toEqual(completed)
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("keeps maximum command output inside a serialized job response", () => {
    const response = (body: string) =>
      HttpClientResponse.fromWeb(
        HttpClientRequest.get("http://fleet.test/job"),
        new Response(body)
      )
    return Effect.gen(function*() {
      for (
        const output of [
          "x".repeat(commandOutputMaxBytes),
          "\u0001".repeat(commandOutputMaxBytes)
        ]
      ) {
        for (
          const outcome of [
            { error: null, result: output, status: "succeeded" },
            {
              error: `command exited with code 7: ${output}`,
              result: null,
              status: "failed"
            }
          ]
        ) {
          const record = Schema.decodeUnknownSync(JobRecord)({
            actor: "andrey@example.com",
            approvalNonce: null,
            approvedBy: null,
            createdAt: 1_000,
            hash: "0".repeat(64),
            id: "job-max-output",
            payload: {
              kind: "agent.message",
              message: "\u0001".repeat(jobTextMaxLength),
              session: "agent-1"
            },
            updatedAt: 1_000,
            ...outcome
          })
          const body = JSON.stringify(record)
          expect(Buffer.byteLength(body)).toBeLessThanOrEqual(fleetResponseBodyMaxBytes)
          expect(yield* decodeBoundedResponseJson(response(body), JobRecord)).toEqual(record)
        }
      }
    })
  })
})
