import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import {
  connectAgentPageMaxRecords,
  FleetConnectAgentPage,
  terminalCommandMaxPayloadBytes,
  type TerminalConnector,
  terminalFrameMaxEncodedBytes,
  type TerminalSession
} from "@knpkv/herdr-connect"
import { ChatHistory, chatHistoryMaxEntries, ChatStore, type StoredChatTurn } from "@knpkv/herdr-coordinator"
import {
  FleetAuthorizationError,
  FleetOperationError,
  fleetResponseBodyMaxBytes,
  type FleetService,
  FleetValidationError,
  type HostConfiguration,
  type HostOperations,
  JobHistoryPage,
  JobRecord,
  JobStore,
  jobTextMaxLength,
  makeFleetService,
  pendingApprovalPageMaxRecords
} from "@knpkv/herdr-fleet"
import { Tailscale, type TailscaleClient, TailscaleCommandError } from "@knpkv/herdr-tailscale"
import {
  makeWorkService,
  type WorkApprovalTarget as WorkApprovalTargetType,
  WorkGoalCheckpoint,
  type WorkGoalCheckpoint as WorkGoalCheckpointType,
  WorkSnapshots,
  WorkStore
} from "@knpkv/herdr-work"
import { Deferred, Effect, Fiber, Result, Schema, Stream } from "effect"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import WebSocketClient from "ws"
import { SanitizedJobRecord } from "../src/approval-request.js"
import { resolveApprovalPage } from "../src/approval-url.js"
import { authorize } from "../src/auth.js"
import {
  DashboardSnapshot,
  FleetPendingApprovals,
  PendingApprovalSummary,
  PendingApprovalTarget
} from "../src/dashboard-model.js"
import {
  budgetDashboardSnapshot,
  dashboardSnapshotBytes,
  listenerAuthority,
  makeRunner,
  notificationCandidates,
  recordWorkCheckpointRequest,
  startHttpServer
} from "../src/http.js"
import { dashboardDocumentTitle } from "../src/internal/html.js"
import { relayTerminalCloseCode, terminalBufferCanAccept, terminalBufferLimitBytes } from "../src/internal/websocket.js"
import { commandOutputMaxBytes } from "../src/operations.js"

// Each test effect is an application boundary; @effect/vitest scopes its Node services.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const config = (stateDirectory: string): HostConfiguration => ({
  allowedUsers: ["andrey@example.com"],
  applyCommand: null,
  browserMcpRecoverCommand: null,
  applyMachines: ["ALPHA", "SER8"],
  approvalHub: {
    host: "SER8",
    nodeId: "node-ser8",
    url: "https://ser8.example.test:4779/"
  },
  approvalNodes: ["node-ser8"],
  approvalPort: 4779,
  checkCommand: ["nix", "flake", "check"],
  coordinatorCommand: ["coordinator"],
  crossHost: false,
  herdrCommand: "herdr",
  host: "ALPHA",
  localPort: 0,
  machines: [
    { host: "ALPHA", nodeId: "node-alpha" },
    { host: "SER8", nodeId: "node-ser8" }
  ],
  port: 0,
  pushAllowedOrigins: ["https://push.example.test"],
  pushSubject: "mailto:andrey@example.com",
  repository: "/repo",
  approvalTls: null,
  stateDirectory,
  tailscaleCommand: "tailscale"
})

const operations: HostOperations = {
  inspect: () =>
    Effect.succeed({
      applyConfigured: false,
      branch: "main",
      dirty: false,
      repository: "/repo",
      revision: "abc123"
    }),
  listAgents: () => Effect.succeed({ agents: [], available: true, error: null }),
  run: (payload) => Effect.succeed(`${payload.kind}: ok`),
  runLocal: (payload) => Effect.succeed(`${payload.kind}: ok`),
  runCoordinatorChat: () => Effect.succeed("coordinator: ok")
}

const unusedTerminal: TerminalConnector = {
  open: () => Effect.die("terminal test connector must not be opened")
}

const pendingRecord = (host: string, index: number): JobRecord => ({
  actor: "andrey@example.com",
  approvalNonce: `${host}-nonce-${index}`,
  approvedBy: null,
  createdAt: index + 1,
  error: null,
  hash: `${host.charCodeAt(0).toString(16)}${index.toString(16)}`.padStart(64, "0"),
  id: `${host.toLowerCase()}-job-${String(index).padStart(2, "0")}`,
  payload: { kind: "nix.check" },
  result: null,
  status: "pending_approval",
  updatedAt: index + 1
})

const assets = {
  connectScript: "",
  fonts: new Map<string, Uint8Array>(),
  script: "",
  stylesheet: "",
  worker: ""
}

const approvalProofCookieCount = (response: Response): number =>
  response.headers.get("set-cookie")?.match(/fleet_approval_proof_/gu)?.length ?? 0

const directTls = {
  certificatePath: join(import.meta.dirname, "fixtures/ser8.example.test.crt"),
  privateKeyPath: join(import.meta.dirname, "fixtures/ser8.example.test.key")
}

const secureRequestBody = (
  url: string,
  headers: Readonly<Record<string, string>>
): Promise<{ readonly body: string; readonly status: number }> =>
  new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      { headers, rejectUnauthorized: false },
      (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => {
          body += chunk
        })
        response.once("end", () => resolve({ body, status: response.statusCode ?? 0 }))
      }
    )
    request.once("error", reject)
    request.end()
  })

const workCheckpoint: WorkGoalCheckpointType = {
  eventId: "event-work-created",
  goal: {
    blocker: null,
    connectTarget: null,
    createdAt: 1_000,
    delivery: "local",
    detail: "Durable coordinator-owned goal",
    id: "goal-work",
    owner: { id: "owner-coordinator", name: "Coordinator" },
    repository: { branch: "feat/herdr-npm-packages", repository: "npm" },
    spend: null,
    state: "planned",
    summary: "Record live Work state",
    title: "Wire Work ingestion",
    updatedAt: 1_000
  },
  occurredAt: 1_000,
  version: "herdr.work.event.v1"
}

const approvalPage = (_host: string) => Effect.succeed("https://ser8.example.test:4779/")

const ser8ApprovalTarget: WorkApprovalTargetType = {
  host: "SER8",
  jobId: "approval-job-42",
  url: "https://ser8.example.test:4779/?tab=approvals&approvalHost=SER8&approvalJob=approval-job-42"
}

const maximumTextWorkCheckpoint = (index: number): WorkGoalCheckpointType => {
  const text = "x".repeat(4_096)
  const idPrefix = `goal-${index}-`
  const eventPrefix = `event-${index}-`
  return {
    ...workCheckpoint,
    eventId: `${eventPrefix}${"e".repeat(256 - eventPrefix.length)}`,
    goal: {
      ...workCheckpoint.goal,
      blocker: { since: 0, summary: text },
      createdAt: 0,
      detail: text,
      id: `${idPrefix}${"g".repeat(256 - idPrefix.length)}`,
      owner: { id: "o".repeat(256), name: text },
      repository: { branch: text, repository: text },
      state: "blocked",
      summary: text,
      title: text,
      updatedAt: 0
    },
    occurredAt: 0
  }
}

type WorkCheckpointTestPayload = WorkGoalCheckpointType & {
  readonly command?: ReadonlyArray<string>
}

const decodeWorkCheckpoint = (input: WorkCheckpointTestPayload) =>
  Schema.decodeUnknownEffect(WorkGoalCheckpoint, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(
      (cause) => new FleetValidationError({ detail: `invalid request: ${String(cause)}` })
    )
  )

const availablePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const reservation = createServer()
    reservation.once("error", reject)
    reservation.listen(0, "127.0.0.1", () => {
      const address = Schema.decodeUnknownResult(
        Schema.Struct({ port: Schema.Number })
      )(reservation.address())
      if (Result.isFailure(address)) {
        reservation.close()
        reject(address.failure)
        return
      }
      reservation.close((error) => {
        if (error === undefined) resolve(address.success.port)
        else reject(error)
      })
    })
  })

const requestStatus = (url: string, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { host } }, (response) => {
      response.resume()
      response.once("end", () => resolve(response.statusCode ?? 0))
    })
    request.once("error", reject)
    request.end()
  })

const waitForFile = Effect.fn("HostHttpTest.waitForFile")(function*(path: string) {
  while (!existsSync(path)) yield* Effect.yieldNow
})

