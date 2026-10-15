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
  makeFleetService,
  type WorkerStarted
} from "@knpkv/herdr-fleet"
import { Effect, FileSystem, Path, Result, Schema } from "effect"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
