import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import {
  type CoreJobPayload,
  decodeBoundedResponseJson,
  fleetResponseBodyMaxBytes,
  type HostConfiguration,
  type HostOperations,
  JobRecord,
  JobStore,
  jobTextMaxLength,
  makeFleetService,
  type WorkerStarted
} from "@knpkv/herdr-fleet"
import { WorkPullRequestObservation, WorkStoreError } from "@knpkv/herdr-work"
import { ConfigProvider, Effect, FileSystem, Path, Result, Schema } from "effect"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeHostdOperations } from "../src/hostd.js"
import { attachTaskWorkReader } from "../src/internal/agent-task-work-source.js"
import { type TaskWorkObservation } from "../src/internal/agent-task-work.js"
import { makeHostCommand } from "../src/internal/host-command.js"
import { commandOutputMaxBytes, commandOutputTailBytes, makeHostOperations } from "../src/operations.js"

// Each test effect is an application boundary; @effect/vitest scopes its Node services.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const config = (
  repository: string,
  checkCommand: ReadonlyArray<string>
): HostConfiguration => ({
  allowedUsers: ["owner@example.com"],
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
  pushSubject: "mailto:owner@example.com",
  repository,
  approvalTls: null,
  stateDirectory: repository,
  tailscaleCommand: "tailscale"
})

/** For jobs that never start an agent worker (nix.check, agent.message); reaching this callback is a defect. */
const noWorkerStarted: WorkerStarted = () => Effect.die("a job that starts no worker reported a started worker")