describe("host HTTP authority", () => {
  it.effect("serves a sanitized request and keeps it after a bodyless approval", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-approval-request-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"andrey@example.com"}}' ;;
  status) printf '%s\n' '{"Peer":{},"Self":{"HostName":"ALPHA","ID":"node-alpha","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    const hostConfig = {
      ...config(root),
      approvalPort: 0,
      crossHost: true,
      port: 0,
      tailscaleCommand
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({
            approvalEnabled: true,
            host: hostConfig.host,
            id: Effect.succeed("job-disclosure"),
            nonce: Effect.succeed("nonce-disclosure"),
            now: Effect.succeed(1_000),
            operations,
            store
          })
          const pending = yield* fleet.submit(
            {
              payload: {
                kind: "agent.delegate",
                mode: "work",
                prompt: "raw terminal prompt token=secret-value",
                repository: "/srv/npm"
              }
            },
            "submitter@example.com"
          )
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          const approvalUrl = server.approvalUrl
          if (approvalUrl === null) return yield* Effect.die("approval listener missing")
          const headers = {
            "tailscale-user-login": "andrey@example.com"
          }
          const dashboardResponse = yield* Effect.promise(() => fetch(`${approvalUrl}/v1/dashboard`, { headers }))
          const dashboard = yield* Effect.promise(() => dashboardResponse.text())
          const proofCookie = dashboardResponse.headers.get("set-cookie")
          if (proofCookie === null) {
            return yield* new FleetValidationError({ detail: "approval proof cookie missing from dashboard" })
          }
          const proofCookieHeader = proofCookie.split(";", 1)[0]
          expect(dashboard).toContain("[redacted internal prompt]")
          expect(dashboard).not.toContain("raw terminal prompt")
          expect(dashboard).not.toContain("secret-value")
          expect(dashboard).not.toContain(pending.hash)
          expect(dashboard).not.toContain("nonce-disclosure")
          const page = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/`, { headers }).then((response) => response.text())
          )
          expect(page).toContain("View full request")
          expect(page).toContain("[redacted internal prompt]")
          expect(page).not.toContain("raw terminal prompt")
          expect(page).not.toContain("secret-value")
          expect(page).not.toContain(pending.hash)
          expect(page).not.toContain("nonce-disclosure")

          const withoutProof = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/${pending.id}/approve`, {
              headers: {
                ...headers,
                origin: new URL(approvalUrl).origin
              },
              method: "POST"
            })
          )
          expect(withoutProof.status).toBe(409)
          yield* Effect.promise(() => withoutProof.text())

          const decided = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/${pending.id}/approve`, {
              headers: {
                ...headers,
                cookie: proofCookieHeader,
                origin: new URL(approvalUrl).origin
              },
              method: "POST"
            })
          )
          expect(decided.status).toBe(200)
          const decidedBody = yield* Effect.promise(() => decided.text())
          const decidedRecord = Schema.decodeUnknownSync(SanitizedJobRecord)(JSON.parse(decidedBody))
          expect("approvalNonce" in decidedRecord).toBe(false)
          expect("hash" in decidedRecord).toBe(false)
          expect(decidedBody).not.toContain("secret-value")
          expect(decidedBody).not.toContain("nonce-disclosure")
          expect(decidedBody).not.toContain(pending.hash)

          const replay = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/${pending.id}/approve`, {
              headers: {
                ...headers,
                cookie: proofCookieHeader,
                origin: new URL(approvalUrl).origin
              },
              method: "POST"
            })
          )
          expect(replay.status).toBe(409)
          yield* Effect.promise(() => replay.text())

          let terminal = yield* fleet.get(pending.id)
          for (
            let attempt = 0;
            attempt < 100 && (terminal.status === "queued" || terminal.status === "running");
            attempt += 1
          ) {
            yield* Effect.yieldNow
            terminal = yield* fleet.get(pending.id)
          }
          expect(terminal.status).toBe("succeeded")
          const history = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/`, { headers }).then((response) => response.text())
          )
          expect(history).toContain("Completed")
          expect(history).not.toContain("secret-value")
          const retainedDashboard = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/dashboard`, { headers }).then((response) => response.text())
          )
          expect(retainedDashboard).toContain("[redacted internal prompt]")
          expect(retainedDashboard).not.toContain("secret-value")
        }).pipe(Effect.scoped),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("marks notification counts incomplete when fleet discovery fails", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-push-directory-failure-test-"))
    const unavailable = new TailscaleCommandError({
      cause: "unavailable",
      operation: "status"
    })
    const tailscale: TailscaleClient = {
      ipv4: Effect.fail(unavailable),
      status: Effect.fail(unavailable),
      whois: () => Effect.fail(unavailable)
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({
            approvalEnabled: true,
            host: "ALPHA",
            id: Effect.succeed("job-local"),
            now: Effect.succeed(1_000),
            operations,
            store
          })
          yield* fleet.submit(
            { payload: { kind: "nix.apply", ref: "main" } },
            "andrey@example.com"
          )
          expect(
            yield* notificationCandidates(config(root), fleet).pipe(
              Effect.provideService(Tailscale, tailscale)
            )
          ).toEqual({
            candidates: [{ host: "ALPHA", jobId: "job-local" }],
            pendingCount: null
          })
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it("escapes configured hosts in the dashboard document title", () => {
    const host = "SER8</title><script data-xss=\"true\">alert(1)</script>"
    const title = dashboardDocumentTitle(host)
    expect(title).not.toContain("<script")
    expect(title).not.toContain(host)
    expect(title).toBe(
      "Host activity · SER8&lt;/title&gt;&lt;script data-xss=&quot;true&quot;&gt;alert(1)&lt;/script&gt;"
    )
  })

  it.effect("refuses an oversized dashboard when no history remains to page", () =>
    Effect.gen(function*() {
      const snapshot = Schema.decodeUnknownSync(DashboardSnapshot)({
        approvalApp: {
          canonical: true,
          canonicalUrl: "https://ser8.example.test:4779/",
          chatEnabled: true,
          pushEnabled: true
        },
        approvalsEnabled: true,
        chat: null,
        directory: null,
        historyNextCursor: null,
        host: "SER8",
        observedAt: 1,
        pendingApprovals: {
          failures: [],
          local: [],
          nextCursors: [],
          remote: Array.from({ length: 16 }, (_, index) => ({
            approval: {
              actor: "andrey@example.com",
              approvalExpiresAt: null,
              createdAt: index,
              id: `job-${index}`,
              payload: {
                kind: "agent.delegate",
                mode: "work",
                prompt: "\u0001".repeat(jobTextMaxLength),
                repository: "/repo"
              },
              status: "pending_approval"
            },
            approvalUrl: `http://100.64.0.${index + 1}:4779/`,
            host: `worker-${index}`
          }))
        },
        records: [],
        status: {
          applyConfigured: false,
          branch: "main",
          dirty: false,
          herdr: { agents: [], available: true, error: null },
          host: "SER8",
          repository: "/repo",
          revision: "abc123"
        },
        work: null
      })
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(
        fleetResponseBodyMaxBytes
      )
      expect(yield* Effect.result(budgetDashboardSnapshot(snapshot))).toMatchObject({
        failure: {
          _tag: "DashboardResponseBudgetError",
          maximumBytes: fleetResponseBodyMaxBytes
        }
      })
    }))

  it.effect("refuses a dashboard when no history record fits the remaining envelope", () =>
    Effect.gen(function*() {
      const record = {
        actor: "andrey@example.com",
        approvalNonce: null,
        approvedBy: null,
        createdAt: 1,
        error: null,
        hash: "1".repeat(64),
        id: "job-too-large-for-dashboard",
        payload: {
          kind: "agent.delegate",
          mode: "work",
          prompt: "x".repeat(2_000),
          repository: "/repo"
        },
        result: null,
        status: "queued",
        updatedAt: 1
      } satisfies JobRecord
      const base = Schema.decodeUnknownSync(DashboardSnapshot)({
        approvalApp: {
          canonical: true,
          canonicalUrl: "https://ser8.example.test:4779/",
          chatEnabled: true,
          pushEnabled: true
        },
        approvalsEnabled: true,
        chat: null,
        directory: null,
        historyNextCursor: null,
        host: "SER8",
        observedAt: 1,
        pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [] },
        records: [],
        status: {
          applyConfigured: false,
          branch: "main",
          dirty: false,
          herdr: { agents: [], available: true, error: null },
          host: "SER8",
          repository: "/repo",
          revision: ""
        },
        work: null
      })
      const rawBaseBytes = Buffer.byteLength(JSON.stringify(base))
      const snapshot = Schema.decodeUnknownSync(DashboardSnapshot)({
        ...base,
        records: [record],
        status: {
          ...base.status,
          revision: "x".repeat(
            fleetResponseBodyMaxBytes - rawBaseBytes - 1_000
          )
        }
      })
      expect(dashboardSnapshotBytes({ ...snapshot, records: [] })).toBeLessThan(
        fleetResponseBodyMaxBytes
      )
      expect(dashboardSnapshotBytes(snapshot)).toBeGreaterThan(
        fleetResponseBodyMaxBytes
      )
      expect(yield* Effect.result(budgetDashboardSnapshot(snapshot))).toMatchObject({
        failure: {
          _tag: "DashboardResponseBudgetError",
          maximumBytes: fleetResponseBodyMaxBytes
        }
      })
    }))

  it.effect("counts the emitted newline at the exact dashboard response limit", () =>
    Effect.gen(function*() {
      const base = Schema.decodeUnknownSync(DashboardSnapshot)({
        approvalApp: {
          canonical: true,
          canonicalUrl: "https://ser8.example.test:4779/",
          chatEnabled: true,
          pushEnabled: true
        },
        approvalsEnabled: true,
        chat: null,
        directory: null,
        historyNextCursor: null,
        host: "SER8",
        observedAt: 1,
        pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [] },
        records: [],
        status: {
          applyConfigured: false,
          branch: "main",
          dirty: false,
          herdr: { agents: [], available: true, error: null },
          host: "SER8",
          repository: "/repo",
          revision: ""
        },
        work: null
      })
      const rawBaseBytes = Buffer.byteLength(JSON.stringify(base))
      const exactRawLimit = Schema.decodeUnknownSync(DashboardSnapshot)({
        ...base,
        status: {
          ...base.status,
          revision: "x".repeat(fleetResponseBodyMaxBytes - rawBaseBytes)
        }
      })
      expect(Buffer.byteLength(JSON.stringify(exactRawLimit))).toBe(
        fleetResponseBodyMaxBytes
      )
      expect(dashboardSnapshotBytes(exactRawLimit)).toBe(
        fleetResponseBodyMaxBytes + 1
      )
      expect(yield* Effect.result(budgetDashboardSnapshot(exactRawLimit))).toMatchObject({
        failure: {
          _tag: "DashboardResponseBudgetError",
          encodedBytes: fleetResponseBodyMaxBytes + 1
        }
      })
    }))

  it("canonicalizes default HTTP listener authorities", () => {
    expect(listenerAuthority("100.64.0.1", 80)).toBe("100.64.0.1")
    expect(listenerAuthority("100.64.0.1", 4_779)).toBe("100.64.0.1:4779")
    expect(listenerAuthority("::1", 4_779)).toBe("[::1]:4779")
  })

  it.effect("preserves operational failure details in JSON responses", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-error-detail-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({
            approvalEnabled: false,
            host: "ALPHA",
            operations,
            store
          })
          const failingFleet: FleetService = {
            ...fleet,
            status: () =>
              Effect.fail(
                new FleetOperationError({
                  cause: "offline",
                  detail: "backend unavailable",
                  operation: "fleet.status"
                })
              )
          }
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(config(root), failingFleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          const response = yield* Effect.promise(() => fetch(`${server.url}/v1/status`))
          expect(response.status).toBe(503)
          expect(yield* Effect.promise(() => response.json())).toEqual({
            error: "FleetOperationError",
            detail: "backend unavailable"
          })
        }).pipe(Effect.scoped),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("records only authorized valid Work checkpoints and projects them immediately", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-work-checkpoint-"))
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(root, "approval-app.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const work = yield* makeWorkService(store)

      const unauthorized = yield* Effect.result(
        recordWorkCheckpointRequest(
          Effect.fail(new FleetAuthorizationError({ actor: "mallory@example.com" })),
          decodeWorkCheckpoint(workCheckpoint),
          work,
          approvalPage
        )
      )
      expect(unauthorized).toMatchObject({ failure: { _tag: "FleetAuthorizationError" } })

      const malformed = yield* Effect.result(
        recordWorkCheckpointRequest(
          Effect.succeed("local"),
          decodeWorkCheckpoint({ ...workCheckpoint, command: ["sh", "-c", "id"] }),
          work,
          approvalPage
        )
      )
      expect(malformed).toMatchObject({ failure: { _tag: "FleetValidationError" } })

      expect(
        yield* recordWorkCheckpointRequest(
          Effect.succeed("local"),
          decodeWorkCheckpoint(workCheckpoint),
          work,
          approvalPage
        )
      ).toEqual(workCheckpoint)
      const replay = yield* Effect.result(
        recordWorkCheckpointRequest(
          Effect.succeed("local"),
          decodeWorkCheckpoint(workCheckpoint),
          work,
          approvalPage
        )
      )
      expect(replay).toMatchObject({ _tag: "Success", success: workCheckpoint })
      expect((yield* work.snapshots(1_000)).now.goals).toEqual([workCheckpoint.goal])
    }).pipe(Effect.scoped, provideNodeServices)
  })

  it.effect("replays approval checkpoints when the authoritative page is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-work-replay-"))
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(root, "approval-app.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const work = yield* makeWorkService(store)
      const checkpoint = {
        ...workCheckpoint,
        goal: { ...workCheckpoint.goal, approvalTarget: ser8ApprovalTarget }
      }
      const unavailableApprovalPage = (_host: string) =>
        Effect.fail(
          new FleetOperationError({
            cause: "offline",
            detail: "approval host unavailable",
            operation: "tailscale.status"
          })
        )

      yield* recordWorkCheckpointRequest(
        Effect.succeed("local"),
        decodeWorkCheckpoint(checkpoint),
        work,
        approvalPage
      )
      const replay = yield* Effect.result(
        recordWorkCheckpointRequest(
          Effect.succeed("local"),
          decodeWorkCheckpoint(checkpoint),
          work,
          unavailableApprovalPage
        )
      )
      expect(replay).toMatchObject({ _tag: "Success", success: checkpoint })

      const firstAttempt = yield* Effect.result(
        recordWorkCheckpointRequest(
          Effect.succeed("local"),
          decodeWorkCheckpoint({
            ...checkpoint,
            eventId: "event-work-approval-new",
            occurredAt: 2_000,
            goal: { ...checkpoint.goal, updatedAt: 2_000 }
          }),
          work,
          unavailableApprovalPage
        )
      )
      expect(firstAttempt).toMatchObject({ failure: { _tag: "FleetOperationError" } })
      expect((yield* work.snapshots(1_000)).now.goals).toEqual([checkpoint.goal])
    }).pipe(Effect.scoped, provideNodeServices)
  })

  it.effect("binds persisted approval links to the resolved page origin", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-work-approval-origin-"))
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(root, "approval-app.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const work = yield* makeWorkService(store)
      const resolvePage = (host: string) =>
        Effect.succeed(
          host === "PI 5" ? "http://100.64.0.8:4779/" : "https://ser8.example.test:4779/"
        )
      const peerTarget: WorkApprovalTargetType = {
        host: "PI 5",
        jobId: "job/7",
        url: "http://100.64.0.8:4779/?tab=approvals&approvalHost=PI+5&approvalJob=job%2F7"
      }
      const matching = yield* recordWorkCheckpointRequest(
        Effect.succeed("local"),
        decodeWorkCheckpoint({
          ...workCheckpoint,
          goal: { ...workCheckpoint.goal, approvalTarget: peerTarget }
        }),
        work,
        resolvePage
      )
      expect(matching.goal.approvalTarget).toEqual(peerTarget)

      const mismatchedUrl = "https://evil.example.test/?tab=approvals&approvalHost=SER8&approvalJob=approval-job-42"
      const mismatched = yield* Effect.result(
        recordWorkCheckpointRequest(
          Effect.succeed("local"),
          decodeWorkCheckpoint({
            ...workCheckpoint,
            eventId: "event-work-mismatched-origin",
            goal: {
              ...workCheckpoint.goal,
              approvalTarget: { ...ser8ApprovalTarget, url: mismatchedUrl }
            }
          }),
          work,
          resolvePage
        )
      )
      expect(mismatched).toMatchObject({ failure: { _tag: "FleetValidationError" } })

      const nestedMismatch = yield* Effect.result(
        recordWorkCheckpointRequest(
          Effect.succeed("local"),
          decodeWorkCheckpoint({
            ...workCheckpoint,
            eventId: "event-work-nested-mismatched-origin",
            goal: {
              ...workCheckpoint.goal,
              requests: [{
                approvalTarget: { ...ser8ApprovalTarget, url: mismatchedUrl },
                id: "request-approval",
                requestedAt: workCheckpoint.goal.updatedAt,
                state: "open",
                summary: "Approve the package shipment"
              }]
            }
          }),
          work,
          resolvePage
        )
      )
      expect(nestedMismatch).toMatchObject({ failure: { _tag: "FleetValidationError" } })
      expect((yield* work.snapshots(1_000)).now.goals).toEqual([matching.goal])
    }).pipe(Effect.scoped, provideNodeServices)
  })

  it.effect("resolves each approval host once per checkpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-work-approval-cache-"))
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(root, "approval-app.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const work = yield* makeWorkService(store)

      const invalidHosts: Array<string> = []
      const invalidResolvePage = (host: string) =>
        Effect.sync(() => {
          invalidHosts.push(host)
          return "https://ser8.example.test:4779/"
        })
      const invalidCheckpoint = {
        ...workCheckpoint,
        eventId: "event-work-approval-cache-invalid",
        goal: {
          ...workCheckpoint.goal,
          approvalTarget: ser8ApprovalTarget,
          id: "goal-work-approval-cache-invalid",
          requests: [{
            approvalTarget: {
              ...ser8ApprovalTarget,
              host: "ser8",
              url: "https://evil.example.test/?tab=approvals&approvalHost=ser8&approvalJob=approval-job-42"
            },
            id: "request-work-approval-cache-invalid",
            requestedAt: 1_000,
            state: "open",
            summary: "Reject the mismatched approval origin"
          }]
        }
      }
      const invalid = yield* Effect.result(
        recordWorkCheckpointRequest(
          Effect.succeed("local"),
          decodeWorkCheckpoint(invalidCheckpoint),
          work,
          invalidResolvePage
        )
      )
      expect(invalid).toMatchObject({ failure: { _tag: "FleetValidationError" } })
      expect(invalidHosts).toEqual(["SER8"])

      const validHosts: Array<string> = []
      const peerTarget: WorkApprovalTargetType = {
        host: "PI 5",
        jobId: "approval-job-7",
        url: "http://100.64.0.8:4779/?tab=approvals&approvalHost=PI+5&approvalJob=approval-job-7"
      }
      const validResolvePage = (host: string) =>
        Effect.sync(() => {
          validHosts.push(host)
          return host.toLowerCase() === "ser8"
            ? "https://ser8.example.test:4779/"
            : "http://100.64.0.8:4779/"
        })
      const validCheckpoint = {
        ...workCheckpoint,
        eventId: "event-work-approval-cache-valid",
        goal: {
          ...workCheckpoint.goal,
          approvalTarget: ser8ApprovalTarget,
          id: "goal-work-approval-cache-valid",
          requests: [{
            approvalTarget: peerTarget,
            id: "request-work-approval-cache-valid",
            requestedAt: 1_000,
            state: "open",
            summary: "Approve the peer handoff"
          }]
        }
      }
      expect(
        yield* recordWorkCheckpointRequest(
          Effect.succeed("local"),
          decodeWorkCheckpoint(validCheckpoint),
          work,
          validResolvePage
        )
      ).toEqual(validCheckpoint)
      expect(validHosts).toEqual(["SER8", "PI 5"])
    }).pipe(Effect.scoped, provideNodeServices)
  })

  it.effect("records and reads Work only through the loopback/LAN listener", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-work-loopback-"))
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const hostConfig = { ...config(root), workBindAddress: "127.0.0.2" }
      const jobStore = yield* JobStore.open(join(root, "jobs.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => jobStore.close()))
      const fleet = yield* makeFleetService({
        approvalEnabled: false,
        host: hostConfig.host,
        operations,
        store: jobStore
      })
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => startHttpServer(hostConfig, fleet, assets, { terminalConnector: unusedTerminal })),
        (running) => Effect.promise(running.close)
      )

      if (server.workUrl === null) return yield* Effect.die("Work listener missing")
      const workListenerUrl = new URL(server.workUrl)
      expect(workListenerUrl.hostname).toBe("127.0.0.2")

      const untrustedInterface = yield* Effect.result(
        Effect.tryPromise({
          try: () => fetch(`http://127.0.0.1:${workListenerUrl.port}/v1/work`),
          catch: (cause) =>
            new FleetOperationError({
              cause,
              detail: String(cause),
              operation: "probe untrusted Work listener interface"
            })
        })
      )
      expect(untrustedInterface._tag).toBe("Failure")

      expect(
        yield* Effect.promise(() =>
          requestStatus(
            `${server.workUrl}/v1/work`,
            `attacker.example:${workListenerUrl.port}`
          )
        )
      ).toBe(403)

      const recorded = yield* Effect.promise(() =>
        fetch(`${server.workUrl}/v1/work/checkpoints`, {
          body: JSON.stringify(workCheckpoint),
          headers: { "content-type": "application/json" },
          method: "POST"
        })
      )
      expect(recorded.status).toBe(201)
      expect(Schema.decodeUnknownSync(WorkGoalCheckpoint)(yield* Effect.promise(() => recorded.json()))).toEqual(
        workCheckpoint
      )

      const conflict = yield* Effect.promise(() =>
        fetch(`${server.workUrl}/v1/work/checkpoints`, {
          body: JSON.stringify({
            ...workCheckpoint,
            goal: { ...workCheckpoint.goal, title: "Changed checkpoint" }
          }),
          headers: { "content-type": "application/json" },
          method: "POST"
        })
      )
      expect(conflict.status).toBe(409)
      expect(yield* Effect.promise(() => conflict.json())).toEqual({
        error: "WorkCheckpointConflictError",
        eventId: workCheckpoint.eventId
      })

      const snapshot = yield* Effect.promise(() => fetch(`${server.workUrl}/v1/work`))
      expect(snapshot.status).toBe(200)
      expect(Schema.decodeUnknownSync(WorkSnapshots)(yield* Effect.promise(() => snapshot.json())).now.goals).toEqual([
        workCheckpoint.goal
      ])

      const browserWrite = yield* Effect.promise(() =>
        fetch(`${server.workUrl}/v1/work/checkpoints`, {
          body: JSON.stringify(workCheckpoint),
          headers: { "content-type": "application/json", origin: server.workUrl },
          method: "POST"
        })
      )
      expect(browserWrite.status).toBe(403)

      const genericJob = yield* Effect.promise(() =>
        fetch(`${server.workUrl}/v1/jobs`, {
          body: JSON.stringify({ payload: { kind: "nix.check" } }),
          headers: { "content-type": "application/json" },
          method: "POST"
        })
      )
      expect(genericJob.status).toBe(404)
    }).pipe(Effect.scoped, provideNodeServices)
  })

  it("relays only WebSocket status codes valid on the wire", () => {
    expect(relayTerminalCloseCode(1_000)).toBe(1_000)
    expect(relayTerminalCloseCode(3_001)).toBe(3_001)
    for (const invalid of [0, 1_004, 1_005, 1_006, 2_999, 5_000]) {
      expect(relayTerminalCloseCode(invalid)).toBe(4_503)
    }
  })

  it("bounds terminal payload buffering in both directions", () => {
    expect(terminalBufferCanAccept(0, terminalBufferLimitBytes)).toBe(true)
    expect(terminalBufferCanAccept(1, terminalBufferLimitBytes)).toBe(false)
    expect(terminalBufferCanAccept(0, terminalBufferLimitBytes + 1)).toBe(true)
    expect(terminalBufferCanAccept(terminalBufferLimitBytes - 1, 1)).toBe(true)
  })

  it.effect("pages pending approvals below the peer response limit", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-pending-page-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"andrey@example.com"}}' ;;
  status) printf '%s\n' '{"Peer":{},"Self":{"HostName":"ALPHA","ID":"node-alpha","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    const hostConfig = {
      ...config(root),
      crossHost: true,
      port: 0,
      tailscaleCommand
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          yield* Effect.forEach(
            Array.from({
              length: pendingApprovalPageMaxRecords + 2
            }, (_, index): JobRecord => ({
              actor: "andrey@example.com",
              approvalNonce: `nonce-${index}`,
              approvedBy: null,
              createdAt: index + 1,
              error: null,
              hash: index.toString(16).padStart(64, "0"),
              id: `job-${String(index).padStart(2, "0")}`,
              payload: {
                kind: "agent.delegate",
                mode: "work",
                prompt: "\u0001".repeat(jobTextMaxLength),
                repository: "/repo"
              },
              result: null,
              status: "pending_approval",
              updatedAt: index + 1
            })),
            (record) => store.put(record),
            { discard: true }
          )
          const fleet = yield* makeFleetService({
            approvalEnabled: true,
            host: hostConfig.host,
            operations,
            store
          })
          expect(yield* fleet.pendingApprovals()).toHaveLength(
            pendingApprovalPageMaxRecords + 2
          )
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          if (server.tailnetUrl === null) return yield* Effect.die("tailnet listener missing")

          const ids: Array<string> = []
          let cursor: typeof PendingApprovalSummary.Type["nextCursor"] = null
          do {
            const pageUrl = new URL("/v1/pending-approvals", server.tailnetUrl)
            if (cursor !== null) {
              pageUrl.searchParams.set("cursorCreatedAt", String(cursor.createdAt))
              pageUrl.searchParams.set("cursorId", cursor.id)
            }
            const response = yield* Effect.promise(() => fetch(pageUrl))
            expect(response.status).toBe(200)
            const body = yield* Effect.promise(() => response.text())
            expect(Buffer.byteLength(body)).toBeLessThanOrEqual(fleetResponseBodyMaxBytes)
            const page = Schema.decodeUnknownSync(PendingApprovalSummary)(JSON.parse(body))
            expect(page.approvals.length).toBeLessThanOrEqual(
              pendingApprovalPageMaxRecords
            )
            for (const { id } of page.approvals) ids.push(id)
            cursor = page.nextCursor
          } while (cursor !== null)

          expect(new Set(ids).size).toBe(pendingApprovalPageMaxRecords + 2)
          expect(ids).toEqual([...ids].sort().reverse())

          if (server.approvalUrl === null) {
            return yield* Effect.die("approval listener missing")
          }
          const dashboardResponse = yield* Effect.promise(() => fetch(`${server.approvalUrl}/v1/dashboard`))
          const dashboardBody = yield* Effect.promise(() => dashboardResponse.text())
          expect(dashboardResponse.status).toBe(200)
          expect(approvalProofCookieCount(dashboardResponse)).toBe(1)
          expect(Buffer.byteLength(dashboardBody)).toBeLessThanOrEqual(
            fleetResponseBodyMaxBytes
          )
          const dashboardJson = JSON.parse(dashboardBody)
          expect(dashboardJson.pendingApprovals.nextCursors).toHaveLength(1)
          const initial = Schema.decodeUnknownSync(DashboardSnapshot)(dashboardJson)
          expect(initial.pendingApprovals.local).toHaveLength(
            pendingApprovalPageMaxRecords
          )
          const dashboardIds = initial.pendingApprovals.local.map(({ id }) => id)
          let continuation = initial.pendingApprovals.nextCursors.at(0)
          while (continuation !== undefined) {
            const continuationUrl = new URL(
              "/v1/dashboard-pending",
              server.approvalUrl
            )
            continuationUrl.searchParams.set("cursorHost", continuation.host)
            continuationUrl.searchParams.set(
              "cursorCreatedAt",
              String(continuation.cursor.createdAt)
            )
            continuationUrl.searchParams.set("cursorId", continuation.cursor.id)
            const continuationResponse = yield* Effect.promise(() => fetch(continuationUrl))
            expect(continuationResponse.status).toBe(200)
            expect(approvalProofCookieCount(continuationResponse)).toBe(1)
            const continuationBody = yield* Effect.promise(() => continuationResponse.text())
            expect(Buffer.byteLength(continuationBody)).toBeLessThanOrEqual(
              fleetResponseBodyMaxBytes
            )
            const page = Schema.decodeUnknownSync(FleetPendingApprovals)(
              JSON.parse(continuationBody)
            )
            for (const { id } of page.local) dashboardIds.push(id)
            continuation = page.nextCursors.at(0)
          }
          expect(dashboardIds).toEqual(ids)
          const hiddenJobId = ids.at(-1)
          if (hiddenJobId === undefined) {
            return yield* Effect.die("hidden approval fixture missing")
          }
          const targetUrl = new URL(
            "/v1/pending-approval",
            server.approvalUrl
          )
          targetUrl.searchParams.set("host", hostConfig.host)
          targetUrl.searchParams.set("jobId", hiddenJobId)
          const targetResponse = yield* Effect.promise(() => fetch(targetUrl))
          expect(targetResponse.status).toBe(200)
          expect(approvalProofCookieCount(targetResponse)).toBe(1)
          expect(
            Schema.decodeUnknownSync(PendingApprovalTarget)(
              yield* Effect.promise(() => targetResponse.json())
            )
          ).toMatchObject({
            _tag: "local",
            record: { id: hiddenJobId, status: "pending_approval" }
          })
        }).pipe(Effect.scoped),
      (store) => Effect.sync(() => store.close())
    ).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("continues every local and remote dashboard approval page", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-dashboard-pending-test-"))
    const mainTailscale = join(root, "tailscale-main")
    const peerTailscale = join(root, "tailscale-peer")
    writeFileSync(
      mainTailscale,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-alpha"},"UserProfile":{"LoginName":"andrey@example.com"}}' ;;
  status) printf '%s\n' '{"Peer":{"ser8":{"HostName":"SER8","ID":"node-ser8","Online":true,"TailscaleIPs":["127.0.0.2"]}},"Self":{"HostName":"ALPHA","ID":"node-alpha","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    writeFileSync(
      peerTailscale,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.2' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-alpha"},"UserProfile":{"LoginName":"andrey@example.com"}}' ;;
  status) printf '%s\n' '{"Peer":{},"Self":{"HostName":"SER8","ID":"node-ser8","Online":true,"TailscaleIPs":["127.0.0.2"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "peer-jobs.sqlite")),
      (peerStore) =>
        Effect.acquireUseRelease(
          JobStore.open(join(root, "main-jobs.sqlite")),
          (mainStore) =>
            Effect.gen(function*() {
              yield* Effect.forEach(
                Array.from({ length: pendingApprovalPageMaxRecords + 1 }, (_, index) => pendingRecord("SER8", index)),
                (record) => peerStore.put(record),
                { discard: true }
              )
              yield* Effect.forEach(
                Array.from({ length: pendingApprovalPageMaxRecords + 1 }, (_, index) => pendingRecord("ALPHA", index)),
                (record) => mainStore.put(record),
                { discard: true }
              )
              const peerConfig: HostConfiguration = {
                ...config(root),
                approvalHub: {
                  host: "ALPHA",
                  nodeId: "node-alpha",
                  url: "https://alpha.example.test/"
                },
                approvalNodes: ["node-alpha"],
                approvalPort: 0,
                crossHost: true,
                host: "SER8",
                port: 0,
                tailscaleCommand: peerTailscale
              }
              const peerFleet = yield* makeFleetService({
                approvalEnabled: true,
                host: peerConfig.host,
                operations,
                store: peerStore
              })
              const peerServer = yield* Effect.acquireRelease(
                Effect.promise(() =>
                  startHttpServer(peerConfig, peerFleet, assets, {
                    terminalConnector: unusedTerminal
                  })
                ),
                (running) => Effect.promise(running.close)
              )
              if (peerServer.tailnetUrl === null || peerServer.approvalUrl === null) {
                return yield* Effect.die("peer listeners missing")
              }
              const peerPort = Number(new URL(peerServer.tailnetUrl).port)
              const approvalPort = Number(new URL(peerServer.approvalUrl).port)
              const mainConfig: HostConfiguration = {
                ...config(root),
                approvalHub: {
                  host: "ALPHA",
                  nodeId: "node-alpha",
                  url: `https://alpha.example.test:${approvalPort}/`
                },
                approvalNodes: ["node-alpha"],
                approvalPort,
                approvalTls: directTls,
                crossHost: true,
                port: peerPort,
                tailscaleCommand: mainTailscale
              }
              const mainFleet = yield* makeFleetService({
                approvalEnabled: true,
                host: mainConfig.host,
                operations,
                store: mainStore
              })
              const mainServer = yield* Effect.acquireRelease(
                Effect.promise(() =>
                  startHttpServer(mainConfig, mainFleet, assets, {
                    terminalConnector: unusedTerminal
                  })
                ),
                (running) => Effect.promise(running.close)
              )
              if (mainServer.serveUrl === null) {
                return yield* Effect.die("canonical listener missing")
              }
              const requestHeaders = {
                host: `alpha.example.test:${approvalPort}`,
                "tailscale-user-login": "andrey@example.com"
              }
              const dashboardResponse = yield* Effect.promise(() =>
                secureRequestBody(`${mainServer.serveUrl}/v1/dashboard`, requestHeaders)
              )
              expect(dashboardResponse.status).toBe(200)
              const dashboard = Schema.decodeUnknownSync(DashboardSnapshot)(
                JSON.parse(dashboardResponse.body)
              )
              const localIds = dashboard.pendingApprovals.local.map(({ id }) => id)
              const remoteIds = dashboard.pendingApprovals.remote.map(({ approval }) => approval.id)
              const continuations = [...dashboard.pendingApprovals.nextCursors]
              expect(continuations.map(({ host }) => host).sort()).toEqual(["ALPHA", "SER8"])
              while (continuations.length > 0) {
                const continuation = continuations.shift()
                if (continuation === undefined) continue
                const parameters = new URLSearchParams({
                  cursorCreatedAt: String(continuation.cursor.createdAt),
                  cursorHost: continuation.host,
                  cursorId: continuation.cursor.id
                })
                const pageResponse = yield* Effect.promise(() =>
                  secureRequestBody(
                    `${mainServer.serveUrl}/v1/dashboard-pending?${parameters.toString()}`,
                    requestHeaders
                  )
                )
                expect(pageResponse.status).toBe(200)
                expect(Buffer.byteLength(pageResponse.body)).toBeLessThanOrEqual(
                  fleetResponseBodyMaxBytes
                )
                const page = Schema.decodeUnknownSync(FleetPendingApprovals)(
                  JSON.parse(pageResponse.body)
                )
                for (const { id } of page.local) localIds.push(id)
                for (const { approval } of page.remote) remoteIds.push(approval.id)
                for (const next of page.nextCursors) continuations.push(next)
              }
              expect(localIds).toHaveLength(pendingApprovalPageMaxRecords + 1)
              expect(remoteIds).toHaveLength(pendingApprovalPageMaxRecords + 1)
            }).pipe(Effect.scoped),
          (store) => Effect.sync(() => store.close())
        ),
      (store) => Effect.sync(() => store.close())
    ).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("re-sanitizes legacy peer approval payloads at browser boundaries", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-legacy-peer-test-"))
    const tailscale = join(root, "tailscale-main")
    writeFileSync(
      tailscale,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-alpha"},"UserProfile":{"LoginName":"andrey@example.com"}}' ;;
  status) printf '%s\n' '{"Peer":{"ser8":{"HostName":"SER8","ID":"node-ser8","Online":true,"TailscaleIPs":["127.0.0.2"]}},"Self":{"HostName":"ALPHA","ID":"node-alpha","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.scoped(
          Effect.gen(function*() {
            const pendingPort = yield* Effect.promise(availablePort)
            const peerServer = createServer((request, response) => {
              const requestUrl = new URL(request.url ?? "/", "http://peer.local")
              const hasCursor = requestUrl.searchParams.has("cursorCreatedAt")
              response.writeHead(200, { "content-type": "application/json" })
              response.end(JSON.stringify({
                host: "SER8",
                approvals: [
                  {
                    id: "legacy-peer-job",
                    createdAt: 1,
                    actor: "andrey@example.com",
                    approvalExpiresAt: 10_000,
                    status: "pending_approval",
                    payload: {
                      kind: "agent.delegate",
                      mode: "work",
                      prompt: "peer-secret-canary",
                      repository: "/srv/npm"
                    }
                  }
                ],
                nextCursor: hasCursor ? null : { createdAt: 1, id: "legacy-peer-job" }
              }))
            })
            yield* Effect.promise(
              () =>
                new Promise<void>((resolve, reject) => {
                  peerServer.once("error", reject)
                  peerServer.listen(pendingPort, "127.0.0.2", resolve)
                })
            )
            yield* Effect.addFinalizer(() =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve, reject) => {
                    peerServer.close((error) => error === undefined ? resolve() : reject(error))
                  })
              )
            )
            const approvalPort = yield* Effect.promise(availablePort)
            const hostConfig: HostConfiguration = {
              ...config(root),
              approvalHub: {
                host: "ALPHA",
                nodeId: "node-alpha",
                url: `https://alpha.example.test:${approvalPort}/`
              },
              approvalNodes: ["node-alpha"],
              approvalPort,
              approvalTls: directTls,
              crossHost: true,
              host: "ALPHA",
              port: pendingPort,
              tailscaleCommand: tailscale
            }
            const fleet = yield* makeFleetService({
              approvalEnabled: true,
              host: hostConfig.host,
              operations,
              store
            })
            const server = yield* Effect.acquireRelease(
              Effect.promise(() =>
                startHttpServer(hostConfig, fleet, assets, {
                  terminalConnector: unusedTerminal
                })
              ),
              (running) => Effect.promise(running.close)
            )
            if (server.serveUrl === null) {
              return yield* new FleetValidationError({
                detail: "legacy peer disclosure test requires the approval hub listener"
              })
            }
            const requestHeaders = {
              host: `alpha.example.test:${approvalPort}`,
              "tailscale-user-login": "andrey@example.com"
            }
            const dashboardResponse = yield* Effect.promise(() =>
              secureRequestBody(`${server.serveUrl}/v1/dashboard`, requestHeaders)
            )
            expect(dashboardResponse.status).toBe(200)
            expect(dashboardResponse.body).not.toContain("peer-secret-canary")
            const dashboard = Schema.decodeUnknownSync(DashboardSnapshot)(
              JSON.parse(dashboardResponse.body)
            )
            const continuation = dashboard.pendingApprovals.nextCursors.find(
              ({ host }) => host === "SER8"
            )
            if (continuation === undefined) {
              return yield* new FleetValidationError({
                detail: "legacy peer disclosure test requires a remote continuation"
              })
            }
            const continuationParameters = new URLSearchParams({
              cursorCreatedAt: String(continuation.cursor.createdAt),
              cursorHost: continuation.host,
              cursorId: continuation.cursor.id
            })
            const continuationResponse = yield* Effect.promise(() =>
              secureRequestBody(
                `${server.serveUrl}/v1/dashboard-pending?${continuationParameters.toString()}`,
                requestHeaders
              )
            )
            expect(continuationResponse.status).toBe(200)
            expect(continuationResponse.body).not.toContain("peer-secret-canary")
            const targetResponse = yield* Effect.promise(() =>
              secureRequestBody(
                `${server.serveUrl}/v1/pending-approval?host=SER8&jobId=legacy-peer-job`,
                requestHeaders
              )
            )
            expect(targetResponse.status).toBe(200)
            expect(targetResponse.body).not.toContain("peer-secret-canary")
          })
        ),
      (store) => Effect.sync(() => store.close())
    ).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("pages worst-case history without exceeding the response limit", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-history-page-test-"))
    const hostConfig = config(root)
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          yield* Effect.forEach(
            Array.from({ length: 8 }, (_, index): JobRecord => ({
              actor: "andrey@example.com",
              approvalNonce: null,
              approvedBy: null,
              createdAt: index + 1,
              error: null,
              hash: index.toString(16).padStart(64, "0"),
              id: `job-history-${String(index).padStart(2, "0")}`,
              payload: {
                kind: "agent.message",
                message: "\u0001".repeat(jobTextMaxLength),
                session: "agent-1"
              },
              result: "\u0001".repeat(commandOutputMaxBytes),
              status: "succeeded",
              updatedAt: index + 1
            })),
            (record) => store.put(record),
            { discard: true }
          )
          const fleet = yield* makeFleetService({
            approvalEnabled: false,
            host: hostConfig.host,
            operations,
            store
          })
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          const ids: Array<string> = []
          let cursor: typeof JobHistoryPage.Type["nextCursor"] = null
          do {
            const pageUrl = new URL("/v1/history?limit=8", server.url)
            if (cursor !== null) {
              pageUrl.searchParams.set("cursorCreatedAt", String(cursor.createdAt))
              pageUrl.searchParams.set("cursorId", cursor.id)
            }
            const response = yield* Effect.promise(() => fetch(pageUrl))
            const body = yield* Effect.promise(() => response.text())
            expect(response.status).toBe(200)
            expect(Buffer.byteLength(body)).toBeLessThanOrEqual(
              fleetResponseBodyMaxBytes
            )
            const page = Schema.decodeUnknownSync(JobHistoryPage)(JSON.parse(body))
            for (const record of page.records) ids.push(record.id)
            cursor = page.nextCursor
          } while (cursor !== null)

          expect(ids).toEqual(
            Array.from({ length: 8 }, (_, index) => `job-history-${String(7 - index).padStart(2, "0")}`)
          )
          const dashboardResponse = yield* Effect.promise(() => fetch(`${server.url}/v1/dashboard`))
          const dashboardBody = yield* Effect.promise(() => dashboardResponse.text())
          expect(Buffer.byteLength(dashboardBody)).toBeLessThanOrEqual(
            fleetResponseBodyMaxBytes
          )
          const dashboard = Schema.decodeUnknownSync(DashboardSnapshot)(
            JSON.parse(dashboardBody)
          )
          expect(dashboard.historyNextCursor).toBeNull()
        }).pipe(Effect.scoped),
      (store) => Effect.sync(() => store.close())
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => rmSync(root, { force: true, recursive: true }))
      ),
      provideNodeServices
    )
  })

  it.effect("routes the approval hub through its canonical TLS URL", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-hub-link-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"andrey@example.com"}}' ;;
  status) printf '%s\n' '{"Peer":{"hub":{"HostName":"SER8","ID":"node-ser8","Online":true,"TailscaleIPs":["127.0.0.2"]},"worker":{"HostName":"PI","ID":"node-pi","Online":true,"TailscaleIPs":["127.0.0.3"]}},"Self":{"HostName":"ALPHA","ID":"node-alpha","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    const hostConfig: HostConfiguration = {
      ...config(root),
      approvalPort: 0,
      crossHost: true,
      machines: [
        { host: "ALPHA", nodeId: "node-alpha" },
        { host: "SER8", nodeId: "node-ser8" },
        { host: "PI", nodeId: "node-pi" }
      ],
      port: 0,
      tailscaleCommand
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({
            approvalEnabled: true,
            host: hostConfig.host,
            operations,
            store
          })
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          if (server.approvalUrl === null) {
            return yield* Effect.die("approval listener missing")
          }
          const response = yield* Effect.promise(() => fetch(`${server.approvalUrl}/v1/dashboard`))
          expect(response.status).toBe(200)
          const snapshot = Schema.decodeUnknownSync(DashboardSnapshot)(
            yield* Effect.promise(() => response.json())
          )
          expect(snapshot.directory?.links).toEqual([
            {
              host: "SER8",
              online: true,
              url: hostConfig.approvalHub.url
            },
            {
              host: "PI",
              online: true,
              url: "http://127.0.0.3:0/"
            }
          ])
        }).pipe(Effect.scoped),
      (store) => Effect.sync(() => store.close())
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => rmSync(root, { force: true, recursive: true }))
      ),
      provideNodeServices
    )
  })

  it.effect("rejects every forwarded identity", () =>
    Effect.gen(function*() {
      const forged = yield* Effect.result(
        authorize(
          { login: "andrey@example.com", remoteAddress: "127.0.0.1" },
          ["andrey@example.com"],
          false
        )
      )
      expect(Result.isFailure(forged)).toBe(true)
      const socketless = yield* Effect.result(
        authorize(
          { login: "andrey@example.com", remoteAddress: undefined },
          ["andrey@example.com"],
          false
        )
      )
      expect(Result.isFailure(socketless)).toBe(true)
    }))

  it.effect("serves the canonical hub with direct TLS and WhoIs authorization", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-direct-tls-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-phone"},"UserProfile":{"LoginName":"andrey@example.com"}}' ;;
  status) printf '%s\n' '{"Peer":{},"Self":{"HostName":"SER8","ID":"node-ser8","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    const hostConfig: HostConfiguration = {
      ...config(root),
      approvalHub: {
        host: "SER8",
        nodeId: "node-ser8",
        url: "https://ser8.example.test:0/"
      },
      approvalPort: 0,
      approvalTls: directTls,
      applyMachines: ["SER8"],
      crossHost: true,
      host: "SER8",
      machines: [{ host: "SER8", nodeId: "node-ser8" }],
      port: 0,
      tailscaleCommand
    }
    const directTlsOperations: HostOperations = {
      ...operations,
      listAgents: () =>
        Effect.succeed({
          agents: Array.from({ length: 130 }, (_, index) => ({
            activityRevision: 1,
            agentId: `agent-${index}`,
            kind: "k".repeat(256),
            name: "n".repeat(256),
            paneId: `w1:p${index}`,
            parentAgentId: null,
            relation: null,
            status: "s".repeat(256),
            work: "w".repeat(256)
          })),
          available: true,
          error: null
        })
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({
            approvalEnabled: true,
            host: hostConfig.host,
            operations: directTlsOperations,
            store
          })
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          if (server.serveUrl === null || server.approvalUrl === null) {
            return yield* Effect.die("direct TLS listener missing")
          }
          const acceptedWorkCheckpoints = yield* Effect.acquireUseRelease(
            WorkStore.open(join(root, "approval-app.sqlite")),
            (workStore) =>
              Effect.gen(function*() {
                const work = yield* makeWorkService(workStore)
                let accepted = 0
                for (let index = 0; index < 11; index += 1) {
                  const result = yield* Effect.result(
                    work.record(maximumTextWorkCheckpoint(index))
                  )
                  if (Result.isSuccess(result)) accepted += 1
                }
                return accepted
              }),
            (workStore) => Effect.sync(() => workStore.close())
          )
          expect(acceptedWorkCheckpoints).toBeLessThan(11)
          yield* Effect.acquireUseRelease(
            ChatStore.open(join(root, "approval-app.sqlite")),
            (chatStore) =>
              Effect.forEach(
                Array.from({ length: chatHistoryMaxEntries }, (_, index) => index),
                (index) => {
                  const jobId = `chat-job-${index}`
                  const turn: StoredChatTurn = {
                    createdAt: index,
                    id: `chat-turn-${index}`,
                    jobId,
                    message: "m".repeat(2_000),
                    mode: "ask"
                  }
                  const record: JobRecord = {
                    actor: "andrey@example.com",
                    approvalNonce: null,
                    approvedBy: null,
                    createdAt: index,
                    error: null,
                    hash: index.toString(16).padStart(64, "0"),
                    id: jobId,
                    payload: {
                      channel: "coordinator_chat",
                      kind: "agent.delegate",
                      mode: "consult",
                      prompt: turn.message,
                      repository: "/repo"
                    },
                    result: "r".repeat(20_000),
                    status: "succeeded",
                    updatedAt: index
                  }
                  return Effect.all([store.put(record), chatStore.put(turn)], {
                    discard: true
                  })
                },
                { discard: true }
              ),
            (chatStore) => Effect.sync(() => chatStore.close())
          )
          expect(server.serveUrl).toMatch(/^https:\/\//)
          expect(server.approvalUrl).toBe(server.serveUrl)
          const requestHeaders = {
            host: "ser8.example.test:0",
            "tailscale-user-login": "attacker@example.com"
          }
          const dashboardResponse = yield* Effect.promise(() =>
            secureRequestBody(`${server.serveUrl}/v1/dashboard`, requestHeaders)
          )
          expect(dashboardResponse.status).toBe(200)
          expect(Buffer.byteLength(dashboardResponse.body)).toBeLessThanOrEqual(
            fleetResponseBodyMaxBytes
          )
          const workResponse = yield* Effect.promise(() =>
            secureRequestBody(`${server.serveUrl}/v1/work`, requestHeaders)
          )
          expect(workResponse.status).toBe(200)
          expect(Buffer.byteLength(workResponse.body)).toBeLessThanOrEqual(
            fleetResponseBodyMaxBytes
          )
          expect(
            Schema.decodeUnknownSync(WorkSnapshots)(JSON.parse(workResponse.body)).now.goals
          ).toHaveLength(acceptedWorkCheckpoints)
          const chatResponse = yield* Effect.promise(() =>
            secureRequestBody(`${server.serveUrl}/v1/chat`, requestHeaders)
          )
          expect(chatResponse.status).toBe(200)
          expect(Buffer.byteLength(chatResponse.body)).toBeLessThanOrEqual(
            fleetResponseBodyMaxBytes
          )
          expect(
            Schema.decodeUnknownSync(ChatHistory)(JSON.parse(chatResponse.body)).entries
          ).toHaveLength(chatHistoryMaxEntries)
          const agentIds: Array<string> = []
          let agentCursor: typeof FleetConnectAgentPage.Type["nextCursor"] = null
          do {
            const path = agentCursor === null
              ? "/v1/connect/agents"
              : `/v1/connect/agents?cursorHost=${encodeURIComponent(agentCursor.host)}&cursorId=${
                encodeURIComponent(agentCursor.id)
              }`
            const pageResponse = yield* Effect.promise(() =>
              secureRequestBody(`${server.serveUrl}${path}`, requestHeaders)
            )
            expect(pageResponse.status).toBe(200)
            expect(Buffer.byteLength(pageResponse.body)).toBeLessThanOrEqual(
              fleetResponseBodyMaxBytes
            )
            const page = Schema.decodeUnknownSync(FleetConnectAgentPage)(
              JSON.parse(pageResponse.body)
            )
            expect(page.agents.length).toBeLessThanOrEqual(connectAgentPageMaxRecords)
            for (const { id } of page.agents) agentIds.push(id)
            agentCursor = page.nextCursor
          } while (agentCursor !== null)
          expect(new Set(agentIds).size).toBe(130)
        }).pipe(Effect.scoped),
      (store) => Effect.sync(() => store.close())
    ).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("interrupts active runner work before close completes", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const runner = yield* makeRunner(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(interrupted, undefined).pipe(Effect.ignore))
        )
      )
      expect(yield* Effect.promise(() => runner.enqueue("job-1"))).toBe(true)
      yield* Deferred.await(started)
      yield* Effect.promise(runner.close)
      yield* Deferred.await(interrupted)
      expect(yield* Effect.promise(() => runner.enqueue("job-2"))).toBe(false)
    }))

  it.effect("interrupts active HTTP handlers before shutdown completes", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-handler-shutdown-test-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.scoped(Effect.gen(function*() {
          const entered = yield* Deferred.make<void>()
          const interrupted = yield* Deferred.make<void>()
          const fleet = yield* makeFleetService({
            approvalEnabled: false,
            host: "ALPHA",
            operations,
            store
          })
          const blockedFleet: FleetService = {
            ...fleet,
            status: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined).pipe(Effect.ignore))
              )
          }
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(config(root), blockedFleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          const request = yield* Effect.forkChild(
            Effect.tryPromise(() => fetch(`${server.url}/v1/status`))
          )
          yield* Deferred.await(entered)
          const closing = yield* Effect.forkChild(Effect.promise(server.close))
          yield* Deferred.await(interrupted)
          yield* Fiber.join(closing)
          expect(Result.isFailure(yield* Effect.result(Fiber.join(request)))).toBe(true)
        })),
      (store) => Effect.sync(() => store.close())
    ).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("rejects browser job submission but accepts originless JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-authority-test-"))
    const hostConfig = config(root)
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({
            approvalEnabled: false,
            host: hostConfig.host,
            operations,
            store
          })
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          const html = yield* Effect.promise(() => fetch(`${server.url}/`))
          expect(html.headers.get("content-security-policy")).toContain(
            "frame-ancestors 'none'"
          )
          expect(html.headers.get("x-frame-options")).toBe("DENY")
          const rebound = yield* Effect.promise(() => requestStatus(`${server.url}/v1/history`, "attacker.example"))
          expect(rebound).toBe(403)
          const hostile = yield* Effect.promise(() =>
            fetch(`${server.url}/v1/jobs`, {
              body: JSON.stringify({ payload: { kind: "nix.check" } }),
              headers: {
                "content-type": "text/plain",
                origin: "https://attacker.example"
              },
              method: "POST"
            })
          )
          expect(hostile.status).toBe(403)
          expect(yield* fleet.history(10)).toHaveLength(0)

          const accepted = yield* Effect.promise(() =>
            fetch(`${server.url}/v1/jobs`, {
              body: JSON.stringify({ payload: { kind: "nix.check" } }),
              headers: { "content-type": "application/json" },
              method: "POST"
            })
          )
          expect(accepted.status).toBe(202)
          expect(yield* fleet.history(10)).toHaveLength(1)
        }).pipe(Effect.scoped),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("rejects cross-site approval forms and accepts the listener origin", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-approval-origin-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"andrey@example.com"}}' ;;
  status) printf '%s\n' '{"Peer":{},"Self":{"HostName":"ALPHA","ID":"node-alpha","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    const hostConfig = {
      ...config(root),
      approvalPort: 0,
      crossHost: true,
      port: 0,
      tailscaleCommand
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({
            approvalEnabled: true,
            host: hostConfig.host,
            id: Effect.succeed("job-origin"),
            nonce: Effect.succeed("nonce-origin"),
            now: Effect.succeed(1_000),
            operations,
            store
          })
          const pending = yield* fleet.submit(
            { payload: { kind: "nix.apply", ref: "main" } },
            "submitter@example.com"
          )
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          if (server.approvalUrl === null) {
            return yield* Effect.die("approval listener missing")
          }
          const path = `/v1/jobs/${pending.id}/approve`
          const body = new URLSearchParams({
            hash: pending.hash,
            nonce: pending.approvalNonce ?? ""
          })
          const hostile = yield* Effect.promise(() =>
            fetch(`${server.approvalUrl}${path}`, {
              body,
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                origin: "https://attacker.example"
              },
              method: "POST",
              redirect: "manual"
            })
          )
          expect(hostile.status).toBe(403)
          expect((yield* fleet.get(pending.id)).status).toBe(
            "pending_approval"
          )

          const trusted = yield* Effect.promise(() =>
            fetch(`${server.approvalUrl}${path}`, {
              body: new URLSearchParams({
                hash: pending.hash,
                nonce: pending.approvalNonce ?? ""
              }),
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                origin: new URL(server.approvalUrl).origin
              },
              method: "POST",
              redirect: "manual"
            })
          )
          expect(trusted.status).toBe(303)
          expect((yield* fleet.get(pending.id)).status).not.toBe(
            "pending_approval"
          )
        }).pipe(Effect.scoped),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("routes encoded schema-valid job identifiers exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-job-route-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"andrey@example.com"}}' ;;
  status) printf '%s\n' '{"Peer":{},"Self":{"HostName":"ALPHA","ID":"node-alpha","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    const hostConfig = {
      ...config(root),
      approvalPort: 0,
      crossHost: true,
      port: 0,
      tailscaleCommand
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({
            approvalEnabled: true,
            host: hostConfig.host,
            id: Effect.succeed("job-🦊/with-slash"),
            nonce: Effect.succeed("nonce-route"),
            now: Effect.succeed(1_000),
            operations,
            store
          })
          const pending = yield* fleet.submit(
            { payload: { kind: "nix.apply", ref: "main" } },
            "submitter@example.com"
          )
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          if (server.approvalUrl === null) {
            return yield* Effect.die("approval listener missing")
          }
          const segment = encodeURIComponent(pending.id)
          const fetched = yield* Effect.promise(() => fetch(`${server.url}/v1/jobs/${segment}`))
          expect(fetched.status).toBe(200)
          expect(
            Schema.decodeUnknownSync(JobRecord)(yield* Effect.promise(() => fetched.json())).id
          ).toBe(pending.id)

          const decided = yield* Effect.promise(() =>
            fetch(`${server.approvalUrl}/v1/jobs/${segment}/approve`, {
              body: new URLSearchParams({
                hash: pending.hash,
                nonce: pending.approvalNonce ?? ""
              }),
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                origin: new URL(server.approvalUrl).origin
              },
              method: "POST",
              redirect: "manual"
            })
          )
          expect(decided.status).toBe(303)
          expect((yield* fleet.get(pending.id)).status).not.toBe("pending_approval")
          const localHost = new URL(server.url).host
          expect(yield* Effect.promise(() => requestStatus(`${server.url}/v1/jobs/job-🦊/with-slash`, localHost))).toBe(
            404
          )
          expect(yield* Effect.promise(() => requestStatus(`${server.url}/v1/jobs/%`, localHost))).toBe(400)
        }).pipe(Effect.scoped),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("finishes restart recovery before accepting jobs", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-recovery-test-"))
    return Effect.gen(function*() {
      const localPort = yield* Effect.promise(availablePort)
      const hostConfig = { ...config(root), localPort }
      const recoveryEntered = yield* Deferred.make<void>()
      const releaseRecovery = yield* Deferred.make<void>()
      yield* Effect.acquireUseRelease(
        JobStore.open(join(root, "jobs.sqlite")),
        (store) =>
          Effect.gen(function*() {
            const fleet = yield* makeFleetService({
              approvalEnabled: false,
              host: hostConfig.host,
              operations,
              store
            })
            const blockedFleet: FleetService = {
              ...fleet,
              recover: () =>
                Deferred.succeed(recoveryEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseRecovery)),
                  Effect.andThen(fleet.recover())
                )
            }
            const startup = yield* Effect.forkChild(
              Effect.promise(() =>
                startHttpServer(hostConfig, blockedFleet, assets, {
                  terminalConnector: unusedTerminal
                })
              )
            )
            yield* Deferred.await(recoveryEntered)
            const beforeRecovery = yield* Effect.result(
              Effect.tryPromise(() =>
                fetch(`http://127.0.0.1:${localPort}/v1/jobs`, {
                  body: JSON.stringify({ payload: { kind: "nix.check" } }),
                  headers: { "content-type": "application/json" },
                  method: "POST"
                })
              )
            )
            expect(Result.isFailure(beforeRecovery)).toBe(true)

            yield* Deferred.succeed(releaseRecovery, undefined)
            const server = yield* Fiber.join(startup)
            yield* Effect.addFinalizer(() => Effect.promise(server.close))
            const accepted = yield* Effect.promise(() =>
              fetch(`${server.url}/v1/jobs`, {
                body: JSON.stringify({ payload: { kind: "nix.check" } }),
                headers: { "content-type": "application/json" },
                method: "POST"
              })
            )
            expect(accepted.status).toBe(202)
          }).pipe(Effect.scoped),
        (store) => Effect.sync(() => store.close())
      )
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("does not run recovered work when listener startup fails", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-listen-failure-test-"))
    return Effect.gen(function*() {
      const localPort = yield* Effect.promise(availablePort)
      const hostConfig = { ...config(root), localPort }
      const operationStarted = yield* Deferred.make<void>()
      let runs = 0
      const recoveryOperations: HostOperations = {
        ...operations,
        run: () =>
          Effect.sync(() => {
            runs += 1
          }).pipe(
            Effect.andThen(Deferred.succeed(operationStarted, undefined)),
            Effect.as("recovered")
          )
      }
      yield* Effect.acquireUseRelease(
        JobStore.open(join(root, "jobs.sqlite")),
        (store) =>
          Effect.gen(function*() {
            const fleet = yield* makeFleetService({
              approvalEnabled: false,
              host: hostConfig.host,
              operations: recoveryOperations,
              store
            })
            yield* fleet.submit({ payload: { kind: "nix.check" } }, "local")
            yield* Effect.scoped(
              Effect.gen(function*() {
                const blocker = createServer()
                yield* Effect.promise(
                  () =>
                    new Promise<void>((resolve, reject) => {
                      blocker.once("error", reject)
                      blocker.listen(localPort, "127.0.0.1", resolve)
                    })
                )
                yield* Effect.addFinalizer(() =>
                  Effect.promise(
                    () => new Promise<void>((resolve) => blocker.close(() => resolve()))
                  )
                )
                const failed = yield* Effect.result(
                  Effect.tryPromise(() =>
                    startHttpServer(hostConfig, fleet, assets, {
                      terminalConnector: unusedTerminal
                    })
                  )
                )
                expect(Result.isFailure(failed)).toBe(true)
                expect(yield* Deferred.isDone(operationStarted)).toBe(false)
              })
            )

            const server = yield* Effect.acquireRelease(
              Effect.promise(() =>
                startHttpServer(hostConfig, fleet, assets, {
                  terminalConnector: unusedTerminal
                })
              ),
              (running) => Effect.promise(running.close)
            )
            yield* Deferred.await(operationStarted)
            expect(server.url).toContain(`:${localPort}`)
            expect(runs).toBe(1)
          }).pipe(Effect.scoped),
        (store) => Effect.sync(() => store.close())
      )
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("releases earlier resources when a later store cannot open", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-store-failure-test-"))
    const statePath = join(root, "approval-app.sqlite")
    const poisoned = new DatabaseSync(statePath)
    poisoned.exec("CREATE VIEW agent_activity AS SELECT 1 AS invalid")
    poisoned.close()
    const hostConfig = config(root)
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({
            approvalEnabled: false,
            host: hostConfig.host,
            operations,
            store
          })
          const failed = yield* Effect.result(
            Effect.tryPromise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: unusedTerminal
              })
            )
          )
          expect(Result.isFailure(failed)).toBe(true)

          const repaired = new DatabaseSync(statePath)
          repaired.exec("DROP VIEW agent_activity")
          repaired.close()
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          const response = yield* Effect.promise(() => fetch(`${server.url}/v1/status`))
          expect(response.status).toBe(200)
        }).pipe(Effect.scoped),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("releases a disconnected terminal open and closes a clean exit", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-terminal-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"andrey@example.com"}}' ;;
  status) printf '%s\n' '{"Peer":{},"Self":{"HostName":"ALPHA","ID":"node-alpha","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    const hostConfig = {
      ...config(root),
      approvalPort: 0,
      crossHost: true,
      port: 0,
      tailscaleCommand
    }
    return Effect.gen(function*() {
      const openStarted = yield* Deferred.make<void>()
      const openInterrupted = yield* Deferred.make<void>()
      const sendStarted = yield* Deferred.make<void>()
      const sendInterrupted = yield* Deferred.make<void>()
      const controllerReleaseStarted = yield* Deferred.make<void>()
      const allowControllerRelease = yield* Deferred.make<void>()
      const controllerReleaseFinished = yield* Deferred.make<void>()
      const shutdownReleaseStarted = yield* Deferred.make<void>()
      const allowShutdownRelease = yield* Deferred.make<void>()
      let opens = 0
      let sends = 0
      const connector: TerminalConnector = {
        open: () => {
          opens += 1
          const attempt = opens
          const session: TerminalSession = {
            events: attempt === 2
              ? Stream.empty
              : attempt === 4
              ? Stream.make({
                bytes: Buffer.alloc(
                  terminalFrameMaxEncodedBytes / 4 * 3
                ).toString("base64"),
                encoding: "ansi",
                full: true,
                height: 30,
                seq: 1,
                type: "terminal.frame",
                width: 100
              })
              : Stream.never,
            send: () =>
              attempt === 3
                ? Effect.sync(() => {
                  sends += 1
                }).pipe(
                  Effect.andThen(Deferred.succeed(sendStarted, undefined)),
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Deferred.succeed(sendInterrupted, undefined).pipe(
                      Effect.ignore
                    )
                  )
                )
                : Effect.void
          }
          return attempt === 1
            ? Deferred.succeed(openStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(openInterrupted, undefined).pipe(Effect.ignore))
            )
            : attempt === 5
            ? Effect.acquireRelease(
              Effect.succeed(session),
              () =>
                Deferred.succeed(
                  controllerReleaseStarted,
                  undefined
                ).pipe(
                  Effect.andThen(Deferred.await(allowControllerRelease)),
                  Effect.ensuring(
                    Deferred.succeed(
                      controllerReleaseFinished,
                      undefined
                    ).pipe(Effect.ignore)
                  )
                )
            )
            : attempt === 6
            ? Effect.acquireRelease(
              Effect.succeed(session),
              () =>
                Deferred.succeed(shutdownReleaseStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(allowShutdownRelease))
                )
            )
            : Effect.succeed(session)
        }
      }
      yield* Effect.acquireUseRelease(
        JobStore.open(join(root, "jobs.sqlite")),
        (store) =>
          Effect.gen(function*() {
            const fleet = yield* makeFleetService({
              approvalEnabled: false,
              host: hostConfig.host,
              operations,
              store
            })
            const server = yield* Effect.acquireRelease(
              Effect.promise(() =>
                startHttpServer(hostConfig, fleet, assets, {
                  terminalConnector: connector
                })
              ),
              (running) => Effect.promise(running.close)
            )
            if (server.tailnetUrl === null) return yield* Effect.die("tailnet listener missing")
            const url = new URL("/v1/connect/terminal", server.tailnetUrl)
            url.protocol = "ws:"
            url.searchParams.set("agent", "agent-1")
            url.searchParams.set("cols", "100")
            url.searchParams.set("host", hostConfig.host)
            url.searchParams.set("rows", "30")

            const first = yield* Effect.promise(
              () =>
                new Promise<WebSocketClient>((resolve, reject) => {
                  const socket = new WebSocketClient(url)
                  socket.once("error", reject)
                  socket.once("open", () => resolve(socket))
                })
            )
            yield* Deferred.await(openStarted)
            const firstClosed = new Promise<void>((resolve) => first.once("close", () => resolve()))
            first.send("x".repeat(terminalCommandMaxPayloadBytes + 1))
            yield* Effect.promise(() => firstClosed)
            yield* Deferred.await(openInterrupted)
            expect(
              (yield* Effect.promise(() => fetch(`${server.url}/v1/status`))).status
            ).toBe(200)

            const cleanClose = yield* Effect.promise(
              () =>
                new Promise<number>((resolve, reject) => {
                  const socket = new WebSocketClient(url)
                  socket.once("error", reject)
                  socket.once("close", (code) => resolve(code))
                })
            )
            expect(cleanClose).toBe(1_000)
            expect(opens).toBe(2)

            const queued = yield* Effect.promise(
              () =>
                new Promise<WebSocketClient>((resolve, reject) => {
                  const socket = new WebSocketClient(url)
                  socket.once("error", reject)
                  socket.once("message", () => resolve(socket))
                })
            )
            const command = JSON.stringify({
              text: "queued input",
              type: "terminal.input"
            })
            queued.send(command)
            yield* Deferred.await(sendStarted)
            const queuedClosed = new Promise<void>((resolve) => queued.once("close", () => resolve()))
            for (let index = 0; index < 65; index += 1) {
              queued.send(command)
            }
            yield* Effect.promise(() => queuedClosed)
            yield* Deferred.await(sendInterrupted)
            expect(sends).toBe(1)

            let maximumFrameBytes = 0
            const maximumFrameClose = yield* Effect.promise(
              () =>
                new Promise<number>((resolve, reject) => {
                  const socket = new WebSocketClient(url)
                  socket.once("error", reject)
                  socket.on("message", (data, isBinary) => {
                    if (isBinary) maximumFrameBytes = Buffer.byteLength(data)
                  })
                  socket.once("close", (code) => resolve(code))
                })
            )
            expect(maximumFrameClose).toBe(1_000)
            expect(maximumFrameBytes).toBe(
              terminalFrameMaxEncodedBytes / 4 * 3
            )

            const held = yield* Effect.promise(
              () =>
                new Promise<WebSocketClient>((resolve, reject) => {
                  const socket = new WebSocketClient(url)
                  socket.once("error", reject)
                  socket.once("message", () => resolve(socket))
                })
            )
            held.close()
            yield* Deferred.await(controllerReleaseStarted)
            const blockedDuplicate = yield* Effect.promise(
              () =>
                new Promise<number>((resolve, reject) => {
                  const socket = new WebSocketClient(url)
                  socket.once("error", reject)
                  socket.once("close", (code) => resolve(code))
                })
            )
            expect(blockedDuplicate).toBe(4_423)
            expect(opens).toBe(5)
            yield* Deferred.succeed(allowControllerRelease, undefined)
            yield* Deferred.await(controllerReleaseFinished)
            yield* Effect.yieldNow

            yield* Effect.promise(
              () =>
                new Promise<void>((resolve, reject) => {
                  const socket = new WebSocketClient(url)
                  socket.once("error", reject)
                  socket.once("open", () => resolve())
                })
            )
            const closeFinished = yield* Deferred.make<void>()
            const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
            const closing = server.close().then(() =>
              runPromise(
                Deferred.succeed(closeFinished, undefined).pipe(Effect.ignore)
              )
            )
            yield* Deferred.await(shutdownReleaseStarted)
            expect(yield* Deferred.isDone(closeFinished)).toBe(false)
            yield* Deferred.succeed(allowShutdownRelease, undefined)
            yield* Effect.promise(() => closing)
            expect(yield* Deferred.isDone(closeFinished)).toBe(true)
            expect(opens).toBe(6)
          }).pipe(Effect.scoped),
        (store) => Effect.sync(() => store.close())
      )
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  }, { timeout: 10_000 })

  it.effect("rejects an upgrade whose authorization finishes after shutdown starts", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-upgrade-shutdown-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    const authorizationStarted = join(root, "authorization-started")
    const releaseAuthorization = join(root, "release-authorization")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois)
    : > '${authorizationStarted}'
    while [ ! -e '${releaseAuthorization}' ]; do sleep 0.01; done
    printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"andrey@example.com"}}'
    ;;
  status) printf '%s\n' '{"Peer":{},"Self":{"HostName":"ALPHA","ID":"node-alpha","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    const hostConfig = {
      ...config(root),
      approvalPort: 0,
      crossHost: true,
      port: 0,
      tailscaleCommand
    }
    let opens = 0
    const connector: TerminalConnector = {
      open: () =>
        Effect.sync(() => {
          opens += 1
          return { events: Stream.never, send: () => Effect.void }
        })
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.scoped(Effect.gen(function*() {
          const fleet = yield* makeFleetService({
            approvalEnabled: false,
            host: hostConfig.host,
            operations,
            store
          })
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, fleet, assets, {
                terminalConnector: connector
              })
            ),
            (running) => Effect.promise(running.close)
          )
          if (server.tailnetUrl === null) return yield* Effect.die("tailnet listener missing")
          const url = new URL("/v1/connect/terminal", server.tailnetUrl)
          url.protocol = "ws:"
          url.searchParams.set("agent", "agent-1")
          url.searchParams.set("cols", "100")
          url.searchParams.set("host", hostConfig.host)
          url.searchParams.set("rows", "30")
          const socket = yield* Effect.acquireRelease(
            Effect.sync(() => new WebSocketClient(url)),
            (client) => Effect.sync(() => client.terminate())
          )
          const rejected = new Promise<string>((resolve) => {
            socket.once("unexpected-response", (_request, response) => {
              response.resume()
              resolve(`status:${response.statusCode}`)
            })
            socket.once("error", (error) => resolve(`error:${String(error)}`))
          })
          yield* waitForFile(authorizationStarted)
          const closing = server.close()
          writeFileSync(releaseAuthorization, "")
          expect(yield* Effect.promise(() => rejected)).toMatch(/^(?:status:503|error:Error: socket hang up)$/)
          yield* Effect.promise(() => closing)
          expect(opens).toBe(0)
        })),
      (store) => Effect.sync(() => store.close())
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          writeFileSync(releaseAuthorization, "")
          rmSync(root, { force: true, recursive: true })
        })
      ),
      provideNodeServices
    )
  }, { timeout: 10_000 })
})

describe("approval URL resolution", () => {
  it.effect("uses the local node's Tailscale address instead of loopback", () => {
    const tailscale: TailscaleClient = {
      ipv4: Effect.succeed("100.64.0.1"),
      status: Effect.succeed({
        Peer: {
          ser8: {
            DNSName: "ser8.example.test",
            HostName: "SER8",
            ID: "node-ser8",
            Online: true,
            TailscaleIPs: ["100.64.0.8"]
          }
        },
        Self: {
          DNSName: "alpha.example.test",
          HostName: "ALPHA",
          ID: "node-alpha",
          Online: true,
          TailscaleIPs: ["100.64.0.1"]
        }
      }),
      whois: () => Effect.die("unused")
    }
    const hostConfig = { ...config("/state"), crossHost: true }
    return Effect.gen(function*() {
      expect(yield* resolveApprovalPage(hostConfig, tailscale, "ALPHA")).toBe(
        "http://100.64.0.1:4779/"
      )
      expect(yield* resolveApprovalPage(hostConfig, tailscale, "SER8")).toBe(
        "https://ser8.example.test:4779/"
      )
    })
  })
})
