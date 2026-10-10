import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { HostConfiguration, HostOperations } from "@knpkv/herdr-fleet"
import { JobStore, makeFleetService } from "@knpkv/herdr-fleet"
import { Effect, FileSystem, Sink, Stream } from "effect"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { join } from "node:path"
import { makeHerdrTerminalConnector, terminalStderrMaxBytes } from "../src/terminal.js"

// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const configuration = (root: string): HostConfiguration => ({
  allowedUsers: ["owner@example.com"],
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
  pushSubject: "mailto:owner@example.com",
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

/**
 * The attach client's stderr is drained under a byte budget so a noisy client
 * cannot grow memory without bound; crossing it ends the terminal session with
 * a transport error naming the budget.
 */
describe("Herdr terminal stderr budget", () => {
  it.effect("ends the session when the attach client's stderr exceeds its budget", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "herdr-connect-stderr-test-" })
        const half = new Uint8Array(terminalStderrMaxBytes / 2 + 1)
        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(ChildProcessSpawner.makeHandle({
            all: Stream.never,
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            pid: ChildProcessSpawner.ProcessId(42),
            stderr: Stream.make(half, half),
            stdin: Sink.drain,
            stdout: Stream.never,
            unref: Effect.succeed(Effect.void)
          }))
        )
        const config = configuration(root)
        const error = yield* Effect.acquireUseRelease(
          JobStore.open(join(root, "jobs.sqlite")),
          (store) =>
            Effect.gen(function*() {
              const service = yield* makeFleetService({ approvalEnabled: true, host: config.host, operations, store })
              const connector = yield* makeHerdrTerminalConnector(config, service)
              return yield* Effect.scoped(
                connector.open({ agentId: "agent-test", cols: 100, host: config.host, rows: 30 }).pipe(
                  Effect.flatMap((session) => Stream.runDrain(session.events)),
                  Effect.flip
                )
              )
            }),
          (store) => Effect.sync(() => store.close())
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

        expect(error).toMatchObject({
          _tag: "TerminalTransportError",
          cause: terminalStderrMaxBytes + 2,
          detail: `Herdr terminal stderr exceeded ${terminalStderrMaxBytes} bytes`,
          operation: "herdr.terminal.stderr"
        })
      })
    ).pipe(provideNodeServices))
})
