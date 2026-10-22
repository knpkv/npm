/** Real authorized HTTP/WebSocket listener, with only inventory and terminal resources substituted. */
import { NodeServices } from "@effect/platform-node"
import { TerminalAgentNotFoundError, type TerminalConnector } from "@knpkv/herdr-connect"
import {
  AgentInventory,
  type HostConfiguration,
  type HostOperations,
  JobStore,
  makeFleetService
} from "@knpkv/herdr-fleet"
import { test as base, type TestInfo } from "@playwright/test"
import { Clock, Deferred, Effect, FileSystem, ManagedRuntime, Ref, Schema, Stream } from "effect"
import { playwrightPort } from "../../../../playwright-ports.js"
import { startHttpServer } from "../../src/http.js"
import { loadUiAssets } from "../../src/internal/ui-assets.js"

class TerminalWalkFixtureError extends Schema.TaggedError<TerminalWalkFixtureError>()("TerminalWalkFixtureError", {
  reason: Schema.String
}) {}

interface FixtureState {
  readonly revision: number
  readonly detached: boolean
  readonly gate: Deferred.Deferred<void> | null
  readonly holding: boolean
  readonly opened: number
  readonly released: number
}

export interface TerminalWalkHub {
  readonly origin: string
  readonly holdCleanup: () => Promise<void>
  readonly releaseCleanup: () => Promise<void>
  readonly detach: () => Promise<void>
  readonly refreshInventory: () => Promise<number>
  readonly snapshot: () => Promise<Omit<FixtureState, "gate">>
  readonly writeArtifact: (name: string, body: string) => Promise<void>
}

