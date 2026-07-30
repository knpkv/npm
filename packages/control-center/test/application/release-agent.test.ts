import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref, Result, Sink, Stream } from "effect"
import * as Schema from "effect/Schema"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { WorkspaceSettingsReadModel } from "../../src/api/workspaceSettings.js"
import { ReleaseId } from "../../src/domain/identifiers.js"
import { DEFAULT_WORKSPACE_SETTINGS } from "../../src/domain/workspaceSettings.js"
import { PortfolioSnapshots, WorkspaceSettingsAdministration } from "../../src/server/api/ApplicationServices.js"
import { makeReleaseAgentTurns } from "../../src/server/application/releaseAgent.js"
import { makeNodePortfolioSnapshot } from "../fixtures/portfolio.js"

const codexTranscript = (text: string): string =>
  [
    JSON.stringify({ thread_id: "thread-1", type: "thread.started" }),
    JSON.stringify({ item: { text, type: "agent_message" }, type: "item.completed" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } })
  ].join("\n")

const fakeProcessHandle = () => {
  const stdout = Stream.make(codexTranscript("Approval is still required.")).pipe(Stream.encodeText)
  const stderr = Stream.empty
  return ChildProcessSpawner.makeHandle({
    all: stdout,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    pid: ChildProcessSpawner.ProcessId(42),
    stderr,
    stdin: Sink.drain,
    stdout,
    unref: Effect.succeed(Effect.void)
  })
}

const fakeProcessLayer = (
  calls: Array<ChildProcess.Command>
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      calls.push(command)
      return Effect.succeed(fakeProcessHandle())
    })
  )

const workspaceSettingsReadModel = (
  allowedProviders: ReadonlyArray<"claude" | "codex"> = ["codex"]
): typeof WorkspaceSettingsReadModel.Type => {
  const snapshot = makeNodePortfolioSnapshot()
  return Schema.decodeUnknownSync(WorkspaceSettingsReadModel)({
    workspaceId: snapshot.workspaceId,
    revision: 1,
    etag: "\"workspace-settings-v1-1\"",
    settings: {
      ...DEFAULT_WORKSPACE_SETTINGS,
      agent: {
        ...DEFAULT_WORKSPACE_SETTINGS.agent,
        allowedProviders,
        defaultProvider: allowedProviders[0] ?? null
      }
    },
    createdAt: "2026-07-14T10:16:00.000Z",
    updatedAt: "2026-07-14T10:16:00.000Z",
    updatedByPersonId: null
  })
}

const workspaceSettingsLayer = (
  allowedProviders: ReadonlyArray<"claude" | "codex"> = ["codex"]
): Layer.Layer<WorkspaceSettingsAdministration> => {
  const readModel = workspaceSettingsReadModel(allowedProviders)
  return Layer.succeed(WorkspaceSettingsAdministration, {
    read: () => Effect.succeed(readModel),
    update: () => Effect.die("workspace settings updates are outside this test")
  })
}

const gatedProcessLayer = (
  calls: Array<ChildProcess.Command>,
  occupied: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        calls.push(command)
        return calls.length
      }).pipe(
        Effect.tap((callCount) =>
          callCount === 2
            ? Deferred.succeed(occupied, undefined)
            : Effect.void
        ),
        Effect.andThen(Deferred.await(release)),
        Effect.as(fakeProcessHandle())
      )
    )
  )

const admissionPolicyScenario = (
  allowedAfterQueue: ReadonlyArray<"claude" | "codex">
) =>
  Effect.gen(function*() {
    const calls: Array<ChildProcess.Command> = []
    const occupied = yield* Deferred.make<void>()
    const releaseProcesses = yield* Deferred.make<void>()
    const allowedProviders = yield* Ref.make<ReadonlyArray<"claude" | "codex">>([
      "codex"
    ])
    const settings = WorkspaceSettingsAdministration.of({
      read: () => Ref.get(allowedProviders).pipe(Effect.map(workspaceSettingsReadModel)),
      update: () => Effect.die("workspace settings updates are outside this test")
    })
    const snapshot = makeNodePortfolioSnapshot()
    const release = snapshot.releases[0]
    if (release === undefined) return yield* Effect.die("release fixture is missing")
    const agent = yield* makeReleaseAgentTurns({
      cwd: "/workspace",
      enabledProviders: ["codex"]
    }).pipe(Effect.provide([
      Layer.succeed(PortfolioSnapshots, { snapshot: () => Effect.succeed(snapshot) }),
      gatedProcessLayer(calls, occupied, releaseProcesses),
      Layer.succeed(WorkspaceSettingsAdministration, settings),
      NodeFileSystem.layer
    ]))
    const input = {
      history: [],
      prompt: "Can this ship?",
      provider: "codex",
      releaseId: release.releaseId,
      workspaceId: snapshot.workspaceId
    } satisfies Parameters<typeof agent.runTurn>[0]

    const first = yield* agent.runTurn(input).pipe(
      Effect.forkChild({ startImmediately: true })
    )
    const second = yield* agent.runTurn(input).pipe(
      Effect.forkChild({ startImmediately: true })
    )
    yield* Deferred.await(occupied)
    const queued = yield* agent.runTurn(input).pipe(
      Effect.forkChild({ startImmediately: true })
    )
    yield* Effect.yieldNow
    yield* Effect.yieldNow
    assert.strictEqual(calls.length, 2)
    yield* Ref.set(allowedProviders, allowedAfterQueue)
    yield* Deferred.succeed(releaseProcesses, undefined)
    yield* Fiber.join(first)
    yield* Fiber.join(second)
    const queuedResult = yield* Fiber.join(queued).pipe(Effect.result)
    return { calls, queuedResult }
  })