describe("host command output", () => {
  it.effect("accepts root coordinator lifecycle only for coordinator-handled delegates", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-root-coordinator-test-"))
    const coordinatorCommand = join(root, "host-coordinator")
    writeFileSync(
      coordinatorCommand,
      `#!/bin/sh
job_id="$2"
printf '%s\\n' "{\\"jobId\\":\\"$job_id\\",\\"protocol\\":\\"herdr.coordinator.child.v1\\",\\"requestId\\":\\"request-1\\",\\"type\\":\\"started\\",\\"worker\\":{\\"agentId\\":\\"agent-host-coordinator\\",\\"host\\":\\"SER8\\",\\"name\\":\\"host-coordinator\\",\\"paneId\\":\\"w8:p1\\"}}"
printf '%s\\n' "{\\"jobId\\":\\"$job_id\\",\\"protocol\\":\\"herdr.coordinator.child.v1\\",\\"reply\\":\\"fleet healthy\\",\\"requestId\\":\\"request-1\\",\\"type\\":\\"completed\\"}"
`,
      { mode: 0o700 }
    )
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const hostOperations = yield* makeHostOperations({
            ...config(root, ["true"]),
            coordinatorCommand: [coordinatorCommand]
          })
          const consult = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("job-consult"),
            now: Effect.succeed(1_000),
            operations: hostOperations,
            store
          })
          const consultJob = yield* consult.submit({
            payload: {
              kind: "agent.delegate",
              mode: "consult",
              prompt: "inspect fleet",
              repository: root
            }
          }, "owner")
          expect(yield* consult.run(consultJob.id)).toMatchObject({
            error: null,
            result: "fleet healthy",
            status: "succeeded",
            worker: {
              agentId: "agent-host-coordinator",
              host: "SER8",
              name: "host-coordinator",
              paneId: "w8:p1"
            }
          })

          const transitionSummary = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("job-transition-summary"),
            now: Effect.succeed(1_001),
            operations: hostOperations,
            store
          })
          const transitionSummaryJob = yield* transitionSummary.submit({
            payload: {
              kind: "agent.delegate",
              mode: "transition_summary",
              prompt: "summarize transition",
              repository: root
            }
          }, "owner")
          expect(yield* transitionSummary.run(transitionSummaryJob.id)).toMatchObject({
            error: null,
            result: "fleet healthy",
            status: "succeeded",
            worker: {
              agentId: "agent-host-coordinator",
              host: "SER8",
              name: "host-coordinator",
              paneId: "w8:p1"
            }
          })

          const chat = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("job-chat"),
            nonce: Effect.succeed("nonce-chat"),
            now: Effect.succeed(1_002),
            operations: hostOperations,
            store
          })
          const chatJob = yield* chat.submit({
            payload: {
              channel: "coordinator_chat",
              kind: "agent.delegate",
              mode: "work",
              prompt: "coordinate fleet",
              repository: root
            }
          }, "owner")
          yield* chat.approve(chatJob.id, {
            hash: chatJob.hash,
            nonce: "nonce-chat"
          }, "owner")
          const completedChatWork = yield* chat.runCoordinatorChat(chatJob.id)
          expect(completedChatWork).toMatchObject({
            error: "FleetOperationError",
            result: null,
            status: "failed"
          })
          expect(completedChatWork.worker).toBeUndefined()

          const delegatedReview = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("job-review"),
            now: Effect.succeed(1_003),
            operations: hostOperations,
            store
          })
          const reviewJob = yield* delegatedReview.submit({
            payload: {
              kind: "agent.delegate",
              mode: "review",
              prompt: "review fleet",
              repository: root
            }
          }, "owner")
          const completedReview = yield* delegatedReview.run(reviewJob.id)
          expect(completedReview).toMatchObject({
            error: "FleetOperationError",
            result: null,
            status: "failed"
          })
          expect(completedReview.worker).toBeUndefined()

          const delegatedWork = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("job-work"),
            nonce: Effect.succeed("nonce-work"),
            now: Effect.succeed(1_004),
            operations: hostOperations,
            store
          })
          const workJob = yield* delegatedWork.submit({
            payload: {
              kind: "agent.delegate",
              mode: "work",
              prompt: "change fleet",
              repository: root
            }
          }, "owner")
          yield* delegatedWork.approve(workJob.id, {
            hash: workJob.hash,
            nonce: "nonce-work"
          }, "owner")
          const completedWork = yield* delegatedWork.run(workJob.id)
          expect(completedWork).toMatchObject({
            error: "FleetOperationError",
            result: null,
            status: "failed"
          })
          expect(completedWork.worker).toBeUndefined()
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("refuses sandbox jobs as rejected on a host that does not own the pool", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-sandbox-refusal-test-"))
    return Effect.gen(function*() {
      const operations = yield* makeHostOperations(config(root, ["true"]))
      for (
        const payload of [
          { kind: "sandbox.lease" },
          { kind: "sandbox.extend", accountId: "111111111111" },
          { kind: "sandbox.release", accountId: "111111111111" },
          { kind: "sandbox.reset", accountId: "111111111111", reason: "Manual" },
          { kind: "sandbox.budget.lift", accountId: "111111111111" }
        ] satisfies ReadonlyArray<CoreJobPayload>
      ) {
        expect(yield* Effect.flip(operations.run(payload, () => Effect.void, "job-sandbox"))).toMatchObject({
          _tag: "FleetOperationError",
          disposition: "rejected",
          operation: payload.kind
        })
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("passes the apply command the ref and then the job id", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-apply-arguments-test-"))
    return Effect.gen(function*() {
      const operations = yield* makeHostOperations({
        ...config(root, ["true"]),
        applyCommand: ["sh", "-c", "printf '%s %s' \"$1\" \"$2\"", "apply"]
      })
      expect(
        yield* operations.run({ kind: "nix.apply", ref: "a".repeat(40) }, () => Effect.void, "job-7")
      ).toBe(`${"a".repeat(40)} job-7`)
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("runs an apply with more output than the cap to completion and keeps its failure's end", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-apply-output-test-"))
    const completed = join(root, "completed")
    // Writes three caps of output, then marks completion: a reader that stopped at
    // the cap would stop the command before the marker exists.
    const noisy = (exit: number) => [
      "sh",
      "-c",
      `dd if=/dev/zero bs=${commandOutputMaxBytes * 3} count=1 2>/dev/null | tr '\\000' x; ` +
      `dd if=/dev/zero bs=${commandOutputMaxBytes * 3} count=1 2>/dev/null | tr '\\000' y >&2; ` +
      `printf 'activated' > "$0"; printf 'last stderr line' >&2; printf 'last stdout line'; exit ${exit}`,
      completed
    ]
    return Effect.gen(function*() {
      const succeeding = yield* makeHostOperations({ ...config(root, ["true"]), applyCommand: noisy(0) })
      const output = yield* succeeding.run({ kind: "nix.apply", ref: "a".repeat(40) }, noWorkerStarted, "job-7")
      expect(readFileSync(completed, "utf8")).toBe("activated")
      expect(output).toMatch(/^\[\d+ earlier bytes omitted\]\n/)
      expect(Buffer.byteLength(output)).toBeLessThan(commandOutputMaxBytes)

      rmSync(completed)
      const failing = yield* makeHostOperations({ ...config(root, ["true"]), applyCommand: noisy(3) })
      const result = yield* Effect.result(
        failing.run({ kind: "nix.apply", ref: "a".repeat(40) }, noWorkerStarted, "job-8")
      )
      expect(readFileSync(completed, "utf8")).toBe("activated")
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure.detail).toContain("code 3")
        expect(result.failure.detail).toContain("earlier bytes omitted")
        // brew bundle and friends explain a failure on stdout, so its tail follows stderr's.
        expect(result.failure.detail).toContain("last stderr line\nstdout:\n")
        expect(result.failure.detail.endsWith("last stdout line")).toBe(true)
        expect(Buffer.byteLength(result.failure.detail)).toBeLessThanOrEqual(commandOutputMaxBytes)
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("keeps a build log whole under the tail size and its end past it", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-command-output-test-"))
    return Effect.gen(function*() {
      const bounded = yield* makeHostOperations(
        config(root, [
          "sh",
          "-c",
          "printf 'exact output'; printf 'diagnostic' >&2"
        ])
      )
      expect(yield* bounded.run({ kind: "nix.check" }, noWorkerStarted, "job-nix-check")).toBe("exact output")

      const failed = yield* makeHostOperations(
        config(root, ["sh", "-c", "printf 'plausible'; printf 'fatal' >&2; exit 7"])
      )
      const failedResult = yield* Effect.result(
        failed.run({ kind: "nix.check" }, noWorkerStarted, "job-nix-check")
      )
      expect(Result.isFailure(failedResult)).toBe(true)
      if (Result.isFailure(failedResult)) {
        expect(failedResult.failure.detail).toContain("code 7")
        expect(failedResult.failure.detail).toBe("command exited with code 7: fatal\nstdout:\nplausible")
      }

      // A build log past the cap keeps its end: the omission line, then the
      // last commandOutputTailBytes, and the job still succeeds.
      const overflowing = yield* makeHostOperations(
        config(root, [
          "sh",
          "-c",
          `dd if=/dev/zero bs=${commandOutputMaxBytes + 1} count=1 2>/dev/null | tr '\\000' x; printf 'done'`
        ])
      )
      const tail = yield* overflowing.run({ kind: "nix.check" }, noWorkerStarted, "job-nix-check")
      const omitted = commandOutputMaxBytes + 1 + 4 - commandOutputTailBytes
      expect(tail.startsWith(`[${omitted} earlier bytes omitted]\n`)).toBe(true)
      expect(tail.endsWith("xxxxdone")).toBe(true)
      expect(Buffer.byteLength(tail)).toBeLessThan(commandOutputMaxBytes)

      const exact = yield* makeHostOperations(
        config(root, [
          "sh",
          "-c",
          `dd if=/dev/zero bs=${commandOutputTailBytes} count=1 2>/dev/null | tr '\\000' x`
        ])
      )
      expect(yield* exact.run({ kind: "nix.check" }, noWorkerStarted, "job-nix-check")).toBe(
        "x".repeat(commandOutputTailBytes)
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
        yield* nearLimit.run(
          {
            kind: "agent.message",
            message: "x".repeat(jobTextMaxLength),
            session: "agent-1"
          },
          noWorkerStarted,
          "job-agent-message"
        )
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
        "#!/bin/sh\nprintf '{\"partial\"' \nprintf 'fatal agent list' >&2\nexit 7\n",
        { mode: 0o700 }
      )
      const failedListing = yield* nearLimit.listAgents()
      expect(failedListing).toMatchObject({
        available: false,
        error: expect.stringContaining(
          "herdr.agent_list: command exited with code 7: fatal agent list"
        )
      })
      // Parsed output never rides along in a failure: only build logs carry stdout.
      expect(failedListing.error).not.toContain("partial")

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

      // Coordinator stdout is read line by line under the same byte cap as other
      // commands; the overflow surfaces wrapped as a lifecycle failure.
      writeFileSync(
        coordinatorCommand,
        `#!/bin/sh\ndd if=/dev/zero bs=${commandOutputMaxBytes + 1} count=1 2>/dev/null\n`,
        { mode: 0o700 }
      )
      const overflowFailure = yield* Effect.result(
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
      expect(overflowFailure).toMatchObject({
        failure: {
          _tag: "FleetOperationError",
          operation: "agent.delegate.chat.lifecycle",
          cause: {
            _tag: "FleetOperationError",
            detail: `command output exceeded ${commandOutputMaxBytes} bytes`,
            operation: "agent.delegate.chat"
          }
        }
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

  it.effect("filters the typed launch-pending entry and rejects unknown variants", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-agent-list-test-"))
    const herdrCommand = join(root, "herdr-test")
    writeFileSync(herdrCommand, "#!/bin/sh\n", { mode: 0o700 })
    return Effect.gen(function*() {
      const operations = yield* makeHostOperations({
        ...config(root, ["true"]),
        herdrCommand
      })

      writeFileSync(
        herdrCommand,
        `#!/bin/sh
printf '%s\\n' '{"result":{"agents":[{"agent":"codex","agent_status":"working","cwd":"/repo","pane_id":"w1:p1","state_change_seq":1},{"launch_pending":true,"agent":"codex","agent_status":"launch_pending","cwd":"/repo/pending","foreground_cwd":"/repo/pending","name":null,"pane_id":"w1:p2","state_change_seq":2,"tokens":{}}]}}'
`,
        { mode: 0o700 }
      )
      expect(yield* operations.listAgents()).toEqual({
        agents: [
          expect.objectContaining({ paneId: "w1:p1", work: "repo" })
        ],
        available: true,
        error: null
      })

      writeFileSync(
        herdrCommand,
        `#!/bin/sh
printf '%s\\n' '{"result":{"agents":[{"launch_pending":false,"agent_status":"working","cwd":"/repo","pane_id":"w1:p2","state_change_seq":2}]}}'
`,
        { mode: 0o700 }
      )
      expect(yield* operations.listAgents()).toMatchObject({
        agents: [],
        available: false,
        error: expect.stringContaining("herdr.agent_list.decode:")
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
            "owner@example.com"
          )
          if (submitted.approvalNonce === null) {
            return yield* Effect.die("approval nonce missing")
          }
          yield* fleet.approve(
            submitted.id,
            { hash: submitted.hash, nonce: submitted.approvalNonce },
            "owner@example.com"
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
            actor: "owner@example.com",
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

describe("host task signal producer", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("publishes decoded lifecycle kinds without inferring missing tool or Work/CI evidence", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const paths = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "host-task-kind-" })
        const herdrCommand = paths.join(root, "herdr-test")
        const cases = [
          { status: "idle", expected: "idle" },
          { status: "blocked", expected: "blocked" },
          { status: "done", expected: "done" },
          { status: "working", expected: "unknown" },
          { status: "unknown", expected: "unknown" },
          { status: "future-status", expected: "unknown" }
        ]
        const agents = cases.map(({ status }, index) => ({
          agent: "codex",
          agent_status: status,
          cwd: "/test-build-failed",
          pane_id: `w1:p${String(index + 1)}`,
          state_change_seq: 1,
          // Unsupported payload is not evidence and must not escape the host adapter.
          activity: { tool: "write", content: "private tool content", exit_code: 1 },
          tokens: { summary: "CI failed", work: "review pending" }
        }))
        yield* fs.writeFileString(
          herdrCommand,
          `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ result: { agents } })}'\n`
        )
        yield* fs.chmod(herdrCommand, 0o700)
        const operations = yield* makeHostOperations({ ...config(root, ["true"]), herdrCommand })
        const inventory = yield* operations.listAgents()
        expect(inventory.available).toBe(true)
        expect(inventory.agents.map(({ taskKind }) => taskKind)).toEqual(cases.map(({ expected }) => expected))
        expect(JSON.stringify(inventory)).not.toContain("private tool content")
        expect(inventory.agents).toHaveLength(6)
      }).pipe(Effect.scoped))
  })
})

describe("live host session producer", () => {
  it.layer(NodeServices.layer)((it) => {
    const providers: ReadonlyArray<"claude" | "codex"> = ["claude", "codex"]
    for (const provider of providers) {
      it.effect(`reads an explicit ${provider} root without HOME and leaves missing/relative roots unknown`, () =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* Path.Path
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "host-explicit-session-" })
          const providerRoot = paths.join(root, "provider")
          const directory = paths.join(providerRoot, provider === "claude" ? "projects" : "sessions")
          yield* fs.makeDirectory(directory, { recursive: true })
          const file = paths.join(directory, "target.jsonl")
          yield* fs.writeFileString(
            file,
            JSON.stringify(
              provider === "claude"
                ? {
                  type: "assistant",
                  message: { content: [{ type: "tool_use", id: "call", name: "Read", input: {} }] }
                }
                : {
                  type: "response_item",
                  payload: { type: "function_call", call_id: "call", name: "apply_patch", arguments: "{}" }
                }
            ) + "\n"
          )
          const herdrCommand = paths.join(root, "herdr-test")
          const agents = [{
            agent: provider,
            agent_status: "working",
            cwd: root,
            pane_id: "w1:p1",
            state_change_seq: 1,
            agent_session: { agent: provider, kind: "path", value: file }
          }]
          yield* fs.writeFileString(
            herdrCommand,
            `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ result: { agents } })}'\n`
          )
          yield* fs.chmod(herdrCommand, 0o700)
          const variable = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"
          const environments: ReadonlyArray<readonly [Readonly<Record<string, string>>, string]> = [
            [{ [variable]: providerRoot }, provider === "claude" ? "reading" : "writing"],
            [{}, "unknown"],
            [{ [variable]: "relative" }, "unknown"]
          ]
          for (const [environment, expected] of environments) {
            const operations = yield* makeHostOperations({ ...config(root, ["true"]), herdrCommand }).pipe(
              Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment))
            )
            expect((yield* operations.listAgents()).agents[0]?.taskKind, variable).toBe(expected)
          }
        }).pipe(Effect.scoped))
    }

    it.effect("serves reported Claude and Codex activity without leaking session identity, arguments or content", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const paths = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "host-session-task-" })
        const project = paths.join(root, ".claude", "projects", "-fixture-repo")
        const codexDirectory = paths.join(root, ".codex", "sessions", "2026", "10", "15")
        yield* fs.makeDirectory(project, { recursive: true })
        yield* fs.makeDirectory(codexDirectory, { recursive: true })
        yield* fs.writeFileString(
          paths.join(project, "target.jsonl"),
          JSON.stringify({
            type: "assistant",
            message: {
              content: [{
                type: "tool_use",
                id: "read",
                name: "Read",
                input: { file_path: "/private/secret", content: "PRIVATE_TOOL_CONTENT_SENTINEL" }
              }]
            }
          }) + "\n"
        )
        const codexFile = paths.join(codexDirectory, "native.jsonl")
        yield* fs.writeFileString(
          codexFile,
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "function_call",
              call_id: "test",
              name: "exec_command",
              arguments: JSON.stringify({ cmd: "pnpm test /private/secret", content: "PRIVATE_TOOL_CONTENT_SENTINEL" })
            }
          }) + "\n"
        )
        const agents = [
          {
            agent: "claude",
            agent_status: "working",
            cwd: "/fixture/repo",
            pane_id: "w1:p1",
            state_change_seq: 1,
            agent_session: { agent: "claude", kind: "id", value: "target" }
          },
          {
            agent: "codex",
            agent_status: "working",
            cwd: "/fixture/repo",
            pane_id: "w1:p2",
            state_change_seq: 1,
            agent_session: { agent: "codex", kind: "path", value: codexFile }
          },
          {
            agent: "codex",
            agent_status: "working",
            cwd: "/fixture/repo",
            pane_id: "w1:p3",
            state_change_seq: 1,
            agent_session: { kind: "id", value: "malformed" }
          }
        ]
        const herdrCommand = paths.join(root, "herdr-test")
        yield* fs.writeFileString(
          herdrCommand,
          `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ result: { agents } })}'\n`
        )
        yield* fs.chmod(herdrCommand, 0o700)
        const operations = yield* makeHostOperations({ ...config(root, ["true"]), herdrCommand }).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ HOME: root }))
        )
        const inventory = yield* operations.listAgents()
        expect(inventory.available).toBe(true)
        expect(inventory.agents.map(({ taskKind }) => taskKind)).toEqual(["reading", "testing", "unknown"])
        const wire = JSON.stringify(inventory)
        for (
          const privateValue of [
            "PRIVATE_TOOL_CONTENT_SENTINEL",
            "/private/secret",
            root,
            "agent_session",
            "arguments",
            "exec_command"
          ]
        ) expect(wire).not.toContain(privateValue)
      }).pipe(Effect.scoped))
  })
})

