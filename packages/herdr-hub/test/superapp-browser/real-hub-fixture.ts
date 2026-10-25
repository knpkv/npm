/** The real hub on its Tailscale listener over TLS, with one job waiting for approval; only Tailscale is a script. */
import { NodeServices } from "@effect/platform-node"
import {
  AgentInventory,
  type HostConfiguration,
  type HostOperations,
  JobStore,
  makeFleetService
} from "@knpkv/herdr-fleet"
import { test as base, type TestInfo } from "@playwright/test"
import { Effect, FileSystem, ManagedRuntime, Schema } from "effect"
import { playwrightPort } from "../../../../playwright-ports.js"
import { startHttpServer } from "../../src/http.js"
import { loadUiAssets } from "../../src/internal/ui-assets.js"

class RealHubFixtureError extends Schema.TaggedError<RealHubFixtureError>()("RealHubFixtureError", {
  reason: Schema.String
}) {}

export interface RealHub {
  readonly origin: string
  /** The job waiting for approval, as the dashboard names it. */
  readonly jobId: string
}

const serveHub = Effect.fn("RealHub.serve")(function*(info: TestInfo, use: (hub: RealHub) => Promise<void>) {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ directory: info.outputPath("."), prefix: "hub-" })
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
  const port = yield* Effect.promise(() => playwrightPort("PLAYWRIGHT_REAL_HUB_PORT"))
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
  const operations: HostOperations = {
    inspect: () =>
      Effect.succeed({
        applyConfigured: false,
        repository: { branch: "main", dirty: false, path: root, revision: "fixture" }
      }),
    listAgents: () =>
      Schema.decodeUnknownEffect(AgentInventory)({ agents: [], available: true, error: null }).pipe(Effect.orDie),
    run: () => Effect.succeed("done"),
    runLocal: () => Effect.succeed("done"),
    runCoordinatorChat: () => Effect.succeed("done")
  }
  const store = yield* Effect.acquireRelease(
    JobStore.open(`${root}/jobs.sqlite`),
    (value) => Effect.sync(() => value.close())
  )
  const fleet = yield* makeFleetService({ approvalEnabled: true, host: config.host, operations, store })
  const pending = yield* fleet.submit(
    { payload: { kind: "agent.delegate", mode: "work", prompt: "Review the fixture", repository: root } },
    "submitter@example.test"
  )
  const assets = yield* loadUiAssets(new URL("../../dist/", import.meta.url).pathname)
  yield* Effect.acquireRelease(
    Effect.promise(() => startHttpServer(config, fleet, assets)),
    (server) => Effect.promise(server.close)
  )
  yield* Effect.promise(() => use({ origin, jobId: pending.id }))
})

/** The real hub around Playwright's use callback; nothing outlives the test. */
export const test = base.extend<{ hub: RealHub }>({
  hub: async ({ browserName }, use, info) => {
    if (browserName !== "chromium") throw new RealHubFixtureError({ reason: "the real hub runs in Chromium" })
    const runtime = ManagedRuntime.make(NodeServices.layer)
    try {
      await runtime.runPromise(Effect.scoped(serveHub(info, use)))
    } finally {
      await runtime.dispose()
    }
  }
})
