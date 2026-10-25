import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { TerminalConnector } from "@knpkv/herdr-connect"
import { type HostConfiguration, type HostOperations, JobStore, makeFleetService } from "@knpkv/herdr-fleet"
import { makeWorkService, type WorkGoalCheckpoint, type WorkPullRequestAttach, WorkStore } from "@knpkv/herdr-work"
import { Effect } from "effect"
import { build } from "esbuild"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer } from "../src/http.js"
import { workPullRequestAttachFromJson, workPullRequestAttachUrl } from "../src/work-checkpoint.js"

const config = (root: string): HostConfiguration => ({
  allowedUsers: ["owner@example.test"],
  applyCommand: null,
  applyMachines: ["ALPHA"],
  approvalHub: { host: "ALPHA", nodeId: "node-alpha", url: "https://alpha.example.test:4779/" },
  approvalNodes: ["node-phone"],
  approvalPort: 4779,
  approvalTls: null,
  browserMcpRecoverCommand: null,
  checkCommand: ["nix", "flake", "check"],
  coordinatorCommand: ["coordinator"],
  crossHost: false,
  herdrCommand: "herdr",
  host: "ALPHA",
  localPort: 0,
  machines: [{ host: "ALPHA", nodeId: "node-alpha" }, { host: "BETA", nodeId: "node-beta" }],
  port: 0,
  pushAllowedOrigins: ["https://push.example.test"],
  pushSubject: "mailto:owner@example.test",
  repository: "/repo",
  stateDirectory: root,
  tailscaleCommand: "tailscale"
})
const operations: HostOperations = {
  inspect: () =>
    Effect.succeed({
      applyConfigured: false,
      repository: { branch: "main", dirty: false, path: "/repo", revision: "abc123" }
    }),
  listAgents: () => Effect.succeed({ agents: [], available: true, error: null }),
  run: () => Effect.die("no job execution expected"),
  runLocal: () => Effect.die("no job execution expected"),
  runCoordinatorChat: () => Effect.die("no chat expected")
}
const terminal: TerminalConnector = { open: () => Effect.die("no terminal expected") }
const assets = {
  connectScript: "",
  fonts: new Map<string, Uint8Array>(),
  icon: () => Promise.resolve(null),
  script: "",
  stylesheet: "",
  worker: ""
}
const original: WorkGoalCheckpoint = {
  version: "herdr.work.event.v1",
  eventId: "created",
  occurredAt: 1_000,
  goal: {
    id: "goal-attach",
    title: "Attach PR",
    summary: "Protect updates",
    detail: "Transport fixture",
    state: "working",
    owner: { id: "coordinator", name: "Coordinator" },
    repository: { repository: "example/project", branch: "feat/attach" },
    spend: null,
    delivery: "local",
    blocker: null,
    connectTarget: null,
    createdAt: 1_000,
    updatedAt: 1_000
  }
}
const input: WorkPullRequestAttach = {
  goalId: original.goal.id,
  expectedGoalEventId: original.eventId,
  branch: "feat/attach",
  repository: "example/project",
  head: "a".repeat(40),
  reviewUrl: "https://github.com/example/project/pull/7",
  occurredAt: 3_000,
  eventId: "attached"
}
const fixture = Effect.gen(function*() {
  const root = mkdtempSync(join(tmpdir(), "hub-work-attach-"))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { recursive: true, force: true })))
  const configuration = config(root)
  const store = yield* Effect.acquireRelease(
    WorkStore.open(join(root, "approval-app.sqlite")),
    (opened) => Effect.sync(() => opened.close())
  )
  const work = yield* makeWorkService(store)
  yield* work.record(original)
  const jobs = yield* Effect.acquireRelease(
    JobStore.open(join(root, "jobs.sqlite")),
    (opened) => Effect.sync(() => opened.close())
  )
  const fleet = yield* makeFleetService({ approvalEnabled: false, host: configuration.host, operations, store: jobs })
  const server = yield* Effect.acquireRelease(
    Effect.promise(() => startHttpServer(configuration, fleet, assets, { terminalConnector: terminal })),
    (running) => Effect.promise(running.close)
  )
  expect(server.workUrl).not.toBeNull()
  const workUrl = server.workUrl ?? ""
  const cliConfiguration = {
    ...configuration,
    port: Number(new URL(workUrl).port),
    localPort: Number(new URL(server.url).port)
  }
  return { root, configuration: cliConfiguration, store, workUrl }
})

