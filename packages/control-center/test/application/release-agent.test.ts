import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Sink, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { ReleaseId } from "../../src/domain/identifiers.js"
import { PortfolioSnapshots } from "../../src/server/api/ApplicationServices.js"
import { makeReleaseAgentTurns } from "../../src/server/application/releaseAgent.js"
import { makeNodePortfolioSnapshot } from "../fixtures/portfolio.js"

const codexTranscript = (text: string): string =>
  [
    JSON.stringify({ thread_id: "thread-1", type: "thread.started" }),
    JSON.stringify({ item: { text, type: "agent_message" }, type: "item.completed" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } })
  ].join("\n")

const fakeProcessLayer = (
  calls: Array<ChildProcess.Command>
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      calls.push(command)
      const stdout = Stream.make(codexTranscript("Approval is still required.")).pipe(Stream.encodeText)
      const stderr = Stream.empty
      return Effect.succeed(ChildProcessSpawner.makeHandle({
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
      }))
    })
  )

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
      NodeFileSystem.layer
    ]))
  })
})
