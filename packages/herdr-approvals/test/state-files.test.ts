/**
 * The approval host opens `approval-app.sqlite` once per store — approvals,
 * chat, activity, relationships and Work — so whichever store opens first used
 * to decide what happened to an unsafe state directory: approvals restricted it
 * before Work could refuse it. Every store now goes through the same private
 * opener, so the whole startup refuses a directory others could write and
 * leaves it as found, restricts a merely readable one, and ends with
 * owner-only database files.
 */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { type HostConfiguration, type HostOperations, JobStore, makeFleetService } from "@knpkv/herdr-fleet"
import { Effect } from "effect"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type UiAssets } from "../src/http.js"

// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const config = (stateDirectory: string): HostConfiguration => ({
  allowedUsers: ["andrey@example.com"],
  applyCommand: null,
  browserMcpRecoverCommand: null,
  applyMachines: ["SER8"],
  approvalHub: { host: "SER8", nodeId: "node-ser8", url: "https://ser8.example.test:4779/" },
  approvalNodes: ["node-ser8"],
  approvalPort: 4779,
  checkCommand: ["nix", "flake", "check"],
  coordinatorCommand: ["coordinator"],
  crossHost: false,
  herdrCommand: "herdr",
  host: "SER8",
  localPort: 0,
  machines: [{ host: "SER8", nodeId: "node-ser8" }],
  port: 0,
  pushAllowedOrigins: [],
  pushSubject: "mailto:andrey@example.com",
  repository: "/repo",
  approvalTls: null,
  stateDirectory,
  tailscaleCommand: "tailscale"
})

const operations: HostOperations = {
  inspect: () =>
    Effect.succeed({ applyConfigured: false, branch: "main", dirty: false, repository: "/repo", revision: "abc" }),
  listAgents: () => Effect.succeed({ agents: [], available: true, error: null }),
  run: (payload) => Effect.succeed(`${payload.kind}: ok`),
  runLocal: (payload) => Effect.succeed(`${payload.kind}: ok`),
  runCoordinatorChat: () => Effect.succeed("coordinator: ok")
}

const assets: UiAssets = {
  connectScript: "",
  fonts: new Map([["test.woff2", new Uint8Array([1])]]),
  script: "",
  stylesheet: "",
  worker: ""
}

const mode = (path: string) => statSync(path).mode & 0o777

// Starts the approval host on `stateDirectory`, with the job store kept in a
// separate private directory so only the approval-app state is under test.
const startOn = (root: string, stateDirectory: string) =>
  Effect.gen(function*() {
    const jobStore = yield* JobStore.open(join(root, "jobs", "jobs.sqlite"))
    yield* Effect.addFinalizer(() => Effect.sync(() => jobStore.close()))
    const fleet = yield* makeFleetService({ approvalEnabled: false, host: "SER8", operations, store: jobStore })
    type Outcome = "started" | "refused"
    return yield* Effect.promise((): Promise<Outcome> =>
      startHttpServer(config(stateDirectory), fleet, assets).then(
        async (running) => {
          await running.close()
          return "started"
        },
        () => "refused"
      )
    )
  })

const tempRoot = Effect.acquireRelease(
  Effect.sync(() => {
    const root = mkdtempSync(join(tmpdir(), "herdr-approvals-state-"))
    chmodSync(root, 0o700)
    return root
  }),
  (root) => Effect.sync(() => rmSync(root, { force: true, recursive: true }))
)

describe("approval host state files", () => {
  it.effect("restricts a readable state directory and leaves the database owner-only", () =>
    Effect.gen(function*() {
      if (platform() === "win32") return
      const root = yield* tempRoot
      const stateDirectory = join(root, "state")
      mkdirSync(stateDirectory)
      chmodSync(stateDirectory, 0o755)

      expect(yield* startOn(root, stateDirectory)).toBe("started")

      expect(mode(stateDirectory)).toBe(0o700)
      const database = join(stateDirectory, "approval-app.sqlite")
      for (const file of [database, `${database}-wal`, `${database}-shm`]) {
        if (existsSync(file)) expect(mode(file)).toBe(0o600)
      }
    }).pipe(Effect.scoped, provideNodeServices))

  it.effect("refuses a group-writable state directory before any store repairs it", () =>
    Effect.gen(function*() {
      if (platform() === "win32") return
      const root = yield* tempRoot
      const stateDirectory = join(root, "state")
      mkdirSync(stateDirectory)
      chmodSync(stateDirectory, 0o775)

      expect(yield* startOn(root, stateDirectory)).toBe("refused")

      expect(mode(stateDirectory)).toBe(0o775)
      expect(existsSync(join(stateDirectory, "approval-app.sqlite"))).toBe(false)
    }).pipe(Effect.scoped, provideNodeServices))
})