const runCli = (
  entry: string,
  configPath: string,
  request: WorkPullRequestAttach
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, "work", "attach-pr", "ALPHA", JSON.stringify(request)], {
      env: { ...process.env, FLEET_CONFIG_PATH: configPath }
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })

describe("work attach-pr transport", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("validates narrow input and uses the same listener targeting as work record", () =>
      Effect.gen(function*() {
        const local = { ...config("/state"), port: 4778 }
        expect(yield* workPullRequestAttachFromJson(JSON.stringify(input))).toEqual(input)
        expect(yield* workPullRequestAttachUrl(local, "alpha")).toBe("http://127.0.0.1:4778/v1/work/attach-pr")
        expect(yield* workPullRequestAttachUrl({ ...local, crossHost: true }, "ALPHA"))
          .toBe("https://alpha.example.test:4779/v1/work/attach-pr")
        for (
          const invalid of [
            "{",
            JSON.stringify({ ...input, goal: original.goal }),
            JSON.stringify({ ...input, head: "main" })
          ]
        ) {
          expect(yield* Effect.result(workPullRequestAttachFromJson(invalid))).toMatchObject({
            failure: { _tag: "FleetValidationError" }
          })
        }
        for (const configuration of [local, { ...local, crossHost: true }]) {
          expect(yield* Effect.result(workPullRequestAttachUrl(configuration, "BETA")))
            .toMatchObject({ failure: { _tag: "FleetValidationError" } })
        }
      }))

    it.effect("routes attachments and typed conflicts, rejects browser origins and widened bodies", () =>
      Effect.gen(function*() {
        const { store, workUrl } = yield* fixture
        const post = (body: WorkPullRequestAttach & { readonly goal?: WorkGoalCheckpoint["goal"] }, origin?: string) =>
          Effect.promise(async () => {
            const headers = new Headers({ "content-type": "application/json" })
            if (origin !== undefined) headers.set("origin", origin)
            const response = await fetch(`${workUrl}/v1/work/attach-pr`, {
              method: "POST",
              headers,
              body: JSON.stringify(body)
            })
            return { status: response.status, body: await response.json() }
          })
        expect((yield* post(input, "https://browser.example.test")).status).toBe(403)
        expect((yield* post({ ...input, goal: original.goal })).status).toBe(400)
        expect(yield* store.list()).toEqual([original])
        const stale = yield* post({ ...input, expectedGoalEventId: "stale" })
        expect(stale).toEqual({
          status: 409,
          body: {
            error: "WorkPullRequestAttachConflict",
            goalId: input.goalId,
            expectedGoalEventId: "stale",
            actualGoalEventId: original.eventId,
            reason: "stale_event"
          }
        })
        expect(yield* store.list()).toEqual([original])
        const attached = yield* post(input)
        expect(attached).toMatchObject({
          status: 201,
          body: { eventId: input.eventId, goal: { review: { url: input.reviewUrl } } }
        })
        expect(yield* post(input)).toEqual(attached)
        expect((yield* store.list()).length).toBe(2)
      }))

    // Bundles the CLI against built workspace dependencies, as the existing HTTP CLI fixtures do.
    it.effect(
      "fleetctl exits nonzero with the conflict cause tag and prints the successful checkpoint",
      () =>
        Effect.gen(function*() {
          const { configuration, root, store } = yield* fixture
          const entry = join(root, "fleetctl.cjs")
          yield* Effect.promise(() =>
            build({
              bundle: true,
              entryPoints: [join(import.meta.dirname, "../src/fleetctl.ts")],
              format: "cjs",
              outfile: entry,
              platform: "node"
            })
          )
          const path = join(root, "fleet.json")
          writeFileSync(path, JSON.stringify(configuration))
          const stale = yield* Effect.promise(() => runCli(entry, path, { ...input, expectedGoalEventId: "stale" }))
          expect(stale.code).not.toBe(0)
          expect(stale.stdout).toBe("")
          expect(stale.stderr).toContain("HTTP 409")
          expect(stale.stderr).toContain("WorkPullRequestAttachConflict")
          expect(stale.stderr).toContain("actualGoalEventId")
          expect(yield* store.list()).toEqual([original])
          const attached = yield* Effect.promise(() => runCli(entry, path, input))
          expect(attached.code, attached.stderr).toBe(0)
          expect(JSON.parse(attached.stdout)).toMatchObject({
            eventId: input.eventId,
            goal: { review: { url: input.reviewUrl } }
          })
        }),
      30_000
    )
  })
})