const serveWalk = Effect.fn("TerminalWalk.serve")(
  function*(info: TestInfo, use: (hub: TerminalWalkHub) => Promise<void>) {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ directory: info.outputPath("."), prefix: "server-" })
    yield* fs.chmod(root, 0o700)
    const tailscaleCommand = `${root}/tailscale-fixture`
    yield* fs.writeFileString(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\\n' '127.0.0.1' ;;
  whois) printf '%s\\n' '{"Node":{"StableID":"node-atlas"},"UserProfile":{"LoginName":"owner@example.test"}}' ;;
  status) printf '%s\\n' '{"Peer":{},"Self":{"HostName":"atlas","ID":"node-atlas","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`
    )
    yield* fs.chmod(tailscaleCommand, 0o700)
    const port = yield* Effect.promise(() => playwrightPort("PLAYWRIGHT_TERMINAL_WALK_PORT"))
    const origin = `https://127.0.0.1:${String(port)}`
    const config: HostConfiguration = {
      allowedUsers: ["owner@example.test"],
      applyCommand: null,
      browserMcpRecoverCommand: null,
      applyMachines: ["atlas"],
      approvalHub: { host: "atlas", nodeId: "node-atlas", url: `${origin}/` },
      approvalNodes: ["node-atlas"],
      approvalPort: port,
      approvalTls: {
        certificatePath: new URL("../fixtures/ser8.example.test.crt", import.meta.url).pathname,
        privateKeyPath: new URL("../fixtures/ser8.example.test.key", import.meta.url).pathname
      },
      checkCommand: ["unused-check"],
      coordinatorCommand: ["unused-coordinator"],
      crossHost: true,
      herdrCommand: "unused-herdr",
      host: "atlas",
      localPort: 0,
      machines: [{ host: "atlas", nodeId: "node-atlas" }],
      port: 0,
      pushAllowedOrigins: ["https://push.example.test"],
      pushSubject: "mailto:owner@example.test",
      repository: root,
      stateDirectory: root,
      tailscaleCommand
    }
    const state = yield* Ref.make<FixtureState>({
      revision: 1,
      detached: false,
      gate: null,
      holding: false,
      opened: 0,
      released: 0
    })
    const operations: HostOperations = {
      inspect: () =>
        Effect.succeed({
          applyConfigured: false,
          repository: { branch: "main", dirty: false, path: root, revision: "fixture" }
        }),
      listAgents: () =>
        Ref.get(state).pipe(
          Effect.flatMap(({ revision }) =>
            Schema.decodeUnknownEffect(AgentInventory)({
              agents: [{
                agentId: "agent-terminal",
                activityRevision: revision,
                kind: "claude",
                name: "Worker",
                paneId: "w1:p1",
                parentAgentId: null,
                relation: null,
                status: "waiting",
                work: `Inventory reading ${String(revision)}`
              }],
              available: true,
              error: null
            })
          ),
          Effect.orDie
        ),
      run: () => Effect.die(new TerminalWalkFixtureError({ reason: "unexpected job" })),
      runLocal: () => Effect.die(new TerminalWalkFixtureError({ reason: "unexpected local job" })),
      runCoordinatorChat: () => Effect.die(new TerminalWalkFixtureError({ reason: "unexpected coordinator" }))
    }
    const connector: TerminalConnector = {
      open: (selection) =>
        Effect.gen(function*() {
          if ((yield* Ref.get(state)).detached) {
            return yield* new TerminalAgentNotFoundError({ agentId: selection.agentId, host: selection.host })
          }
          return yield* Effect.acquireRelease(
            Ref.update(state, (value) => ({ ...value, opened: value.opened + 1 })).pipe(
              Effect.as({ events: Stream.never, send: () => Effect.void })
            ),
            () =>
              Effect.gen(function*() {
                const gate = (yield* Ref.get(state)).gate
                if (gate !== null) {
                  yield* Ref.update(state, (value) => ({ ...value, holding: true }))
                  yield* Deferred.await(gate)
                }
                yield* Ref.update(state, (value) => ({ ...value, holding: false, released: value.released + 1 }))
              })
          )
        })
    }
    const store = yield* Effect.acquireRelease(
      JobStore.open(`${root}/jobs.sqlite`),
      (value) => Effect.sync(() => value.close())
    )
    const fleet = yield* makeFleetService({ approvalEnabled: false, host: config.host, operations, store })
    const assets = yield* loadUiAssets(new URL("../../dist/", import.meta.url).pathname)
    yield* Effect.acquireRelease(
      Effect.promise(() => startHttpServer(config, fleet, assets, { terminalConnector: connector })),
      (server) => Effect.promise(server.close)
    )
    const releaseCleanup = Effect.fn("TerminalWalk.releaseCleanup")(function*() {
      const gate = (yield* Ref.get(state)).gate
      yield* Ref.update(state, (value) => ({ ...value, gate: null }))
      if (gate !== null) yield* Deferred.succeed(gate, undefined)
    })
    // Unblock held cleanup before closing the server, including when a browser assertion fails.
    yield* Effect.addFinalizer(() => releaseCleanup())
    const run = Effect.runPromiseWith(yield* Effect.context<never>())
    yield* Effect.promise(() =>
      use({
        origin,
        holdCleanup: () =>
          run(Effect.gen(function*() {
            if ((yield* Ref.get(state)).gate !== null) {
              return yield* new TerminalWalkFixtureError({ reason: "cleanup already held" })
            }
            const gate = yield* Deferred.make<void>()
            yield* Ref.update(state, (value) => ({ ...value, gate }))
          })),
        releaseCleanup: () => run(releaseCleanup()),
        detach: () => run(Ref.update(state, (value) => ({ ...value, detached: true }))),
        refreshInventory: () =>
          run(
            Ref.updateAndGet(state, (value) => ({ ...value, revision: value.revision + 1 })).pipe(
              Effect.map((value) => value.revision)
            )
          ),
        snapshot: () =>
          run(Effect.gen(function*() {
            const { detached, holding, opened, released, revision } = yield* Ref.get(state)
            return { revision, detached, holding, opened, released, observedAt: yield* Clock.currentTimeMillis }
          })),
        writeArtifact: (name, body) => run(fs.writeFileString(info.outputPath(name), body))
      })
    )
  }
)

/** Keep the real server alive around Playwright's use callback; no resource outlives the fixture. */
export const test = base.extend<{ hub: TerminalWalkHub }>({
  hub: async ({ browserName }, use, info) => {
    if (browserName !== "chromium") throw new TerminalWalkFixtureError({ reason: "walk requires Chromium" })
    const runtime = ManagedRuntime.make(NodeServices.layer)
    try {
      await runtime.runPromise(Effect.scoped(serveWalk(info, use)))
    } finally {
      await runtime.dispose()
    }
  }
})