describe("host branch Work task producer", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("isolates fixture and production Git from a hook repository while retaining the exact branch PR reader", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const paths = yield* Path.Path
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "host-work-task-" })
        yield* TestClock.setTime(10)
        const decoy = paths.join(root, "decoy")
        expect(yield* realSpawner.exitCode(makeHostCommand("git", ["init", "-q", "--initial-branch=decoy", decoy])))
          .toBe(0)
        expect(
          yield* realSpawner.exitCode(
            makeHostCommand("git", ["-C", decoy, "config", "remote.origin.url", "https://example.test/decoy.git"])
          )
        ).toBe(0)
        yield* fs.writeFileString(paths.join(decoy, "tracked"), "decoy index sentinel")
        expect(yield* realSpawner.exitCode(makeHostCommand("git", ["-C", decoy, "add", "tracked"]))).toBe(0)
        const configPath = paths.join(decoy, ".git", "config")
        const indexPath = paths.join(decoy, ".git", "index")
        const originalConfig = yield* fs.readFile(configPath)
        const originalIndex = yield* fs.readFile(indexPath)
        // Model inherited hook variables below each command's explicit env, without mutating the test process.
        const spawner = ChildProcessSpawner.make((command) =>
          realSpawner.spawn(
            command._tag === "StandardCommand"
              ? ChildProcess.make(command.command, command.args, {
                ...command.options,
                env: {
                  GIT_DIR: paths.join(decoy, ".git"),
                  GIT_INDEX_FILE: indexPath,
                  GIT_WORK_TREE: decoy,
                  ...command.options.env
                },
                extendEnv: true
              })
              : command
          )
        )
        const repo = paths.join(root, "repo")
        yield* fs.makeDirectory(repo)
        expect(yield* spawner.exitCode(makeHostCommand("git", ["init", "-q", "--initial-branch=feat/fixture", repo])))
          .toBe(0)
        expect(
          yield* spawner.exitCode(
            makeHostCommand("git", [
              "-C",
              repo,
              "config",
              "--local",
              "remote.origin.url",
              "https://github.com/Fixture/Project.git"
            ])
          )
        ).toBe(0)
        const herdrCommand = paths.join(root, "herdr-test")
        const agents = [{ agent: "codex", agent_status: "working", cwd: repo, pane_id: "w1:p1", state_change_seq: 1 }]
        yield* fs.writeFileString(
          herdrCommand,
          `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ result: { agents } })}'\n`
        )
        yield* fs.chmod(herdrCommand, 0o700)
        const operations = yield* makeHostdOperations(
          { ...config(root, ["true"]), herdrCommand, repository: repo },
          ({ defaultOperations }) =>
            Effect.succeed({
              ...defaultOperations,
              listAgents: () => defaultOperations.listAgents()
            })
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
        const rows = (checks: "failing" | "pending"): ReadonlyArray<TaskWorkObservation> => [{
          stale: false,
          unknown: null,
          pullRequest: {
            observedAt: 1,
            confirmedAt: 1,
            fact: Schema.decodeUnknownSync(WorkPullRequestObservation)({
              _tag: "pull_request",
              repository: "fixture/project",
              pullRequest: 12,
              state: "open",
              branch: "feat/fixture",
              head: "a".repeat(40),
              review: "requested",
              checks,
              closedAt: null
            })
          }
        }]
        const { close: closeOld } = yield* attachTaskWorkReader(
          operations.listAgents,
          Effect.succeed({ observed: rows("failing") })
        )
        yield* Effect.addFinalizer(() => closeOld)
        const firstInventory = yield* operations.listAgents()
        expect(yield* fs.readFile(configPath)).toEqual(originalConfig)
        expect(yield* fs.readFile(indexPath)).toEqual(originalIndex)
        expect(yield* spawner.lines(makeHostCommand("git", ["-C", repo, "symbolic-ref", "--short", "HEAD"])))
          .toEqual(["feat/fixture"])
        expect(firstInventory.agents[0]?.taskKind).toBe("failing")
        const { close: closeCurrent } = yield* attachTaskWorkReader(
          operations.listAgents,
          Effect.succeed({ observed: rows("pending") })
        )
        yield* Effect.addFinalizer(() => closeCurrent)
        yield* closeOld
        expect((yield* operations.listAgents()).agents[0]?.taskKind).toBe("waiting")
        yield* closeCurrent
        expect((yield* operations.listAgents()).agents[0]?.taskKind).toBe("unknown")
        const reused = Effect.succeed({ observed: rows("failing") })
        const { close: closeFirstUse } = yield* attachTaskWorkReader(operations.listAgents, reused)
        yield* Effect.addFinalizer(() => closeFirstUse)
        const { close: closeSecondUse } = yield* attachTaskWorkReader(operations.listAgents, reused)
        yield* Effect.addFinalizer(() => closeSecondUse)
        yield* closeFirstUse
        expect((yield* operations.listAgents()).agents[0]?.taskKind).toBe("failing")
        yield* closeSecondUse
        const { close: closeFailed } = yield* attachTaskWorkReader(
          operations.listAgents,
          Effect.fail(new WorkStoreError({ operation: "fixture", cause: "PRIVATE_WORK_FAILURE" }))
        )
        yield* Effect.addFinalizer(() => closeFailed)
        const inventory = yield* operations.listAgents()
        expect(inventory.available).toBe(true)
        expect(inventory.agents[0]?.taskKind).toBe("unknown")
        expect(JSON.stringify(inventory)).not.toContain("PRIVATE_WORK_FAILURE")
        yield* closeFailed
        expect(yield* fs.readFile(configPath)).toEqual(originalConfig)
        expect(yield* fs.readFile(indexPath)).toEqual(originalIndex)
      }).pipe(Effect.scoped))
  })
})