describe("release agent application", () => {
  it.effect("projects the exact release into a read-only ephemeral Codex turn", () => {
    const calls: Array<ChildProcess.Command> = []
    return Effect.gen(function*() {
      const snapshot = makeNodePortfolioSnapshot()
      const release = snapshot.releases[0]
      if (release === undefined) return yield* Effect.die("release fixture is missing")

      const agent = yield* makeReleaseAgentTurns({ cwd: "/workspace", enabledProviders: ["codex"] })
      const response = yield* agent.runTurn({
        history: [],
        prompt: "Can this ship?",
        provider: "codex",
        releaseId: release.releaseId,
        workspaceId: snapshot.workspaceId
      })

      assert.strictEqual(response.reply, "Approval is still required.")
      assert.strictEqual(response.release.relay.codename, release.relay.codename)
      assert.strictEqual(calls.length, 1)
      const command = calls[0]
      assert.isTrue(command !== undefined && ChildProcess.isStandardCommand(command))
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        assert.include(command.args, "read-only")
        assert.include(command.args, "--ephemeral")
      }
    }).pipe(Effect.provide([
      Layer.succeed(PortfolioSnapshots, { snapshot: () => Effect.succeed(makeNodePortfolioSnapshot()) }),
      fakeProcessLayer(calls),
      workspaceSettingsLayer(),
      NodeFileSystem.layer
    ]))
  })

  it.effect("does not start a provider process for an unknown workspace release", () => {
    const calls: Array<ChildProcess.Command> = []
    return Effect.gen(function*() {
      const snapshot = makeNodePortfolioSnapshot()
      const agent = yield* makeReleaseAgentTurns({ cwd: "/workspace", enabledProviders: ["codex"] })
      const result = yield* Effect.result(agent.runTurn({
        history: [],
        prompt: "Can this ship?",
        provider: "codex",
        releaseId: ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000099"),
        workspaceId: snapshot.workspaceId
      }))

      assert.isTrue(result._tag === "Failure" && result.failure._tag === "ApplicationResourceNotFound")
      assert.strictEqual(calls.length, 0)
    }).pipe(Effect.provide([
      Layer.succeed(PortfolioSnapshots, { snapshot: () => Effect.succeed(makeNodePortfolioSnapshot()) }),
      fakeProcessLayer(calls),
      workspaceSettingsLayer(),
      NodeFileSystem.layer
    ]))
  })

  it.effect("does not substitute another enabled provider for the requested provider", () => {
    const calls: Array<ChildProcess.Command> = []
    return Effect.gen(function*() {
      const snapshot = makeNodePortfolioSnapshot()
      const release = snapshot.releases[0]
      if (release === undefined) return yield* Effect.die("release fixture is missing")

      const agent = yield* makeReleaseAgentTurns({ cwd: "/workspace", enabledProviders: ["codex"] })
      const result = yield* Effect.result(agent.runTurn({
        history: [],
        prompt: "Can this ship?",
        provider: "claude",
        releaseId: release.releaseId,
        workspaceId: snapshot.workspaceId
      }))

      assert.isTrue(result._tag === "Failure" && result.failure._tag === "ApplicationServiceUnavailable")
      assert.strictEqual(calls.length, 0)
    }).pipe(Effect.provide([
      Layer.succeed(PortfolioSnapshots, { snapshot: () => Effect.succeed(makeNodePortfolioSnapshot()) }),
      fakeProcessLayer(calls),
      workspaceSettingsLayer(),
      NodeFileSystem.layer
    ]))
  })

  it.effect("does not start a configured provider after workspace policy revokes it", () => {
    const calls: Array<ChildProcess.Command> = []
    return Effect.gen(function*() {
      const snapshot = makeNodePortfolioSnapshot()
      const release = snapshot.releases[0]
      if (release === undefined) return yield* Effect.die("release fixture is missing")

      const agent = yield* makeReleaseAgentTurns({ cwd: "/workspace", enabledProviders: ["codex"] })
      const result = yield* Effect.result(agent.runTurn({
        history: [],
        prompt: "Can this ship?",
        provider: "codex",
        releaseId: release.releaseId,
        workspaceId: snapshot.workspaceId
      }))

      assert.isTrue(result._tag === "Failure" && result.failure._tag === "ApplicationInvalidRequest")
      assert.strictEqual(calls.length, 0)
    }).pipe(Effect.provide([
      Layer.succeed(PortfolioSnapshots, { snapshot: () => Effect.succeed(makeNodePortfolioSnapshot()) }),
      fakeProcessLayer(calls),
      workspaceSettingsLayer(["claude"]),
      NodeFileSystem.layer
    ]))
  })

  it.effect("rechecks provider policy after a queued turn acquires admission", () =>
    admissionPolicyScenario(["claude"]).pipe(
      Effect.map(({ calls, queuedResult }) => {
        assert.strictEqual(calls.length, 2)
        assert.isTrue(Result.isFailure(queuedResult))
        if (Result.isFailure(queuedResult)) {
          assert.strictEqual(queuedResult.failure._tag, "ApplicationInvalidRequest")
        }
      })
    ))

  it.effect("runs one queued turn when its provider remains allowed", () =>
    admissionPolicyScenario(["codex"]).pipe(
      Effect.map(({ calls, queuedResult }) => {
        assert.strictEqual(calls.length, 3)
        assert.isTrue(Result.isSuccess(queuedResult))
        if (Result.isSuccess(queuedResult)) {
          assert.strictEqual(queuedResult.success.provider, "codex")
        }
      })
    ))
})
