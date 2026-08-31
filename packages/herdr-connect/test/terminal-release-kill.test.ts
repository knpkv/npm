import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { HostConfiguration, HostOperations } from "@knpkv/herdr-fleet"
import { JobStore, makeFleetService } from "@knpkv/herdr-fleet"
import { Effect, Fiber, FileSystem, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { KillOptions } from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { join } from "node:path"
import { makeHerdrTerminalConnector } from "../src/terminal.js"

// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)
// @effect-diagnostics-next-line strictEffectProvide:off
const provideTestClock = Effect.provide(TestClock.layer())

const configuration = (root: string): HostConfiguration => ({
  allowedUsers: ["andrey@example.com"],
  applyCommand: ["true"],
  browserMcpRecoverCommand: null,
  applyMachines: ["SER8"],
  approvalHub: { host: "SER8", nodeId: "hub-node", url: "https://ser8.example.test:4779/" },
  approvalNodes: ["phone-node"],
  approvalPort: 4779,
  checkCommand: ["true"],
  coordinatorCommand: ["true"],
  crossHost: true,
  herdrCommand: "herdr",
  host: "SER8",
  localPort: 4778,
  machines: [{ host: "SER8", nodeId: "node-ser8" }],
  port: 4777,
  pushAllowedOrigins: ["https://push.example.test"],
  pushSubject: "mailto:andrey@example.com",
  repository: root,
  approvalTls: null,
  stateDirectory: root,
  tailscaleCommand: "true"
})

const operations: HostOperations = {
  inspect: () =>
    Effect.succeed({
      applyConfigured: true,
      branch: "main",
      dirty: false,
      repository: "/tmp",
      revision: "abc123"
    }),
  listAgents: () =>
    Effect.succeed({
      agents: [{
        agentId: "agent-test",
        activityRevision: 1,
        kind: "codex",
        name: "Worker",
        paneId: "w1:p1",
        parentAgentId: null,
        relation: null,
        status: "working",
        work: "npm"
      }],
      available: true,
      error: null
    }),
  run: () => Effect.succeed("ok"),
  runLocal: () => Effect.succeed("ok"),
  runCoordinatorChat: () => Effect.succeed("ok")
}

describe("Herdr terminal release", () => {
  it.effect("uses an immediate kill after a timed-out release", () => {
    const program = Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "herdr-connect-release-test-"
        })
        let observedKillOptions: KillOptions | undefined
        const spawner = ChildProcessSpawner.make(() => {
          const stdout = Stream.make(
            `${
              JSON.stringify({
                bytes: "b2s=",
                encoding: "ansi",
                full: true,
                height: 30,
                seq: 1,
                type: "terminal.frame",
                width: 100
              })
            }\n`
          ).pipe(Stream.encodeText)
          return Effect.succeed(ChildProcessSpawner.makeHandle({
            all: stdout,
            exitCode: Effect.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            isRunning: Effect.succeed(true),
            kill: (options) =>
              Effect.sync(() => {
                observedKillOptions = options
              }),
            pid: ChildProcessSpawner.ProcessId(42),
            reref: Effect.void,
            stderr: Stream.empty,
            stdin: Sink.drain,
            stdout,
            unref: Effect.succeed(Effect.void)
          }))
        })
        const config = configuration(root)
        return yield* Effect.acquireUseRelease(
          JobStore.open(join(root, "jobs.sqlite")),
          (store) =>
            Effect.gen(function*() {
              const service = yield* makeFleetService({
                approvalEnabled: true,
                host: config.host,
                operations,
                store
              })
              const connector = yield* makeHerdrTerminalConnector(config, service)
              const sessionFiber = yield* Effect.forkChild(
                Effect.scoped(
                  Effect.gen(function*() {
                    const session = yield* connector.open({
                      agentId: "agent-test",
                      cols: 100,
                      host: config.host,
                      rows: 30
                    })
                    yield* Stream.runHead(session.events)
                  })
                ),
                { startImmediately: true }
              )
              yield* TestClock.adjust("1 second")
              yield* Fiber.join(sessionFiber)
              expect(observedKillOptions).toEqual({ killSignal: "SIGKILL" })
            }),
          (store) => Effect.sync(() => store.close())
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      })
    )
    return program.pipe(provideNodeServices, provideTestClock)
  })
})
