import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, it, vi } from "@effect/vitest"
import { makeDeterministicLanguageModel } from "@knpkv/ai-runtime"
import {
  ConnectAgent,
  connectAgentPageMaxRecords,
  ConnectArchivePage,
  ConnectPost,
  FleetConnectAgentPage,
  FleetLimits,
  FleetUsage,
  LocalConnectAgents,
  terminalCommandMaxPayloadBytes,
  type TerminalConnector,
  terminalFrameMaxEncodedBytes,
  TerminalSelection,
  type TerminalSession
} from "@knpkv/herdr-connect"
import { chatHistoryMaxEntries, ChatStore, type StoredChatTurn } from "@knpkv/herdr-coordinator"
import {
  FleetAuthorizationError,
  FleetOperationError,
  fleetResponseBodyMaxBytes,
  type FleetService,
  FleetStoreBusyError,
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
  WorkRecoveryContext,
  WorkSnapshots,
  WorkStore
} from "@knpkv/herdr-work"
import type { RelayBackend } from "@knpkv/relay"
import type { Scope } from "effect"
import {
  Clock,
  Data,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Predicate,
  Queue,
  Ref,
  Result,
  Schedule,
  Schema,
  Stream
} from "effect"
import { HttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { build } from "esbuild"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import WebSocketClient, { WebSocketServer } from "ws"
import { terminalConnectionAfterClose } from "../../herdr-connect/src/internal/terminal-connection.js"
import { SanitizedJobRecord } from "../src/approval-request.js"
import { resolveApprovalPage } from "../src/approval-url.js"
import { authorize } from "../src/auth.js"
import {
  DashboardSnapshot,
  FleetPendingApprovals,
  PendingApprovalSummary,
  PendingApprovalTarget
} from "../src/dashboard-model.js"
import { HostResources } from "../src/host-resources-model.js"
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
import { relayScrollState, remoteTerminalUrl, terminalSelectionInput } from "../src/internal/terminal-selection.js"
import { loadUiAssets } from "../src/internal/ui-assets.js"
import {
  isRelayedScrollState,
  makeLatestSignalSender,
  relayTerminalCloseCode,
  terminalBufferCanAccept,
  terminalBufferLimitBytes
} from "../src/internal/websocket.js"
import { defineModule } from "../src/module-contract.js"
import { ModuleHandlers, moduleReadRoute, moduleWriteRoute, type ServerModule } from "../src/module-server.js"
import { commandOutputMaxBytes } from "../src/operations.js"
import { makeRelayHubMount, type RelayHubBackends } from "../src/relay/mount.js"
import { ApprovalAppStore } from "../src/store.js"

// Each test effect is an application boundary; @effect/vitest scopes its Node services.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const config = (stateDirectory: string): HostConfiguration => ({
  allowedUsers: ["owner@example.com"],
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
  pushSubject: "mailto:owner@example.com",
  repository: "/repo",
  approvalTls: null,
  stateDirectory,
  tailscaleCommand: "tailscale"
})

const operations: HostOperations = {
  inspect: () =>
    Effect.succeed({
      applyConfigured: false,
      repository: { branch: "main", dirty: false, path: "/repo", revision: "abc123" }
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
  actor: "owner@example.com",
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

const relayPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

const assets = {
  connectScript: "",
  fonts: new Map<string, Uint8Array>(),
  icon: (file: string) => Promise.resolve(file === "relay-192.png" ? relayPng : null),
  script: "",
  stylesheet: "",
  worker: ""
}

/** Exercise controller admission through an authorized listener, with each resource scoped immediately. */
const controllerServer = Effect.fn("ControllerTest.server")(function*(connector: TerminalConnector) {
  const root = mkdtempSync(join(tmpdir(), "herdr-controller-test-"))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
  const tailscaleCommand = join(root, "tailscale-test")
  writeFileSync(
    tailscaleCommand,
    `#!/bin/sh
case "$1" in
  ip) printf '%s\\n' '127.0.0.1' ;;
  whois) printf '%s\\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
  status) printf '%s\\n' '{"Peer":{},"Self":{"HostName":"ALPHA","ID":"node-alpha","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
    { mode: 0o700 }
  )
  const hostConfig = { ...config(root), approvalPort: 0, crossHost: true, tailscaleCommand }
  const store = yield* Effect.acquireRelease(
    JobStore.open(join(root, "jobs.sqlite")),
    (opened) => Effect.sync(() => opened.close())
  )
  const fleet = yield* makeFleetService({ approvalEnabled: false, host: hostConfig.host, operations, store })
  const server = yield* Effect.acquireRelease(
    Effect.promise(() => startHttpServer(hostConfig, fleet, assets, { terminalConnector: connector })),
    (running) => Effect.promise(running.close)
  )
  if (server.tailnetUrl === null) return yield* Effect.die("tailnet listener missing")
  const url = new URL("/v1/connect/terminal", server.tailnetUrl)
  url.protocol = "ws:"
  url.searchParams.set("agent", "agent-controller")
  url.searchParams.set("host", hostConfig.host)
  url.searchParams.set("cols", "100")
  url.searchParams.set("rows", "30")
  return { url, close: server.close }
})

/** Register close and ready observations before a socket can receive its first server frame. */
const controllerClient = Effect.fn("ControllerTest.client")(function*(
  url: URL,
  autoPong = true,
  options: WebSocketClient.ClientOptions = {}
) {
  return yield* Effect.acquireRelease(
    Effect.sync(() => {
      const socket = new WebSocketClient(url, { ...options, autoPong })
      const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)))
      const closeEvent = new Promise<{ code: number; reason: string }>((resolve) =>
        socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))
      )
      const ready = new Promise<string | number>((resolve, reject) => {
        socket.once("error", reject)
        socket.once("message", () => resolve("ready"))
        socket.once("close", (code) => resolve(code))
      })
      return { socket, ready, closed, closeEvent }
    }),
    (client) => Effect.sync(() => client.socket.terminate())
  )
})

const approvalProofCookieCount = (response: Response): number =>
  response.headers.get("set-cookie")?.match(/fleet_approval_proof_/gu)?.length ?? 0

const directTls = {
  certificatePath: join(import.meta.dirname, "fixtures/ser8.example.test.crt"),
  privateKeyPath: join(import.meta.dirname, "fixtures/ser8.example.test.key")
}

/** A real hub-to-peer hop proves unsupported takeover never reaches an old host's upgrade handler. */
const terminalRelayFixture = Effect.fn("ControllerTest.relay")(function*(
  capability: "missing" | "false" | "invalid" | "redirect" | "transport" | "supported",
  beforeHubStart: (port: number) => Effect.Effect<void, ApprovalStartFailed, Scope.Scope> = () => Effect.void
) {
  const root = mkdtempSync(join(tmpdir(), "herdr-terminal-relay-"))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
  const probes: Array<string> = []
  const upgrades: Array<string> = []
  const sockets = new Set<WebSocketClient>()
  const webSockets = yield* Effect.acquireRelease(
    Effect.sync(() => new WebSocketServer({ noServer: true })),
    (server) =>
      Effect.sync(() => {
        for (const socket of sockets) socket.terminate()
        server.close()
      })
  )
  const peer = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createServer((request, response) => {
        if (request.url !== "/v1/connect/terminal/capabilities") {
          response.writeHead(404)
          response.end()
          return
        }
        probes.push(request.url ?? "")
        if (capability === "transport") {
          request.socket.destroy()
          return
        }
        if (capability === "redirect") {
          response.writeHead(302, { location: "/would-advertise-takeover" })
          response.end()
          return
        }
        response.writeHead(capability === "missing" ? 404 : 200, { "content-type": "application/json" })
        response.end(
          capability === "supported" ? "{\"takeover\":true}" : capability === "false" ? "{\"takeover\":false}" : "{}"
        )
      })
    ),
    (server) => Effect.promise(() => closePeer(server))
  )
  peer.on("upgrade", (request, socket, head) => {
    upgrades.push(request.url ?? "")
    webSockets.handleUpgrade(request, socket, head, (accepted) => {
      sockets.add(accepted)
      accepted.once("close", () => sockets.delete(accepted))
      accepted.send(JSON.stringify({ type: "terminal.ready" }))
    })
  })
  const tailscaleCommand = join(root, "tailscale-test")
  writeFileSync(
    tailscaleCommand,
    `#!/bin/sh
case "$1" in
  ip) printf '%s\\n' '127.0.0.1' ;;
  whois) printf '%s\\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
  status) printf '%s\\n' '{"Peer":{"ser9":{"HostName":"SER9","ID":"node-ser9","Online":true,"TailscaleIPs":["127.0.0.2"]}},"Self":{"HostName":"SER8","ID":"node-ser8","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
    { mode: 0o700 }
  )
  const store = yield* Effect.acquireRelease(
    JobStore.open(join(root, "jobs.sqlite")),
    (opened) => Effect.sync(() => opened.close())
  )
  const fleet = yield* makeFleetService({ approvalEnabled: false, host: "SER8", operations, store })
  const running = yield* Effect.acquireRelease(
    startWithPeerPort(
      peer,
      "127.0.0.2",
      (peerPort) =>
        beforeHubStart(peerPort).pipe(Effect.andThen(startWithApprovalPort(async (approvalPort) =>
          startHttpServer(
            {
              ...config(root),
              host: "SER8",
              crossHost: true,
              approvalHub: { host: "SER8", nodeId: "node-ser8", url: `https://127.0.0.1:${String(approvalPort)}/` },
              approvalPort,
              approvalTls: directTls,
              port: peerPort,
              machines: [{ host: "SER8", nodeId: "node-ser8" }, { host: "SER9", nodeId: "node-ser9" }],
              tailscaleCommand
            },
            fleet,
            assets,
            { terminalConnector: unusedTerminal }
          )
        )))
    ),
    (server) => Effect.promise(server.close)
  )
  if (running.serveUrl === null) return yield* Effect.die("hub listener missing")
  const url = new URL("/v1/connect/session?host=SER9&agent=agent-relayed&cols=100&rows=30&takeover=1", running.serveUrl)
  const origin = url.origin
  url.protocol = "wss:"
  return { url, origin, probes, upgrades, sockets }
})

const secureRequestBody = (
  url: string,
  headers: Readonly<Record<string, string>>,
  options: { readonly method?: string; readonly body?: unknown } = {}
): Promise<{ readonly body: string; readonly setCookie: string | undefined; readonly status: number }> =>
  new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      { headers, rejectUnauthorized: false, method: options.method },
      (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => {
          body += chunk
        })
        response.once("end", () =>
          resolve({
            body,
            setCookie: response.headers["set-cookie"]?.[0],
            status: response.statusCode ?? 0
          }))
      }
    )
    request.once("error", reject)
    request.end(options.body === undefined ? undefined : JSON.stringify(options.body))
  })

/**
 * Picks a free loopback port and releases it. Another process can take it
 * before the caller binds it, so use it only when a port must be known before
 * any listener exists; otherwise bind port 0 and read the bound address.
 */
const reserveLoopbackPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const reservation = createServer()
    reservation.once("error", reject)
    // ast-grep-ignore: no-released-ephemeral-test-port -- one test must probe a port before hostd binds it (see its use).
    reservation.listen(0, "127.0.0.1", () => {
      let port: number
      try {
        port = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(reservation.address()).port
      } catch (error) {
        reservation.close()
        reject(error)
        return
      }
      reservation.close((error) => error === undefined ? resolve(port) : reject(error))
    })
  })

const AddressInUse = Schema.Struct({ code: Schema.Literal("EADDRINUSE"), port: Schema.Number })
const isAddressInUse = Schema.is(AddressInUse)

/** Another process took the reserved approval port before hostd bound it. */
class ApprovalPortTaken extends Data.TaggedError("ApprovalPortTaken")<{ readonly cause: unknown }> {}

/** Hostd failed to start for a reason other than a taken port. */
class ApprovalStartFailed extends Data.TaggedError("ApprovalStartFailed")<{ readonly cause: unknown }> {}

/**
 * Starts hostd with an approval-hub port chosen up front. The serve listener
 * checks the Host header against `approvalHub.url`, so that one port must be
 * known before binding; every other listener should bind port 0 and be read
 * back from the started server. A reserved port can be taken by another
 * process before hostd binds it, so a start that fails with EADDRINUSE on that
 * port retries with a fresh reservation, up to five attempts in all.
 */
const startWithApprovalPort = <A>(
  start: (approvalPort: number) => Promise<A>
): Effect.Effect<A, ApprovalPortTaken | ApprovalStartFailed> =>
  Effect.tryPromise({
    try: reserveLoopbackPort,
    catch: (cause) => new ApprovalStartFailed({ cause })
  }).pipe(
    Effect.flatMap((approvalPort) =>
      Effect.tryPromise({
        try: () => start(approvalPort),
        // Only a collision on the reserved port is worth a new reservation; any
        // other listener's EADDRINUSE would fail the same way again.
        catch: (cause) =>
          isAddressInUse(cause) && cause.port === approvalPort
            ? new ApprovalPortTaken({ cause })
            : new ApprovalStartFailed({ cause })
      })
    ),
    Effect.retry({ times: 4, while: (error) => error._tag === "ApprovalPortTaken" })
  )

/**
 * Binds `server` to an ephemeral port on `host` and returns the port it got.
 * A listener whose address can't be read is closed before the promise rejects.
 */
const listenOn = (server: ReturnType<typeof createServer>, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, host, () => {
      const address = Schema.decodeUnknownResult(Schema.Struct({ port: Schema.Number }))(server.address())
      if (Result.isFailure(address)) server.close(() => reject(address.failure))
      else resolve(address.success.port)
    })
  })

/** Failed startup may already have closed this owned peer. */
const closePeer = (peer: ReturnType<typeof createServer>): Promise<void> =>
  peer.listening
    ? new Promise((resolve, reject) => peer.close((error) => error === undefined ? resolve() : reject(error)))
    : Promise.resolve()

/** A peer's chosen port was occupied on the hub's different loopback address. */
class SharedPeerPortTaken extends Data.TaggedError("SharedPeerPortTaken")<{ readonly cause: unknown }> {}

/** Bind the owned peer to port 0; close failed pairs before retrying only that shared-port collision. */
const startWithPeerPort = Effect.fn("HttpTest.startWithPeerPort")(function*<A, R>(
  peer: ReturnType<typeof createServer>,
  host: string,
  start: (port: number) => Effect.Effect<A, ApprovalPortTaken | ApprovalStartFailed, R>
) {
  const attempt = Effect.gen(function*() {
    const port = yield* Effect.tryPromise({
      try: () => listenOn(peer, host),
      catch: (cause) => new ApprovalStartFailed({ cause })
    })
    const result = yield* Effect.result(start(port))
    if (Result.isSuccess(result)) return result.success
    // startHttpServer closes every listener it acquired before rejecting; the peer is ours to close.
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => peer.close((error) => error === undefined ? resolve() : reject(error))),
      catch: (cause) => new ApprovalStartFailed({ cause })
    })
    const error = result.failure
    return yield* isAddressInUse(error.cause) && error.cause.port === port
      ? new SharedPeerPortTaken({ cause: error.cause })
      : error
  })
  return yield* attempt.pipe(Effect.retry({ times: 4, while: (error) => error._tag === "SharedPeerPortTaken" }))
})

/** A hub and peer pair started on the peer's ports, or the hub found one of those ports taken on its address. */
type PairStart =
  | {
    readonly _tag: "Started"
    readonly approvalPort: number
    readonly mainServer: StartedHttpServer
    readonly peerServer: StartedHttpServer
  }
  | { readonly _tag: "PortTaken"; readonly cause: unknown }

type StartedHttpServer = Awaited<ReturnType<typeof startHttpServer>>

/** The port a started listener actually bound, read from its URL; a listener that did not start throws. */
const boundPort = (url: string | null): number => Number(new URL(url ?? "").port)

let fleetctlEntry: Promise<string> | undefined
let fleetctlFixtureDirectory: string | undefined

afterAll(() => {
  if (fleetctlFixtureDirectory !== undefined) rmSync(fleetctlFixtureDirectory, { force: true, recursive: true })
})

/** Builds the shared CLI fixture only when a test first needs a CLI process. */
const buildFleetctlEntry = async (): Promise<string> => {
  const suppliedEntry = process.env.FLEETCTL_TEST_ENTRY
  if (suppliedEntry !== undefined) return suppliedEntry
  fleetctlFixtureDirectory = mkdtempSync(join(tmpdir(), "herdr-http-fleetctl-"))
  const entry = join(fleetctlFixtureDirectory, "fleetctl.cjs")
  // Reuse one bundle: repeated node/tsx dependency loading dominates the CLI integration tests.
  await build({
    bundle: true,
    entryPoints: [join(import.meta.dirname, "../src/fleetctl.ts")],
    format: "cjs",
    outfile: entry,
    platform: "node"
  })
  return entry
}

const workPreflightFromFleetctl = async (
  operation: "admission-preflight" | "recovery-preflight" | "recovery-context",
  configPath: string,
  targetJson: string | undefined,
  host = "SER8"
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
  const entry = await (fleetctlEntry ??= buildFleetctlEntry())
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      entry,
      "work",
      operation,
      host,
      ...(targetJson === undefined ? [] : [targetJson])
    ], {
      env: {
        ...process.env,
        FLEET_CONFIG_PATH: configPath,
        // Synthetic TLS certificate only; the real listener still authorizes every request.
        NODE_TLS_REJECT_UNAUTHORIZED: host === "SER8" ? "0" : process.env.NODE_TLS_REJECT_UNAUTHORIZED
      }
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
}

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

describe("approval port reservation", () => {
  const inUse = (port: number) => Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE", port })
  const collision = (approvalPort: number) => inUse(approvalPort)
  const startFailingTimes = (failures: number, error: (approvalPort: number) => Error) => {
    let attempts = 0
    const start = async (approvalPort: number) => {
      attempts += 1
      if (attempts <= failures) throw error(approvalPort)
      return approvalPort
    }
    return { attempts: () => attempts, start }
  }

  it.effect("retries a start whose reserved port was taken", () =>
    Effect.gen(function*() {
      const starter = startFailingTimes(2, collision)
      const port = yield* startWithApprovalPort(starter.start)
      expect(port).toBeGreaterThan(0)
      expect(starter.attempts()).toBe(3)
    }))

  it.effect("fails typed after five taken ports", () =>
    Effect.gen(function*() {
      const starter = startFailingTimes(5, collision)
      const error = yield* Effect.flip(startWithApprovalPort(starter.start))
      expect(error._tag).toBe("ApprovalPortTaken")
      expect(starter.attempts()).toBe(5)
    }))

  it.effect("does not retry a collision on another listener's port", () =>
    Effect.gen(function*() {
      const starter = startFailingTimes(1, (approvalPort) => inUse(approvalPort + 1))
      const error = yield* Effect.flip(startWithApprovalPort(starter.start))
      expect(error._tag).toBe("ApprovalStartFailed")
      expect(starter.attempts()).toBe(1)
    }))

  it.effect("does not retry any other start failure", () =>
    Effect.gen(function*() {
      const starter = startFailingTimes(1, () => new Error("bad config"))
      const error = yield* Effect.flip(startWithApprovalPort(starter.start))
      expect(error._tag).toBe("ApprovalStartFailed")
      expect(starter.attempts()).toBe(1)
    }))
})

describe("shared peer port startup", () => {
  it.effect("closes every failed peer and preserves the fifth shared-port error", () =>
    Effect.gen(function*() {
      const peer = yield* Effect.acquireRelease(
        Effect.sync(() => createServer()),
        (server) => Effect.promise(() => closePeer(server))
      )
      let attempts = 0
      let closed = 0
      let lastPort = 0
      peer.on("close", () => {
        closed += 1
      })
      const failure = yield* Effect.flip(startWithPeerPort(peer, "127.0.0.2", (port) => {
        attempts += 1
        lastPort = port
        expect(peer.listening).toBe(true)
        return Effect.fail(new ApprovalStartFailed({ cause: { code: "EADDRINUSE", port } }))
      }))
      expect(failure).toMatchObject({ _tag: "SharedPeerPortTaken", cause: { code: "EADDRINUSE", port: lastPort } })
      expect(attempts).toBe(5)
      expect(closed).toBe(5)
      expect(peer.listening).toBe(false)
    }).pipe(Effect.scoped))

  it.effect.each(["another port", "another failure"])("closes without retrying %s", (kind) =>
    Effect.gen(function*() {
      const peer = yield* Effect.acquireRelease(
        Effect.sync(() => createServer()),
        (server) => Effect.promise(() => closePeer(server))
      )
      let attempts = 0
      let original: ApprovalStartFailed | undefined
      const failure = yield* Effect.flip(startWithPeerPort(peer, "127.0.0.2", (port) => {
        attempts += 1
        original = new ApprovalStartFailed({
          cause: {
            code: kind === "another port" ? "EADDRINUSE" : "EACCES",
            port: kind === "another port" ? port + 1 : port
          }
        })
        return Effect.fail(original)
      }))
      expect(failure).toBe(original)
      expect(attempts).toBe(1)
      expect(peer.listening).toBe(false)
    }).pipe(Effect.scoped))
})

describe("host HTTP authority", () => {
  for (const discoveryFails of [true, false]) {
    it.live(
      discoveryFails
        ? "delivers local blocked notifications when peer discovery fails"
        : "delivers local and peer blocked notifications when discovery is healthy",
      () => {
        const root = mkdtempSync(join(tmpdir(), "herdr-http-local-push-"))
        return Effect.gen(function*() {
          yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
          const tailscaleCommand = join(root, "tailscale-test")
          writeFileSync(
            tailscaleCommand,
            `#!/bin/sh
case "$1" in
  ip) printf '%s\\n' '127.0.0.1' ;;
  status) ${
              discoveryFails
                ? "exit 1"
                : `printf '%s\\n' '{"Peer":{"alpha":{"HostName":"ALPHA","ID":"node-alpha","Online":true,"TailscaleIPs":["127.0.0.2"]}},"Self":{"HostName":"SER8","ID":"node-ser8","Online":true,"TailscaleIPs":["127.0.0.1"]}}'`
            } ;;
esac
`,
            { mode: 0o700 }
          )
          const peerServer = createServer((request, response) => {
            response.writeHead(request.url === "/v1/connect/agents/local" ? 200 : 404, {
              "content-type": "application/json"
            })
            response.end(JSON.stringify({
              host: "ALPHA",
              complete: true,
              agents: [{
                host: "ALPHA",
                id: "agent-peer",
                name: "peer worker",
                kind: "worker",
                state: "blocked",
                work: "project",
                lastActivityAt: 0
              }]
            }))
          })
          yield* Effect.acquireRelease(
            Effect.sync(() => peerServer),
            (server) => Effect.promise(() => closePeer(server))
          )
          const subscriptions = yield* Effect.acquireRelease(
            ApprovalAppStore.open(join(root, "approval-app.sqlite")),
            (opened) => Effect.sync(() => opened.close())
          )
          yield* subscriptions.putSubscription({
            endpoint: "https://push.example.test/local",
            expirationTime: null,
            keys: { auth: "auth_key", p256dh: "public_key" }
          }, "owner@example.com")
          const jobs = yield* Effect.acquireRelease(
            JobStore.open(join(root, "jobs.sqlite")),
            (opened) => Effect.sync(() => opened.close())
          )
          const fleet = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            store: jobs,
            operations: {
              ...operations,
              listAgents: () =>
                Effect.succeed({
                  available: true,
                  error: null,
                  agents: [{
                    activityRevision: 1,
                    agentId: "agent-local",
                    kind: "worker",
                    name: "local worker",
                    paneId: "w1:p1",
                    parentAgentId: null,
                    relation: null,
                    status: "blocked",
                    work: "project"
                  }]
                })
            }
          })
          const delivered = yield* Deferred.make<void>()
          const sent = yield* Ref.make<ReadonlyArray<{ readonly host: string; readonly agentId: string }>>([])
          yield* Effect.acquireRelease(
            startWithPeerPort(peerServer, "127.0.0.2", (peerPort) =>
              Effect.tryPromise({
                try: () =>
                  startHttpServer(
                    {
                      ...config(root),
                      host: "SER8",
                      crossHost: true,
                      port: peerPort,
                      approvalPort: 0,
                      approvalTls: directTls,
                      approvalHub: { host: "SER8", nodeId: "node-ser8", url: "https://ser8.example.test:0/" },
                      tailscaleCommand
                    },
                    fleet,
                    assets,
                    {
                      terminalConnector: unusedTerminal,
                      pushSender: (_target, payload) =>
                        "kind" in payload && payload.kind === "agent-blocked"
                          ? Ref.updateAndGet(
                            sent,
                            (values) => [...values, { host: payload.host, agentId: payload.agentId }]
                          ).pipe(
                            Effect.flatMap((values) =>
                              values.length === (discoveryFails ? 1 : 2)
                                ? Deferred.succeed(delivered, undefined).pipe(Effect.asVoid)
                                : Effect.void
                            )
                          )
                          : Effect.void
                    }
                  ),
                catch: (cause) => new ApprovalStartFailed({ cause })
              })),
            (running) => Effect.promise(running.close)
          )
          yield* Deferred.await(delivered).pipe(Effect.timeout("3 seconds"))
          const payloads = yield* Ref.get(sent)
          expect(payloads).toHaveLength(discoveryFails ? 1 : 2)
          expect(payloads).toEqual(expect.arrayContaining(
            discoveryFails
              ? [{ host: "ser8", agentId: "agent-local" }]
              : [{ host: "ser8", agentId: "agent-local" }, { host: "alpha", agentId: "agent-peer" }]
          ))
        }).pipe(Effect.scoped, provideNodeServices)
      }
    )
  }

  it.effect("serves a sanitized request and keeps it after a bodyless approval", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-approval-request-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
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
          const prooflessPending: JobRecord = {
            actor: "submitter@example.com",
            approvalNonce: null,
            approvedBy: null,
            createdAt: 900,
            error: null,
            hash: "b".repeat(64),
            id: "proofless-pending",
            payload: pending.payload,
            result: null,
            status: "pending_approval",
            updatedAt: 900
          }
          yield* store.put(prooflessPending)
          let failApproval = true
          // Completes once the host runner has finished the approved job and
          // persisted its final status, so the test waits on that transition
          // instead of guessing how many scheduler turns it takes.
          const jobSettled = yield* Deferred.make<void>()
          const retryableFleet: FleetService = {
            ...fleet,
            run: (jobId) => fleet.run(jobId).pipe(Effect.onExit(() => Deferred.succeed(jobSettled, undefined))),
            approve: (jobId, approval, actor) => {
              if (failApproval) {
                failApproval = false
                // The job store is locked once: a retryable 503, and the approval proof must survive it so a retry succeeds.
                return Effect.fail(
                  new FleetStoreBusyError({
                    cause: "transient test failure",
                    detail: "database is locked",
                    operation: "transition"
                  })
                )
              }
              return fleet.approve(jobId, approval, actor)
            }
          }
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, retryableFleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          const approvalUrl = server.approvalUrl
          if (approvalUrl === null) {
            return yield* Effect.die("approval listener missing")
          }
          const headers = {
            "tailscale-user-login": "owner@example.com"
          }
          for (const route of ["/v1/modules/connect/needs-you", "/v1/modules/unknown/read", "/v1/modules"]) {
            const response = yield* Effect.promise(() => fetch(`${approvalUrl}${route}`, { headers }))
            expect(response.status).toBe(404)
          }
          const dashboardResponse = yield* Effect.promise(() => fetch(`${approvalUrl}/v1/dashboard`, { headers }))
          const dashboard = yield* Effect.promise(() => dashboardResponse.text())
          const proofCookie = dashboardResponse.headers.get("set-cookie")
          if (proofCookie === null) {
            return yield* new FleetValidationError({ detail: "approval proof cookie missing from dashboard" })
          }
          const proofCookieHeader = proofCookie.split(";", 1).join("")
          expect(dashboardResponse.headers.get("cache-control")).toBe("no-store")
          expect(dashboard).toContain("[redacted internal prompt]")
          expect(dashboard).not.toContain("raw terminal prompt")
          expect(dashboard).not.toContain("secret-value")
          expect(dashboard).not.toContain(pending.hash)
          expect(dashboard).not.toContain("nonce-disclosure")
          const dashboardSnapshot = Schema.decodeUnknownSync(DashboardSnapshot)(JSON.parse(dashboard))
          expect(
            dashboardSnapshot.pendingApprovals.local.find(({ id }) => id === prooflessPending.id)
          ).toMatchObject({ approvalAvailable: false, id: prooflessPending.id })
          expect(
            dashboardSnapshot.pendingApprovals.local.find(({ id }) => id === pending.id)
          ).toMatchObject({ approvalAvailable: true, id: pending.id })
          const page = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/`, { headers }).then((response) => {
              expect(response.headers.get("cache-control")).toBe("no-store")
              return response.text()
            })
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

          const prooflessDecision = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/${prooflessPending.id}/approve`, {
              headers: {
                ...headers,
                cookie: proofCookieHeader,
                origin: new URL(approvalUrl).origin
              },
              method: "POST"
            })
          )
          expect(prooflessDecision.status).toBe(409)
          yield* Effect.promise(() => prooflessDecision.text())

          const transientFailure = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/${pending.id}/approve`, {
              headers: {
                ...headers,
                cookie: proofCookieHeader,
                origin: new URL(approvalUrl).origin
              },
              method: "POST"
            })
          )
          expect(transientFailure.status).toBe(503)
          // Decoding fails the test unless the 503 names the retryable busy store.
          yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Struct({ error: Schema.Literal("FleetStoreBusyError") }))
          )(yield* Effect.promise(() => transientFailure.text()))

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

          yield* Deferred.await(jobSettled)
          const terminal = yield* fleet.get(pending.id)
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

  it.effect("binds bodyless approval proofs to their browser session", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-proof-session-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
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
    let observedAt = 0
    let pendingApprovalsEnumerations = 0
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const initialRefreshStarted = yield* Deferred.make<void>()
          const initialReleaseRefresh = yield* Deferred.make<void>()
          const overlapRefreshStarted = yield* Deferred.make<void>()
          const overlapReleaseRefresh = yield* Deferred.make<void>()
          let refreshGate = {
            release: initialReleaseRefresh,
            started: initialRefreshStarted
          }
          let pausePendingRefresh = false
          yield* Effect.forEach(
            Array.from({ length: pendingApprovalPageMaxRecords + 1 }, (_, index) => pendingRecord("ALPHA", index)),
            (record) => store.put(record),
            { discard: true }
          )
          const fleet = yield* makeFleetService({
            approvalEnabled: true,
            host: hostConfig.host,
            operations,
            store
          })
          const instrumentedFleet: FleetService = {
            ...fleet,
            pendingApprovals: () => {
              pendingApprovalsEnumerations += 1
              return fleet.pendingApprovals()
            },
            get: (jobId) => {
              const pending = fleet.get(jobId)
              if (!pausePendingRefresh) return pending
              pausePendingRefresh = false
              return pending.pipe(
                Effect.flatMap((record) =>
                  Deferred.succeed(refreshGate.started, undefined).pipe(
                    Effect.andThen(Deferred.await(refreshGate.release)),
                    Effect.as(record)
                  )
                )
              )
            }
          }
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, instrumentedFleet, assets, {
                now: () => observedAt,
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          const approvalUrl = server.approvalUrl
          if (approvalUrl === null) {
            return yield* new FleetValidationError({ detail: "approval listener missing" })
          }
          const headers = { "tailscale-user-login": "owner@example.com" }
          const origin = new URL(approvalUrl).origin
          const dashboardA = yield* Effect.promise(() => fetch(`${approvalUrl}/v1/dashboard`, { headers }))
          const cookieA = dashboardA.headers.get("set-cookie")?.split(";", 1).join("")
          if (cookieA === undefined) {
            return yield* new FleetValidationError({ detail: "first approval proof cookie missing" })
          }
          expect(dashboardA.headers.get("cache-control")).toBe("no-store")
          expect(dashboardA.headers.get("set-cookie")).not.toContain("Secure")
          const dashboardAData = Schema.decodeUnknownSync(DashboardSnapshot)(
            JSON.parse(yield* Effect.promise(() => dashboardA.text()))
          )
          const continuation = dashboardAData.pendingApprovals.nextCursors.at(0)
          if (continuation === undefined) {
            return yield* new FleetValidationError({ detail: "approval continuation missing" })
          }
          const dashboardB = yield* Effect.promise(() => fetch(`${approvalUrl}/v1/dashboard`, { headers }))
          const cookieB = dashboardB.headers.get("set-cookie")?.split(";", 1).join("")
          if (cookieB === undefined || cookieB === cookieA) {
            return yield* new FleetValidationError({ detail: "approval proof sessions were not isolated" })
          }
          yield* Effect.promise(() => dashboardB.text())
          const dashboardC = yield* Effect.promise(() => fetch(`${approvalUrl}/v1/dashboard`, { headers }))
          const cookieC = dashboardC.headers.get("set-cookie")?.split(";", 1).join("")
          if (cookieC === undefined || cookieC === cookieA || cookieC === cookieB) {
            return yield* new FleetValidationError({ detail: "third approval proof session was not isolated" })
          }
          yield* Effect.promise(() => dashboardC.text())
          const parameters = new URLSearchParams({
            cursorCreatedAt: String(continuation.cursor.createdAt),
            cursorHost: continuation.host,
            cursorId: continuation.cursor.id
          })
          const firstConcurrentPending = pendingRecord("ALPHA", 200)
          pausePendingRefresh = true
          const firstRefresh = yield* Effect.forkChild(
            Effect.promise(() =>
              fetch(`${approvalUrl}/v1/dashboard-pending?${parameters.toString()}`, {
                headers: { ...headers, cookie: cookieA }
              })
            )
          )
          yield* Deferred.await(initialRefreshStarted)
          yield* store.put(firstConcurrentPending)
          const firstDisclosure = yield* Effect.promise(() =>
            fetch(
              `${approvalUrl}/v1/pending-approval?host=ALPHA&jobId=${firstConcurrentPending.id}`,
              { headers }
            )
          )
          expect(firstDisclosure.status).toBe(200)
          const firstCookie = firstDisclosure.headers.get("set-cookie")?.split(";", 1).join("")
          if (firstCookie === undefined) {
            return yield* new FleetValidationError({ detail: "initial concurrent proof cookie missing" })
          }
          expect(firstDisclosure.headers.get("cache-control")).toBe("no-store")
          yield* Effect.promise(() => firstDisclosure.text())
          yield* Deferred.succeed(initialReleaseRefresh, undefined)
          const firstRefreshResponse = yield* Fiber.join(firstRefresh)
          expect(firstRefreshResponse.status).toBe(200)
          expect(firstRefreshResponse.headers.get("cache-control")).toBe("no-store")
          yield* Effect.promise(() => firstRefreshResponse.text())
          const firstContinuation = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/dashboard-pending?${parameters.toString()}`, {
              headers: { ...headers, cookie: firstCookie }
            })
          )
          expect(firstContinuation.status).toBe(200)
          yield* Effect.promise(() => firstContinuation.text())
          const firstDecision = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/${firstConcurrentPending.id}/approve`, {
              headers: { ...headers, cookie: firstCookie, origin },
              method: "POST"
            })
          )
          expect(firstDecision.status).toBe(200)
          yield* Effect.promise(() => firstDecision.text())
          const staleSnapshotPending = pendingRecord("ALPHA", 102)
          yield* store.put(staleSnapshotPending)
          const staleSnapshotDisclosure = yield* Effect.promise(() =>
            fetch(
              `${approvalUrl}/v1/pending-approval?host=ALPHA&jobId=${staleSnapshotPending.id}`,
              { headers: { ...headers, cookie: cookieA } }
            )
          )
          expect(staleSnapshotDisclosure.status).toBe(200)
          yield* Effect.promise(() => staleSnapshotDisclosure.text())
          const staleSnapshotContinuation = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/dashboard-pending?${parameters.toString()}`, {
              headers: { ...headers, cookie: cookieA }
            })
          )
          expect(staleSnapshotContinuation.status).toBe(200)
          yield* Effect.promise(() => staleSnapshotContinuation.text())
          const staleSnapshotDecision = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/${staleSnapshotPending.id}/approve`, {
              headers: { ...headers, cookie: cookieA, origin },
              method: "POST"
            })
          )
          expect(staleSnapshotDecision.status).toBe(200)
          yield* Effect.promise(() => staleSnapshotDecision.text())
          const continuationResponse = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/dashboard-pending?${parameters.toString()}`, {
              headers: { ...headers, cookie: cookieA }
            })
          )
          expect(continuationResponse.status).toBe(200)
          const continuationBody = yield* Effect.promise(() => continuationResponse.text())
          expect(continuationBody).toContain("alpha-job-00")
          const secondSessionContinuation = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/dashboard-pending?${parameters.toString()}`, {
              headers: { ...headers, cookie: cookieB }
            })
          )
          expect(secondSessionContinuation.status).toBe(200)
          yield* Effect.promise(() => secondSessionContinuation.text())
          expect(pendingApprovalsEnumerations).toBe(0)
          const newlyPending = pendingRecord("ALPHA", 100)
          yield* store.put(newlyPending)
          const dashboardD = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/dashboard`, { headers: { ...headers, cookie: cookieB } })
          )
          const cookieD = dashboardD.headers.get("set-cookie")?.split(";", 1).join("")
          if (cookieD === undefined) {
            return yield* new FleetValidationError({ detail: "new approval proof session missing" })
          }
          const dashboardDData = Schema.decodeUnknownSync(DashboardSnapshot)(
            JSON.parse(yield* Effect.promise(() => dashboardD.text()))
          )
          if (!dashboardDData.pendingApprovals.local.some(({ id }) => id === newlyPending.id)) {
            return yield* new FleetValidationError({ detail: "new pending approval missing from first page" })
          }
          const newContinuation = dashboardDData.pendingApprovals.nextCursors.at(0)
          if (newContinuation === undefined) {
            return yield* new FleetValidationError({ detail: "new approval continuation missing" })
          }
          const newContinuationParameters = new URLSearchParams({
            cursorCreatedAt: String(newContinuation.cursor.createdAt),
            cursorHost: newContinuation.host,
            cursorId: newContinuation.cursor.id
          })
          const newContinuationResponse = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/dashboard-pending?${newContinuationParameters.toString()}`, {
              headers: { ...headers, cookie: cookieD }
            })
          )
          expect(newContinuationResponse.status).toBe(200)
          yield* Effect.promise(() => newContinuationResponse.text())
          const newDecision = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/${newlyPending.id}/approve`, {
              headers: { ...headers, cookie: cookieD, origin },
              method: "POST"
            })
          )
          expect(newDecision.status).toBe(200)
          yield* Effect.promise(() => newDecision.text())
          observedAt = 60 * 1_000
          const refreshedSessionContinuation = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/dashboard-pending?${parameters.toString()}`, {
              headers: { ...headers, cookie: cookieB }
            })
          )
          expect(refreshedSessionContinuation.status).toBe(200)
          yield* Effect.promise(() => refreshedSessionContinuation.text())
          expect(pendingApprovalsEnumerations).toBe(0)
          const wrongSessionDecision = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/alpha-job-00/approve`, {
              headers: { ...headers, cookie: cookieC, origin },
              method: "POST"
            })
          )
          expect(wrongSessionDecision.status).toBe(409)
          yield* Effect.promise(() => wrongSessionDecision.text())
          const matchingSessionDecision = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/alpha-job-00/approve`, {
              headers: { ...headers, cookie: cookieA, origin },
              method: "POST"
            })
          )
          expect(matchingSessionDecision.status).toBe(200)
          yield* Effect.promise(() => matchingSessionDecision.text())

          const concurrentPending = pendingRecord("ALPHA", 101)
          observedAt = 120 * 1_000
          refreshGate = {
            release: overlapReleaseRefresh,
            started: overlapRefreshStarted
          }
          pausePendingRefresh = true
          yield* store.put(concurrentPending)
          const concurrentDisclosureFiber = yield* Effect.forkChild(
            Effect.promise(() =>
              fetch(
                `${approvalUrl}/v1/pending-approval?host=ALPHA&jobId=${concurrentPending.id}`,
                { headers: { ...headers, cookie: cookieB } }
              )
            )
          )
          yield* Deferred.await(overlapRefreshStarted)
          const staleRefresh = yield* Effect.forkChild(
            Effect.promise(() =>
              fetch(`${approvalUrl}/v1/dashboard-pending?${newContinuationParameters.toString()}`, {
                headers: { ...headers, cookie: cookieA }
              })
            )
          )
          yield* Deferred.succeed(overlapReleaseRefresh, undefined)
          const concurrentDisclosure = yield* Fiber.join(concurrentDisclosureFiber)
          expect(concurrentDisclosure.status).toBe(200)
          yield* Effect.promise(() => concurrentDisclosure.text())
          const staleRefreshResponse = yield* Fiber.join(staleRefresh)
          expect(staleRefreshResponse.status).toBe(200)
          yield* Effect.promise(() => staleRefreshResponse.text())
          expect(pendingApprovalsEnumerations).toBe(0)
          const concurrentContinuation = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/dashboard-pending?${newContinuationParameters.toString()}`, {
              headers: { ...headers, cookie: cookieB }
            })
          )
          expect(concurrentContinuation.status).toBe(200)
          yield* Effect.promise(() => concurrentContinuation.text())
          const concurrentDecision = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/${concurrentPending.id}/approve`, {
              headers: { ...headers, cookie: cookieB, origin },
              method: "POST"
            })
          )
          expect(concurrentDecision.status).toBe(200)
          yield* Effect.promise(() => concurrentDecision.text())
        }).pipe(Effect.scoped),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  }, 15_000)

  it.effect("retains paginated proofs and renews their shared lifetime", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-proof-retention-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
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
    const headers = { "tailscale-user-login": "owner@example.com" }
    let observedAt = 0
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const delayedStatusStarted = yield* Deferred.make<void>()
          const releaseDelayedStatus = yield* Deferred.make<void>()
          const overlapPendingPageStarted = yield* Deferred.make<void>()
          const concurrentDecisionStarted = yield* Deferred.make<void>()
          let delayStatus = false
          let signalOverlapPendingPage = false
          let signalConcurrentDecision = false
          yield* Effect.forEach(
            Array.from(
              { length: pendingApprovalPageMaxRecords * 40 },
              (_, index) => pendingRecord("ALPHA", index)
            ),
            (record) => store.put(record),
            { discard: true }
          )
          const fleet = yield* makeFleetService({
            approvalEnabled: true,
            host: hostConfig.host,
            operations,
            store
          })
          const instrumentedFleet: FleetService = {
            ...fleet,
            pendingApprovalPage: (cursor) =>
              fleet.pendingApprovalPage(cursor).pipe(
                Effect.tap(() => {
                  if (!signalOverlapPendingPage) return Effect.void
                  signalOverlapPendingPage = false
                  return Deferred.succeed(overlapPendingPageStarted, undefined)
                })
              ),
            approve: (jobId, approval, actor) =>
              signalConcurrentDecision
                ? Deferred.succeed(concurrentDecisionStarted, undefined).pipe(
                  Effect.andThen(fleet.approve(jobId, approval, actor))
                )
                : fleet.approve(jobId, approval, actor),
            status: () =>
              delayStatus
                ? Deferred.succeed(delayedStatusStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseDelayedStatus)),
                  Effect.andThen(fleet.status())
                )
                : fleet.status()
          }
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, instrumentedFleet, assets, {
                now: () => observedAt,
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          const approvalUrl = server.approvalUrl
          if (approvalUrl === null) {
            return yield* new FleetValidationError({ detail: "approval listener missing" })
          }
          const origin = new URL(approvalUrl).origin
          const dashboard = yield* Effect.promise(
            () => fetch(`${approvalUrl}/v1/dashboard`, { headers })
          )
          const cookie = dashboard.headers.get("set-cookie")?.split(";", 1).join("")
          if (cookie === undefined) {
            return yield* new FleetValidationError({ detail: "approval proof cookie missing" })
          }
          let snapshot = Schema.decodeUnknownSync(DashboardSnapshot)(
            JSON.parse(yield* Effect.promise(() => dashboard.text()))
          )
          const retainedJobId = snapshot.pendingApprovals.local[0]?.id
          if (retainedJobId === undefined) {
            return yield* new FleetValidationError({ detail: "initial pending approval missing" })
          }
          const concurrentDecisionJobId = snapshot.pendingApprovals.local.find(({ id }) => id !== retainedJobId)?.id
          if (concurrentDecisionJobId === undefined) {
            return yield* new FleetValidationError({ detail: "concurrent pending approval missing" })
          }
          while (snapshot.pendingApprovals.nextCursors.length > 0) {
            const continuation = snapshot.pendingApprovals.nextCursors[0]
            if (continuation === undefined) break
            const parameters = new URLSearchParams({
              cursorCreatedAt: String(continuation.cursor.createdAt),
              cursorHost: continuation.host,
              cursorId: continuation.cursor.id
            })
            const page = yield* Effect.promise(() =>
              fetch(`${approvalUrl}/v1/dashboard-pending?${parameters.toString()}`, {
                headers: { ...headers, cookie }
              })
            )
            expect(page.status).toBe(200)
            snapshot = {
              ...snapshot,
              pendingApprovals: Schema.decodeUnknownSync(FleetPendingApprovals)(
                yield* Effect.promise(() => page.json())
              )
            }
          }
          const retainedDecision = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/${retainedJobId}/approve`, {
              headers: { ...headers, cookie, origin },
              method: "POST"
            })
          )
          expect(retainedDecision.status).toBe(200)
          yield* Effect.promise(() => retainedDecision.text())
          observedAt = 10 * 60 * 1_000
          const overlapPending = pendingRecord("ALPHA", 10_000)
          const expiredPending = pendingRecord("ALPHA", 10_001)
          yield* store.put(overlapPending)
          yield* store.put(expiredPending)
          delayStatus = true
          const refreshedFiber = yield* Effect.forkChild(
            Effect.promise(() => fetch(`${approvalUrl}/v1/dashboard`, { headers: { ...headers, cookie } }))
          )
          yield* Deferred.await(delayedStatusStarted)
          signalConcurrentDecision = true
          const concurrentDecisionFiber = yield* Effect.forkChild(
            Effect.promise(() =>
              fetch(`${approvalUrl}/v1/jobs/${concurrentDecisionJobId}/approve`, {
                headers: { ...headers, cookie, origin },
                method: "POST"
              })
            )
          )
          yield* Deferred.await(concurrentDecisionStarted)
          signalOverlapPendingPage = true
          observedAt = 20 * 60 * 1_000
          const overlappingFiber = yield* Effect.forkChild(
            Effect.promise(() => fetch(`${approvalUrl}/v1/dashboard`, { headers: { ...headers, cookie } }))
          )
          yield* Deferred.await(overlapPendingPageStarted)
          yield* Deferred.succeed(releaseDelayedStatus, undefined)
          const refreshed = yield* Fiber.join(refreshedFiber)
          expect(refreshed.status).toBe(200)
          yield* Effect.promise(() => refreshed.text())
          const concurrentDecision = yield* Fiber.join(concurrentDecisionFiber)
          expect(concurrentDecision.status).toBe(200)
          yield* Effect.promise(() => concurrentDecision.text())
          const overlapping = yield* Fiber.join(overlappingFiber)
          expect(overlapping.status).toBe(200)
          yield* Effect.promise(() => overlapping.text())
          delayStatus = false
          observedAt = 26 * 60 * 1_000
          const decision = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/${overlapPending.id}/approve`, {
              headers: { ...headers, cookie, origin },
              method: "POST"
            })
          )
          expect(decision.status).toBe(200)
          observedAt = 36 * 60 * 1_000
          const expiredDecision = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/${expiredPending.id}/approve`, {
              headers: { ...headers, cookie, origin },
              method: "POST"
            })
          )
          expect(expiredDecision.status).toBe(409)
        }).pipe(Effect.scoped),
      (store) => Effect.sync(() => store.close())
    ).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  }, 15_000)

  it.effect("does not evict active approval proof sessions at capacity", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-proof-session-capacity-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
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
    const headers = { "tailscale-user-login": "owner@example.com" }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          yield* store.put(pendingRecord("ALPHA", 0))
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
          const approvalUrl = server.approvalUrl
          if (approvalUrl === null) {
            return yield* new FleetValidationError({ detail: "approval listener missing" })
          }
          const origin = new URL(approvalUrl).origin
          let firstCookie: string | undefined
          let capacityResponse: Response | undefined
          for (let attempt = 0; attempt < 300; attempt += 1) {
            const response = yield* Effect.promise(
              () => fetch(`${approvalUrl}/v1/dashboard`, { headers })
            )
            if (attempt === 0) {
              firstCookie = response.headers.get("set-cookie")?.split(";", 1).join("")
            }
            if (response.status === 503) {
              capacityResponse = response
              break
            }
            expect(response.status).toBe(200)
            yield* Effect.promise(() => response.text())
          }
          if (capacityResponse === undefined || firstCookie === undefined) {
            return yield* new FleetValidationError({ detail: "approval proof capacity was not bounded" })
          }
          expect(yield* Effect.promise(() => capacityResponse.json())).toEqual({
            error: "FleetOperationError",
            detail: "approval proof session capacity reached"
          })
          const decision = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/alpha-job-00/approve`, {
              headers: { ...headers, cookie: firstCookie, origin },
              method: "POST"
            })
          )
          expect(decision.status).toBe(200)
          yield* Effect.promise(() => decision.text())
        }).pipe(Effect.scoped),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  }, 30_000)

  it.effect("does not retain proof sessions when dashboard disclosure fails", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-proof-session-failure-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
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
    const headers = { "tailscale-user-login": "owner@example.com" }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          yield* store.put(pendingRecord("ALPHA", 0))
          const failingStatusStarted = yield* Deferred.make<void>()
          const releaseFailingStatus = yield* Deferred.make<void>()
          const concurrentPendingPageStarted = yield* Deferred.make<void>()
          const concurrentStatusStarted = yield* Deferred.make<void>()
          let failNextStatus = false
          let signalConcurrentPendingPage = false
          let signalConcurrentStatus = false
          const fleet = yield* makeFleetService({
            approvalEnabled: true,
            host: hostConfig.host,
            operations,
            store
          })
          let failStatus = false
          const instrumentedFleet: FleetService = {
            ...fleet,
            pendingApprovalPage: (cursor) =>
              fleet.pendingApprovalPage(cursor).pipe(
                Effect.tap(() => {
                  if (!signalConcurrentPendingPage) return Effect.void
                  signalConcurrentPendingPage = false
                  return Deferred.succeed(concurrentPendingPageStarted, undefined)
                })
              ),
            status: () => {
              if (failNextStatus) {
                failNextStatus = false
                return Deferred.succeed(failingStatusStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFailingStatus)),
                  Effect.andThen(
                    Effect.fail(
                      new FleetOperationError({
                        cause: "test",
                        detail: "dashboard status unavailable",
                        operation: "fleet.status"
                      })
                    )
                  )
                )
              }
              if (signalConcurrentStatus) {
                signalConcurrentStatus = false
                return Deferred.succeed(concurrentStatusStarted, undefined).pipe(
                  Effect.andThen(fleet.status())
                )
              }
              return failStatus
                ? Effect.fail(
                  new FleetOperationError({
                    cause: "test",
                    detail: "dashboard status unavailable",
                    operation: "fleet.status"
                  })
                )
                : fleet.status()
            }
          }
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(hostConfig, instrumentedFleet, assets, {
                terminalConnector: unusedTerminal
              })
            ),
            (running) => Effect.promise(running.close)
          )
          const approvalUrl = server.approvalUrl
          if (approvalUrl === null) {
            return yield* new FleetValidationError({ detail: "approval listener missing" })
          }
          const origin = new URL(approvalUrl).origin
          const initial = yield* Effect.promise(() => fetch(`${approvalUrl}/v1/dashboard`, { headers }))
          expect(initial.status).toBe(200)
          const retainedCookie = initial.headers.get("set-cookie")?.split(";", 1).join("")
          if (retainedCookie === undefined) {
            return yield* new FleetValidationError({ detail: "retained approval proof cookie missing" })
          }
          yield* Effect.promise(() => initial.text())
          const initializedSnapshot = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/dashboard`, { headers: { ...headers, cookie: retainedCookie } })
          )
          expect(initializedSnapshot.status).toBe(200)
          yield* Effect.promise(() => initializedSnapshot.text())
          failStatus = true
          for (let attempt = 0; attempt < 256; attempt += 1) {
            const response = yield* Effect.promise(() => fetch(`${approvalUrl}/v1/dashboard`, { headers }))
            expect(response.status).toBe(503)
            yield* Effect.promise(() => response.text())
          }
          failStatus = false
          const recoveredWithoutCookie = yield* Effect.promise(() => fetch(`${approvalUrl}/v1/dashboard`, { headers }))
          expect(recoveredWithoutCookie.status).toBe(200)
          expect(recoveredWithoutCookie.headers.get("set-cookie")).toContain("fleet_approval_proof_session=")
          yield* Effect.promise(() => recoveredWithoutCookie.text())
          yield* store.put(pendingRecord("ALPHA", 1))
          failStatus = true
          const failedReusedDisclosure = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/dashboard`, {
              headers: { ...headers, cookie: retainedCookie }
            })
          )
          expect(failedReusedDisclosure.status).toBe(503)
          yield* Effect.promise(() => failedReusedDisclosure.text())
          const rolledBackDecision = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/alpha-job-01/approve`, {
              headers: { ...headers, cookie: retainedCookie, origin },
              method: "POST"
            })
          )
          expect(rolledBackDecision.status).toBe(409)
          yield* Effect.promise(() => rolledBackDecision.text())
          failStatus = false
          const recovered = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/dashboard`, {
              headers: { ...headers, cookie: retainedCookie }
            })
          )
          expect(recovered.status).toBe(200)
          expect(recovered.headers.get("set-cookie")).toContain("fleet_approval_proof_session=")
          yield* Effect.promise(() => recovered.text())
          const decision = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/alpha-job-01/approve`, {
              headers: { ...headers, cookie: retainedCookie, origin },
              method: "POST"
            })
          )
          expect(decision.status).toBe(200)
          yield* Effect.promise(() => decision.text())

          yield* store.put(pendingRecord("ALPHA", 2))
          failNextStatus = true
          const failedConcurrentDisclosure = yield* Effect.forkChild(
            Effect.promise(() =>
              fetch(`${approvalUrl}/v1/dashboard`, {
                headers: { ...headers, cookie: retainedCookie }
              })
            )
          )
          yield* Deferred.await(failingStatusStarted)
          signalConcurrentPendingPage = true
          signalConcurrentStatus = true
          const succeedingConcurrentDisclosure = yield* Effect.forkChild(
            Effect.promise(() =>
              fetch(`${approvalUrl}/v1/dashboard`, {
                headers: { ...headers, cookie: retainedCookie }
              })
            )
          )
          yield* Deferred.await(concurrentPendingPageStarted)
          expect(yield* Deferred.isDone(concurrentStatusStarted)).toBe(false)
          yield* Deferred.succeed(releaseFailingStatus, undefined)
          const failedConcurrentResponse = yield* Fiber.join(failedConcurrentDisclosure)
          expect(failedConcurrentResponse.status).toBe(503)
          yield* Effect.promise(() => failedConcurrentResponse.text())
          yield* Deferred.await(concurrentStatusStarted)
          const succeedingConcurrentResponse = yield* Fiber.join(succeedingConcurrentDisclosure)
          expect(succeedingConcurrentResponse.status).toBe(200)
          yield* Effect.promise(() => succeedingConcurrentResponse.text())
          const concurrentDecision = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/alpha-job-02/approve`, {
              headers: { ...headers, cookie: retainedCookie, origin },
              method: "POST"
            })
          )
          expect(concurrentDecision.status).toBe(200)
          yield* Effect.promise(() => concurrentDecision.text())
        }).pipe(Effect.scoped),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  }, 30_000)

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
            "owner@example.com"
          )
          expect(
            yield* notificationCandidates(config(root), fleet).pipe(
              Effect.provideService(Tailscale, tailscale),
              // Discovery fails before any request, so reaching a remote host is a defect.
              Effect.provideService(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("fleet discovery failed, so no remote host is contacted"))
              )
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
    const title = dashboardDocumentTitle({ approvalApp: { superapp: false }, host })
    expect(title).not.toContain("<script")
    expect(title).not.toContain(host)
    expect(title).toBe(
      "SER8&lt;/title&gt;&lt;script data-xss=&quot;true&quot;&gt;alert(1)&lt;/script&gt; on Relay"
    )
  })

  it("titles the super-app Relay and a host's own activity page after the host", () => {
    expect(dashboardDocumentTitle({ approvalApp: { superapp: true }, host: "ser8" })).toBe("Relay")
    expect(dashboardDocumentTitle({ approvalApp: { superapp: false }, host: "ser8" })).toBe("ser8 on Relay")
  })

  it.effect("refuses an oversized dashboard when no history remains to page", () =>
    Effect.gen(function*() {
      const snapshot = Schema.decodeUnknownSync(DashboardSnapshot)({
        approvalApp: {
          canonical: true,
          canonicalUrl: "https://ser8.example.test:4779/",
          chatEnabled: true,
          pushEnabled: true,
          superapp: true,
          fleet: true,
          workEnabled: false,
          sandboxesEnabled: false
        },
        approvalsEnabled: true,
        apps: { viewer: "viewer@example.test", states: [] },
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
              actor: "owner@example.com",
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
          herdr: { agents: [], available: true, error: null },
          host: "SER8",
          repository: { branch: "main", dirty: false, path: "/repo", revision: "abc123" }
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
        actor: "owner@example.com",
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
          pushEnabled: true,
          superapp: true,
          fleet: true,
          workEnabled: false,
          sandboxesEnabled: false
        },
        approvalsEnabled: true,
        apps: { viewer: "viewer@example.test", states: [] },
        chat: null,
        directory: null,
        historyNextCursor: null,
        host: "SER8",
        observedAt: 1,
        pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [] },
        records: [],
        status: {
          applyConfigured: false,
          herdr: { agents: [], available: true, error: null },
          host: "SER8",
          repository: { branch: "main", dirty: false, path: "/repo", revision: "" }
        },
        work: null
      })
      const rawBaseBytes = Buffer.byteLength(JSON.stringify(base))
      const snapshot = Schema.decodeUnknownSync(DashboardSnapshot)({
        ...base,
        records: [{ ...record, approvalAvailable: false }],
        status: {
          ...base.status,
          repository: {
            branch: "main",
            dirty: false,
            path: "/repo",
            revision: "x".repeat(fleetResponseBodyMaxBytes - rawBaseBytes - 1_000)
          }
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
          pushEnabled: true,
          superapp: true,
          fleet: true,
          workEnabled: false,
          sandboxesEnabled: false
        },
        approvalsEnabled: true,
        apps: { viewer: "viewer@example.test", states: [] },
        chat: null,
        directory: null,
        historyNextCursor: null,
        host: "SER8",
        observedAt: 1,
        pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [] },
        records: [],
        status: {
          applyConfigured: false,
          herdr: { agents: [], available: true, error: null },
          host: "SER8",
          repository: { branch: "main", dirty: false, path: "/repo", revision: "" }
        },
        work: null
      })
      const rawBaseBytes = Buffer.byteLength(JSON.stringify(base))
      const exactRawLimit = Schema.decodeUnknownSync(DashboardSnapshot)({
        ...base,
        status: {
          ...base.status,
          repository: {
            branch: "main",
            dirty: false,
            path: "/repo",
            revision: "x".repeat(fleetResponseBodyMaxBytes - rawBaseBytes)
          }
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

  it.effect("starts without its PNG icons, answers 404 for them, and serves one once it is installed", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-missing-icons-"))
    const install = join(root, "install")
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          // An install with the app's scripts and stylesheet but none of the relay-*.png icons.
          mkdirSync(install)
          for (const file of ["index.css", "connect.js", "approval.js", "approval-sw.js"]) {
            writeFileSync(join(install, file), "")
          }
          const installed = yield* loadUiAssets(install)
          const fleet = yield* makeFleetService({ approvalEnabled: false, host: "ALPHA", operations, store })
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(config(root), fleet, installed, { terminalConnector: unusedTerminal })
            ),
            (running) => Effect.promise(running.close)
          )
          const get = (path: string) => Effect.promise(() => fetch(`${server.url}${path}`))
          expect((yield* get("/assets/relay-192.png")).status).toBe(404)
          expect((yield* get("/manifest.webmanifest")).status).toBe(200)
          expect((yield* get("/assets/relay-icon.svg")).status).toBe(200)
          // Repaired in place: the next request reads it, with no restart.
          writeFileSync(join(install, "relay-192.png"), relayPng)
          const png = yield* get("/assets/relay-192.png")
          expect(png.status).toBe(200)
          expect(new Uint8Array(yield* Effect.promise(() => png.arrayBuffer()))).toEqual(relayPng)
          // Only the icons the app names are read from the install directory.
          writeFileSync(join(install, "other.png"), relayPng)
          expect((yield* get("/assets/other.png")).status).toBe(404)
        }).pipe(Effect.scoped),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("serves the Relay manifest and icons, and the old icon path for earlier installs", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-relay-icons-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({ approvalEnabled: false, host: "ALPHA", operations, store })
          const server = yield* Effect.acquireRelease(
            Effect.promise(() => startHttpServer(config(root), fleet, assets, { terminalConnector: unusedTerminal })),
            (running) => Effect.promise(running.close)
          )
          const get = (path: string) => Effect.promise(() => fetch(`${server.url}${path}`))
          const manifest = yield* get("/manifest.webmanifest")
          expect(manifest.headers.get("content-type")).toBe("application/manifest+json; charset=utf-8")
          expect(yield* Effect.promise(() => manifest.json())).toMatchObject({
            id: "/",
            name: "Relay",
            scope: "/",
            short_name: "Relay",
            start_url: "/"
          })
          const png = yield* get("/assets/relay-192.png")
          expect(png.headers.get("content-type")).toBe("image/png")
          expect(new Uint8Array(yield* Effect.promise(() => png.arrayBuffer()))).toEqual(relayPng)
          const text = (path: string) =>
            get(path).pipe(Effect.flatMap((response) => Effect.promise(() => response.text())))
          const svg = yield* text("/assets/relay-icon.svg")
          const favicon = yield* text("/assets/relay-favicon.svg")
          const legacy = yield* text("/assets/approval-icon.svg")
          expect(svg).toContain("<title>Relay</title>")
          expect(svg).toContain("viewBox=\"0 0 512 512\"")
          expect(favicon).toContain("width=\"16\" height=\"16\"")
          expect(favicon).not.toBe(svg)
          expect(legacy).toBe(svg)
          expect((yield* get("/assets/relay-unknown.png")).status).toBe(404)
        }).pipe(Effect.scoped),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("serves the first 256 configured hosts in config order when 257 machines exist", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "herdr-http-configured-hosts-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const tailscaleCommand = join(root, "tailscale-test")
      const status = {
        Peer: Object.fromEntries(Array.from({ length: 256 }, (_, index) => [
          `node-${index + 1}`,
          { HostName: `fixture-${index + 1}`, ID: `node-${index + 1}`, Online: false, TailscaleIPs: ["127.0.0.2"] }
        ])),
        Self: { HostName: "SER8", ID: "node-ser8", Online: true, TailscaleIPs: ["127.0.0.1"] }
      }
      writeFileSync(
        tailscaleCommand,
        `#!/bin/sh
case "$1" in
  ip) printf '%s\\n' '127.0.0.1' ;;
  whois) printf '%s\\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
  status) printf '%s\\n' '${JSON.stringify(status)}' ;;
esac
`,
        { mode: 0o700 }
      )
      const hostConfig: HostConfiguration = {
        ...config(root),
        host: "SER8",
        crossHost: true,
        approvalHub: { host: "SER8", nodeId: "node-ser8", url: "https://ser8.example.test:0/" },
        approvalPort: 0,
        approvalTls: directTls,
        machines: [
          { host: "SER8", nodeId: "node-ser8" },
          ...Array.from({ length: 256 }, (_, index) => ({ host: `fixture-${index + 1}`, nodeId: `node-${index + 1}` }))
        ],
        tailscaleCommand
      }
      const store = yield* Effect.acquireRelease(
        JobStore.open(join(root, "jobs.sqlite")),
        (opened) => Effect.sync(() => opened.close())
      )
      const fleet = yield* makeFleetService({ approvalEnabled: true, host: hostConfig.host, operations, store })
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => startHttpServer(hostConfig, fleet, assets, { terminalConnector: unusedTerminal })),
        (running) => Effect.promise(running.close)
      )
      if (server.serveUrl === null) return yield* Effect.die("canonical listener fixture missing")
      const response = yield* Effect.promise(() =>
        secureRequestBody(`${server.serveUrl}/v1/connect/agents`, {
          host: "ser8.example.test:0"
        })
      )
      expect(response.status).toBe(200)
      const page = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FleetConnectAgentPage))(response.body)
      expect(page.agents).toEqual([])
      expect(page.hosts).toEqual(["SER8", ...Array.from({ length: 255 }, (_, index) => `fixture-${index + 1}`)])
      expect(page.hosts).not.toContain("fixture-256")
    })).pipe(provideNodeServices))

  it.live(
    "preserves the exhausted inventory store error in report responses",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "herdr-http-report-busy-" })
        yield* fs.chmod(root, 0o700)
        const tailscaleCommand = join(root, "tailscale-fixture")
        yield* fs.writeFileString(
          tailscaleCommand,
          `#!/bin/sh
case "$1" in
  ip) printf '%s\\n' '127.0.0.1' ;;
  whois) printf '%s\\n' '{"Node":{"StableID":"node-hub"},"UserProfile":{"LoginName":"owner@example.test"}}' ;;
  status) printf '%s\\n' '{"Peer":{},"Self":{"HostName":"hub","ID":"node-hub","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`
        )
        yield* fs.chmod(tailscaleCommand, 0o700)
        const hostConfig: HostConfiguration = {
          ...config(root),
          allowedUsers: ["owner@example.test"],
          host: "hub",
          crossHost: true,
          approvalHub: { host: "hub", nodeId: "node-hub", url: "https://hub.example.test:0/" },
          approvalPort: 0,
          approvalTls: directTls,
          machines: [{ host: "hub", nodeId: "node-hub" }],
          tailscaleCommand
        }
        const postOperations: HostOperations = {
          ...operations,
          listAgents: () =>
            Effect.succeed({
              available: true,
              error: null,
              agents: [{
                activityRevision: 1,
                agentId: "agent-report",
                kind: "worker",
                name: "Worker",
                paneId: "w1:p1",
                parentAgentId: null,
                relation: null,
                status: "working",
                work: "Reporting progress"
              }]
            })
        }
        const store = yield* Effect.acquireRelease(
          JobStore.open(join(root, "jobs.sqlite")),
          (opened) => Effect.sync(() => opened.close())
        )
        const fleet = yield* makeFleetService({ approvalEnabled: true, host: "hub", operations: postOperations, store })
        const server = yield* Effect.acquireRelease(
          Effect.promise(() => startHttpServer(hostConfig, fleet, assets, { terminalConnector: unusedTerminal })),
          (running) => Effect.promise(running.close)
        )
        const canonical = yield* Schema.decodeUnknownEffect(Schema.String)(server.serveUrl)
        const post = (eventId: string) =>
          Effect.promise(() =>
            secureRequestBody(`${canonical}/v1/connect/posts`, {
              host: "hub.example.test:0",
              "content-type": "application/json"
            }, { method: "POST", body: { agentId: "agent-report", kind: "status", text: "Progress", eventId } })
          )
        expect((yield* post("before-lock")).status).toBe(200)
        const blocker = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(join(root, "approval-app.sqlite"))),
          (database) => Effect.sync(() => database.close())
        )
        yield* Effect.sync(() => blocker.exec("BEGIN IMMEDIATE"))
        const exhausted = yield* post("during-lock")
        expect(exhausted.status, exhausted.body).toBe(503)
        const errorBody = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(exhausted.body)
        expect(errorBody).toEqual({
          error: "ConnectStoreBusyError",
          operation: "persist.transaction",
          timeoutMillis: 5_000
        })
        expect(exhausted.body).not.toContain("cause")
        expect(exhausted.body).not.toContain(root)
        yield* Effect.sync(() => blocker.exec("ROLLBACK"))
        expect((yield* post("during-lock")).status).toBe(200)
      })).pipe(provideNodeServices),
    15_000
  )

  it.live(
    "preserves busy metadata for remote reporters and keeps unrelated peer failures generic",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "herdr-remote-report-busy-" })
        yield* fs.chmod(root, 0o700)
        const mainRoot = join(root, "hub")
        const peerRoot = join(root, "peer")
        yield* fs.makeDirectory(mainRoot, { mode: 0o700 })
        yield* fs.makeDirectory(peerRoot, { mode: 0o700 })
        for (const directory of [mainRoot, peerRoot]) {
          expect((yield* fs.stat(directory)).mode & 0o777).toBe(0o700)
        }
        let unavailable = false
        const peerOperations: HostOperations = {
          ...operations,
          listAgents: () =>
            Effect.succeed({
              available: !unavailable,
              error: unavailable ? "private inventory failure" : null,
              agents: [{
                activityRevision: 1,
                agentId: "agent-remote",
                kind: "worker",
                name: "Worker",
                paneId: "w1:p1",
                parentAgentId: null,
                relation: null,
                status: "working",
                work: "private work sentinel"
              }]
            })
        }
        const mainStore = yield* Effect.acquireRelease(
          JobStore.open(join(mainRoot, "jobs.sqlite")),
          (value) => Effect.sync(() => value.close())
        )
        const peerStore = yield* Effect.acquireRelease(
          JobStore.open(join(peerRoot, "jobs.sqlite")),
          (value) => Effect.sync(() => value.close())
        )
        const mainFleet = yield* makeFleetService({ host: "hub", approvalEnabled: true, operations, store: mainStore })
        const peerFleet = yield* makeFleetService({
          host: "peer",
          approvalEnabled: true,
          operations: peerOperations,
          store: peerStore
        })
        const mainCommand = join(root, "tailscale-hub")
        const peerCommand = join(root, "tailscale-peer")
        for (
          const { address, command, host, other, otherAddress } of [
            { command: mainCommand, host: "hub", address: "127.0.0.1", other: "peer", otherAddress: "127.0.0.2" },
            { command: peerCommand, host: "peer", address: "127.0.0.2", other: "hub", otherAddress: "127.0.0.1" }
          ]
        ) {
          yield* fs.writeFileString(
            command,
            `#!/bin/sh
case "$1" in
  ip) printf '%s\\n' '${address}' ;;
  whois) printf '%s\\n' '{"Node":{"StableID":"node-${other}"},"UserProfile":{"LoginName":"owner@example.test"}}' ;;
  status) printf '%s\\n' '{"Peer":{"other":{"HostName":"${other}","ID":"node-${other}","Online":true,"TailscaleIPs":["${otherAddress}"]}},"Self":{"HostName":"${host}","ID":"node-${host}","Online":true,"TailscaleIPs":["${address}"]}}' ;;
esac
`
          )
          yield* fs.chmod(command, 0o700)
        }
        const shared = {
          allowedUsers: ["owner@example.test"],
          approvalNodes: ["node-hub"],
          crossHost: true,
          approvalPort: 0,
          port: 0,
          machines: [{ host: "hub", nodeId: "node-hub" }, { host: "peer", nodeId: "node-peer" }]
        }
        const peerConfig: HostConfiguration = {
          ...config(peerRoot),
          ...shared,
          host: "peer",
          tailscaleCommand: peerCommand,
          approvalHub: { host: "hub", nodeId: "node-hub", url: "https://hub.example.test:0/" }
        }
        const { mainServer } = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: async (): Promise<PairStart> => {
              const peerServer = await startHttpServer(peerConfig, peerFleet, assets, {
                terminalConnector: unusedTerminal
              })
              const ports = await Promise.resolve().then(() => ({
                approvalPort: boundPort(peerServer.approvalUrl),
                peerPort: boundPort(peerServer.tailnetUrl)
              }))
                .catch(async (cause: unknown) => {
                  await peerServer.close()
                  throw cause
                })
              try {
                const mainServer = await startHttpServer(
                  {
                    ...config(mainRoot),
                    ...shared,
                    host: "hub",
                    tailscaleCommand: mainCommand,
                    port: ports.peerPort,
                    approvalPort: ports.approvalPort,
                    approvalTls: directTls,
                    approvalHub: {
                      host: "hub",
                      nodeId: "node-hub",
                      url: `https://hub.example.test:${ports.approvalPort}/`
                    }
                  },
                  mainFleet,
                  assets,
                  { terminalConnector: unusedTerminal }
                )
                return { _tag: "Started", approvalPort: ports.approvalPort, mainServer, peerServer }
              } catch (cause) {
                await peerServer.close()
                if (
                  isAddressInUse(cause) && (cause.port === ports.peerPort || cause.port === ports.approvalPort)
                ) return { _tag: "PortTaken", cause }
                throw cause
              }
            },
            catch: (cause) => new ApprovalStartFailed({ cause })
          }).pipe(
            Effect.flatMap((pair) =>
              pair._tag === "PortTaken"
                ? Effect.fail(new ApprovalPortTaken({ cause: pair.cause }))
                : Effect.succeed(pair)
            ),
            Effect.retry({ times: 4, while: (error) => error._tag === "ApprovalPortTaken" })
          ),
          (pair) => Effect.promise(() => Promise.all([pair.mainServer.close(), pair.peerServer.close()]))
        )
        const canonical = yield* Schema.decodeUnknownEffect(Schema.String)(mainServer.serveUrl)
        const authority = new URL(canonical).port
        const post = (eventId: string) =>
          Effect.promise(() =>
            secureRequestBody(`${canonical}/v1/connect/posts`, {
              host: `hub.example.test:${authority}`,
              "content-type": "application/json"
            }, { method: "POST", body: { agentId: "agent-remote", kind: "status", text: "Progress", eventId } })
          )
        const warmup = yield* post("warmup")
        expect(warmup.status, warmup.body).toBe(200)
        const blocker = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(join(peerRoot, "approval-app.sqlite"))),
          (value) => Effect.sync(() => value.close())
        )
        yield* Effect.sync(() => blocker.exec("BEGIN IMMEDIATE"))
        const busy = yield* post("busy")
        expect(busy.status, busy.body).toBe(503)
        expect(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(busy.body)).toEqual({
          error: "ConnectStoreBusyError",
          operation: "persist.transaction",
          timeoutMillis: 5_000
        })
        expect(busy.body).not.toContain("cause")
        expect(busy.body).not.toContain(root)
        expect(busy.body).not.toContain("private work sentinel")
        yield* Effect.sync(() => blocker.exec("ROLLBACK"))
        expect((yield* post("busy")).status).toBe(200)
        unavailable = true
        const other = yield* post("other")
        expect(other.status).toBe(503)
        expect(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(other.body)).toEqual({
          error: "Unavailable",
          operation: "posts.inventory"
        })
      })).pipe(provideNodeServices),
    20_000
  )

  it.effect("accepts host-bound voice and self-state only on the canonical listener, including sibling claims on the same host", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-posts-"))
    const tailscaleCommand = join(root, "tailscale-test")
    const identityMode = join(root, "identity-mode")
    writeFileSync(identityMode, "node-ser8")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\\n' '127.0.0.1' ;;
  whois) printf '{"Node":{"StableID":"%s"},"UserProfile":{"LoginName":"user@example.test"}}\\n' "$(cat '${identityMode}')" ;;
  status) printf '%s\\n' '{"Peer":{"alpha":{"HostName":"ALPHA","ID":"node-alpha","Online":true,"TailscaleIPs":["127.0.0.2"]}},"Self":{"HostName":"SER8","ID":"node-ser8","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    const hostConfig: HostConfiguration = {
      ...config(root),
      allowedUsers: ["user@example.test"],
      host: "SER8",
      crossHost: true,
      approvalHub: { host: "SER8", nodeId: "node-ser8", url: "https://ser8.example.test:0/" },
      approvalPort: 0,
      approvalTls: directTls,
      machines: [{ host: "SER8", nodeId: "node-ser8" }, { host: "ALPHA", nodeId: "node-alpha" }],
      tailscaleCommand
    }
    let partial = false
    const postOperations: HostOperations = {
      ...operations,
      listAgents: () =>
        Effect.succeed({
          available: true,
          error: partial ? "partial inventory" : null,
          agents: ["agent-one", "agent-sibling"].map((agentId, index) => ({
            activityRevision: 1,
            agentId,
            kind: "worker",
            name: "worker",
            paneId: `w1:p${index + 1}`,
            parentAgentId: null,
            relation: null,
            status: "working",
            work: "project"
          }))
        })
    }
    return Effect.scoped(Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const peerServer = createServer((request, response) => {
        response.writeHead(request.url === "/v1/connect/agents/local" ? 200 : 404, {
          "content-type": "application/json"
        })
        response.end(JSON.stringify({
          host: "ALPHA",
          complete: true,
          agents: [{
            id: "agent-remote",
            host: "ALPHA",
            name: "remote worker",
            kind: "worker",
            state: "working",
            work: "project",
            lastActivityAt: 0
          }]
        }))
      })
      let peerPort = yield* Effect.acquireRelease(
        Effect.promise(() => listenOn(peerServer, "127.0.0.2")),
        () =>
          Effect.suspend(() =>
            peerServer.listening
              ? Effect.promise(() =>
                new Promise<void>((resolve, reject) =>
                  peerServer.close((error) => error === undefined ? resolve() : reject(error))
                )
              )
              : Effect.void
          )
      )
      const store = yield* Effect.acquireRelease(
        JobStore.open(join(root, "jobs.sqlite")),
        (opened) => Effect.sync(() => opened.close())
      )
      const fleet = yield* makeFleetService({ approvalEnabled: true, host: "SER8", operations: postOperations, store })
      const server = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            try {
              return await startHttpServer({ ...hostConfig, port: peerPort }, fleet, assets, {
                terminalConnector: unusedTerminal,
                now: () => 100,
                lanWork: { address: "127.0.0.1", port: 0 }
              })
            } catch (cause) {
              if (!isAddressInUse(cause) || cause.port !== peerPort) throw cause
              // Port 0 on the peer address does not reserve the same port on the hub address.
              await new Promise<void>((resolve, reject) =>
                peerServer.close((error) => error === undefined ? resolve() : reject(error))
              )
              peerPort = await listenOn(peerServer, "127.0.0.2")
              throw new ApprovalPortTaken({ cause })
            }
          },
          catch: (cause) => Predicate.isTagged(cause, "ApprovalPortTaken") ? cause : new ApprovalStartFailed({ cause })
        }).pipe(Effect.retry({ times: 4, while: (error) => error._tag === "ApprovalPortTaken" })),
        (running) => Effect.promise(running.close)
      )
      if (server.serveUrl === null || server.tailnetUrl === null || server.lanWorkUrl === null) {
        return yield* Effect.die("voice fixture listeners missing")
      }
      const canonical = server.serveUrl
      const headers = { host: "ser8.example.test:0", "content-type": "application/json" }
      const pushHeaders = { ...headers, origin: "https://ser8.example.test:0" }
      const settingsUrl = `${canonical}/v1/push/blocked-settings`
      const preferences = { mutedAgents: [{ host: "SER8", agentId: "agent-one" }], quietHours: null }
      expect((yield* Effect.promise(() => secureRequestBody(settingsUrl, headers))).body.trim()).toBe(
        JSON.stringify({ mutedAgents: [], quietHours: null })
      )
      expect(
        (yield* Effect.promise(() =>
          secureRequestBody(settingsUrl, pushHeaders, {
            method: "PATCH",
            body: { _tag: "SetAgentMute", agent: preferences.mutedAgents[0], muted: true }
          })
        ))
          .status
      ).toBe(200)
      expect((yield* Effect.promise(() => secureRequestBody(settingsUrl, headers))).body.trim()).toBe(
        JSON.stringify(preferences)
      )
      expect(
        (yield* Effect.promise(() =>
          secureRequestBody(settingsUrl, { ...pushHeaders, origin: "https://foreign.example.test" }, {
            method: "PATCH",
            body: { _tag: "SetAgentMute", agent: preferences.mutedAgents[0], muted: true }
          })
        )).status
      ).toBe(403)
      expect(
        (yield* Effect.promise(() =>
          secureRequestBody(settingsUrl, pushHeaders, {
            method: "PATCH",
            body: {
              _tag: "SetQuietHours",
              quietHours: { startMinute: -1, endMinute: 300, timeZone: "America/New_York" }
            }
          })
        )).status
      ).toBe(400)
      expect(
        (yield* Effect.promise(() =>
          secureRequestBody(settingsUrl, pushHeaders, {
            method: "PATCH",
            body: { _tag: "SetQuietHours", quietHours: { startMinute: 60, endMinute: 120, timeZone: "Invalid/Zone" } }
          })
        )).status
      ).toBe(400)
      const zonedPreferences = {
        ...preferences,
        quietHours: { startMinute: 22 * 60, endMinute: 7 * 60, timeZone: "America/New_York" }
      }
      expect(
        (yield* Effect.promise(() =>
          secureRequestBody(settingsUrl, pushHeaders, {
            method: "PATCH",
            body: { _tag: "SetQuietHours", quietHours: zonedPreferences.quietHours }
          })
        )).status
      ).toBe(200)
      expect((yield* Effect.promise(() => secureRequestBody(settingsUrl, headers))).body.trim()).toBe(
        JSON.stringify(zonedPreferences)
      )
      expect(
        (yield* Effect.promise(() =>
          secureRequestBody(settingsUrl, pushHeaders, {
            method: "PUT",
            body: preferences
          })
        )).status
      ).not.toBe(200)
      expect((yield* Effect.promise(() => secureRequestBody(settingsUrl, headers))).body.trim()).toBe(
        JSON.stringify(zonedPreferences)
      )
      const heartbeat = { clientId: "browser-one", target: { host: "SER8", agentId: "agent-one" } }
      expect(
        (yield* Effect.promise(() =>
          secureRequestBody(`${canonical}/v1/push/stage-heartbeat`, pushHeaders, { method: "POST", body: heartbeat })
        )).status
      ).toBe(200)
      expect(
        (yield* Effect.promise(() =>
          fetch(`${server.url}/v1/push/stage-heartbeat`, {
            headers: pushHeaders,
            method: "POST",
            body: JSON.stringify(heartbeat)
          })
        )).status
      ).not.toBe(200)
      const body = { agentId: "agent-one", kind: "status", text: "Tests passing", eventId: "event-one" }
      const post = (input: Readonly<Record<string, string>>) =>
        Effect.promise(() =>
          secureRequestBody(`${canonical}/v1/connect/posts`, headers, { method: "POST", body: input })
        )
      type SelfRequestHeaders = {
        readonly host: string
        readonly "content-type": string
        "x-herdr-agent-id"?: string
      }
      const me = (agentId: string | null, input: Readonly<Record<string, string>>) => {
        const requestHeaders: SelfRequestHeaders = { ...headers }
        if (agentId !== null) requestHeaders["x-herdr-agent-id"] = agentId
        return Effect.promise(() =>
          secureRequestBody(`${canonical}/v1/connect/me`, requestHeaders, { method: "POST", body: input })
        )
      }
      expect((yield* me(null, { mood: "happy" })).status).toBe(403)
      expect(
        (yield* Effect.promise(() =>
          secureRequestBody(`${canonical}/v1/connect/me`, {
            ...headers,
            "x-herdr-agent-id": "agent-one",
            origin: "https://foreign.example.test"
          }, { method: "POST", body: { mood: "happy" } })
        )).status
      ).toBe(403)
      expect((yield* me("agent-foreign", { mood: "happy" })).body).toContain("UnboundAgent")
      const invalidSelf: ReadonlyArray<Readonly<Record<string, string>>> = [
        { mood: "angry" },
        { say: "x".repeat(141) },
        { mood: "happy", accessory: "crown" },
        { mood: "happy", agentId: "agent-sibling" },
        { mood: "happy", host: "ALPHA" },
        { mood: "happy", replyTo: "ask-one" },
        { say: "line\nbreak" }
      ]
      for (const invalid of invalidSelf) {
        const rejected = yield* me("agent-one", invalid)
        expect(rejected.status, JSON.stringify({ invalid, response: rejected })).toBe(400)
      }
      expect(
        (yield* me("agent-one", { say: "  Keeping an eye on tests  ", mood: "focused", accessory: "glasses" })).status
      ).toBe(200)
      expect((yield* me("agent-sibling", { mood: "happy" })).status).toBe(200)
      expect((yield* me("agent-one", { mood: "happy" })).status).toBe(200)
      expect((yield* me("agent-one", { mood: "excited" })).status).toBe(200)
      const limited = yield* me("agent-one", { mood: "happy" })
      expect(limited.status).toBe(429)
      expect(limited.body).toContain("\"error\":\"TooManySelfUpdates\"")
      const first = yield* post(body)
      expect(first.status).toBe(200)
      expect((yield* post(body)).body).toBe(first.body)
      expect((yield* post({ ...body, text: "Changed" })).status).toBe(409)
      expect((yield* post({ ...body, text: "x".repeat(241) })).status).toBe(400)
      for (
        const fixture of [
          {
            kind: "status",
            text: "x".repeat(241),
            detail: "text is 241 characters; status posts are limited to 240 (other kinds 1024)"
          },
          { kind: "note", text: "x".repeat(1025), detail: "text is 1025 characters; note posts are limited to 1024" },
          { kind: "status", text: "", detail: "text is empty" },
          { kind: "note", text: " \t\n ", detail: "text is empty" }
        ]
      ) {
        const rejected = yield* post({ ...body, kind: fixture.kind, text: fixture.text })
        expect(rejected.status).toBe(400)
        expect(
          Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Struct({ error: Schema.String, detail: Schema.String }))
          )(rejected.body)
        )
          .toEqual({ error: "InvalidReport", detail: fixture.detail })
      }
      expect((yield* post({ ...body, agentId: "agent-foreign" })).body).toContain("UnboundAgent")
      expect((yield* post({ ...body, agentId: "agent-sibling" })).status).toBe(200)
      const page = yield* Effect.promise(() =>
        secureRequestBody(`${canonical}/v1/connect/posts?host=SER8&agentId=agent-one`, headers)
      )
      expect(page.status).toBe(200)
      expect(page.body).toContain("Tests passing")
      const directory = yield* Effect.promise(() => secureRequestBody(`${canonical}/v1/connect/agents`, headers))
      expect(directory.body).toContain("\"voice\":{\"text\":\"Tests passing\",\"createdAt\":100}")
      const directoryPage = Schema.decodeUnknownSync(Schema.fromJsonString(FleetConnectAgentPage))(directory.body)
      // Configured hosts reach the browser even when no usage report names that host.
      expect(directoryPage.hosts).toEqual(["SER8", "ALPHA"])
      const agents = directoryPage.agents
      expect(agents.find(({ id }) => id === "agent-one")?.lastActivityAt).toBe(100)
      expect(agents.find(({ id }) => id === "agent-one")?.self).toEqual({
        mood: "excited",
        say: "Keeping an eye on tests",
        accessory: "glasses",
        at: 100,
        replyTo: null
      })
      expect(agents.find(({ id }) => id === "agent-remote")?.self).toBeNull()
      const withExtraField = yield* post({ ...body, eventId: "extra-field", extra: "ignored" })
      expect(withExtraField.status).toBe(400)
      expect(
        Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Struct({ error: Schema.String, detail: Schema.String }))
        )(withExtraField.body)
      ).toEqual({ error: "InvalidReport", detail: "extra is unexpected" })
      const withoutExtraField = yield* post({ ...body, eventId: "extra-field" })
      expect(withoutExtraField.status).toBe(200)
      expect(Schema.decodeUnknownSync(Schema.fromJsonString(ConnectPost))(withoutExtraField.body).text).toBe(body.text)
      const urlText = "https://example.test/status ".padEnd(240, "x")
      const withUrl = yield* post({ ...body, eventId: "url-at-limit", text: urlText })
      expect(withUrl.status).toBe(200)
      expect(Schema.decodeUnknownSync(Schema.fromJsonString(ConnectPost))(withUrl.body).text).toBe(urlText)
      partial = true
      expect((yield* me("agent-sibling", { mood: "happy" })).body).toContain("Unavailable")
      expect((yield* post({ ...body, eventId: "event-two" })).body).toContain("Unavailable")
      partial = false
      writeFileSync(identityMode, "node-alpha")
      expect((yield* me("agent-sibling", { mood: "happy" })).body).toContain("UnboundAgent")
      expect((yield* me("agent-remote", { say: "Remote update" })).status).toBe(200)
      const remoteDirectory = yield* Effect.promise(() => secureRequestBody(`${canonical}/v1/connect/agents`, headers))
      expect(
        Schema.decodeUnknownSync(Schema.fromJsonString(FleetConnectAgentPage))(remoteDirectory.body).agents
          .find(({ id }) => id === "agent-remote")?.self?.say
      ).toBe("Remote update")
      expect((yield* post(body)).body).toContain("UnboundAgent")
      expect((yield* post({ ...body, agentId: "agent-remote" })).status).toBe(200)
      writeFileSync(identityMode, "node-foreign")
      expect((yield* me("agent-one", { mood: "happy" })).body).toContain("Denied")
      expect((yield* post(body)).body).toContain("Denied")
      for (const listener of [server.url, server.tailnetUrl, server.lanWorkUrl]) {
        expect(
          (yield* Effect.promise(() =>
            fetch(`${listener}/v1/connect/me`, {
              method: "POST",
              headers: { "x-herdr-agent-id": "agent-one" },
              body: JSON.stringify({ mood: "happy" })
            })
          )).status
        ).toBe(403)
        expect(
          (yield* Effect.promise(() =>
            fetch(`${listener}/v1/connect/posts`, { method: "POST", body: JSON.stringify(body) })
          )).status
        ).toBe(403)
      }
    })).pipe(provideNodeServices)
  })

  it.effect("releases a peer's own hue reservations while the canonical hub archives in a separate database", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-peer-hues-"))
    const mainRoot = join(root, "hub")
    const peerRoot = join(root, "peer")
    mkdirSync(mainRoot, { mode: 0o700 })
    mkdirSync(peerRoot, { mode: 0o700 })
    const mainTailscale = join(mainRoot, "tailscale-test")
    const peerTailscale = join(peerRoot, "tailscale-test")
    for (
      const { address, command, host, status } of [
        {
          command: mainTailscale,
          address: "127.0.0.1",
          host: "ALPHA",
          status:
            "{\"atlas\":{\"HostName\":\"atlas\",\"ID\":\"node-atlas\",\"Online\":true,\"TailscaleIPs\":[\"127.0.0.2\"]}}"
        },
        { command: peerTailscale, address: "127.0.0.2", host: "atlas", status: "{}" }
      ]
    ) {
      writeFileSync(
        command,
        `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '${address}' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-alpha"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
  status) printf '%s\n' '{"Peer":${status},"Self":{"HostName":"${host}","ID":"node-${host.toLowerCase()}","Online":true,"TailscaleIPs":["${address}"]}}' ;;
esac
`,
        { mode: 0o700 }
      )
    }
    let names = ["sec-cc", ...Array.from({ length: 7 }, (_, index) => `worker-${String(index)}`)]
    let partial = false
    const peerOperations: HostOperations = {
      ...operations,
      listAgents: () =>
        Effect.succeed({
          available: true,
          error: partial ? "partial inventory" : null,
          agents: names.map((name, index) => ({
            activityRevision: 1,
            agentId: `agent-${name}`,
            name,
            paneId: `w1:p${String(index + 1)}`,
            kind: "codex",
            parentAgentId: null,
            relation: null,
            status: "working",
            work: "project"
          }))
        })
    }
    return Effect.scoped(Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const firstSeenAt = (yield* TestClock.withLive(Clock.currentTimeMillis)) - 300_002
      let observedAt = firstSeenAt
      const peerStore = yield* Effect.acquireRelease(
        JobStore.open(join(peerRoot, "jobs.sqlite")),
        (opened) => Effect.sync(() => opened.close())
      )
      const mainStore = yield* Effect.acquireRelease(
        JobStore.open(join(mainRoot, "jobs.sqlite")),
        (opened) => Effect.sync(() => opened.close())
      )
      const peerFleet = yield* makeFleetService({
        approvalEnabled: true,
        host: "atlas",
        operations: peerOperations,
        store: peerStore
      })
      const mainFleet = yield* makeFleetService({ approvalEnabled: true, host: "ALPHA", operations, store: mainStore })
      const shared = {
        approvalNodes: ["node-alpha"],
        approvalPort: 0,
        crossHost: true,
        port: 0,
        machines: [{ host: "ALPHA", nodeId: "node-alpha" }, { host: "atlas", nodeId: "node-atlas" }]
      }
      const peerConfig: HostConfiguration = {
        ...config(peerRoot),
        ...shared,
        host: "atlas",
        tailscaleCommand: peerTailscale,
        approvalHub: { host: "ALPHA", nodeId: "node-alpha", url: "https://alpha.example.test/" }
      }
      // Bind the hub to the peer's chosen ports on a different loopback address; retry only port collisions.
      const { approvalPort, mainServer, peerServer } = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async (): Promise<PairStart> => {
            const peerServer = await startHttpServer(peerConfig, peerFleet, assets, {
              terminalConnector: unusedTerminal,
              now: () => observedAt
            })
            const ports = await Promise.resolve().then(() => ({
              approvalPort: boundPort(peerServer.approvalUrl),
              peerPort: boundPort(peerServer.tailnetUrl)
            })).catch(async (cause: unknown) => {
              await peerServer.close()
              throw cause
            })
            try {
              const mainServer = await startHttpServer(
                {
                  ...config(mainRoot),
                  ...shared,
                  host: "ALPHA",
                  tailscaleCommand: mainTailscale,
                  approvalPort: ports.approvalPort,
                  port: ports.peerPort,
                  approvalTls: directTls,
                  approvalHub: {
                    host: "ALPHA",
                    nodeId: "node-alpha",
                    url: `https://alpha.example.test:${String(ports.approvalPort)}/`
                  }
                },
                mainFleet,
                assets,
                { terminalConnector: unusedTerminal, now: () => observedAt }
              )
              return { _tag: "Started", approvalPort: ports.approvalPort, mainServer, peerServer }
            } catch (cause) {
              await peerServer.close()
              if (isAddressInUse(cause) && (cause.port === ports.peerPort || cause.port === ports.approvalPort)) {
                return { _tag: "PortTaken", cause }
              }
              throw cause
            }
          },
          catch: (cause) => new ApprovalStartFailed({ cause })
        }).pipe(
          Effect.flatMap((started) =>
            started._tag === "PortTaken"
              ? Effect.fail(new ApprovalPortTaken({ cause: started.cause }))
              : Effect.succeed(started)
          ),
          Effect.retry({ times: 4, while: (error) => error._tag === "ApprovalPortTaken" })
        ),
        ({ mainServer, peerServer }) =>
          Effect.promise(async () => {
            await mainServer.close()
            await peerServer.close()
          })
      )
      if (mainServer.serveUrl === null || peerServer.tailnetUrl === null) {
        return yield* Effect.die("peer hue listeners missing")
      }
      const canonicalUrl = mainServer.serveUrl
      const peerUrl = peerServer.tailnetUrl
      const headers = { host: `alpha.example.test:${String(approvalPort)}` }
      const get = (path: string) => Effect.promise(() => secureRequestBody(`${canonicalUrl}${path}`, headers))
      // An optional read may return before the owned allocation finishes. Poll
      // through the real peer route to assert its eventual reservation, not every response's decoration.
      const expectPeerHue = (id: string, hue: string) =>
        Effect.promise(() =>
          expect.poll(async () => {
            const response = await fetch(`${peerUrl}/v1/connect/agents/local`)
            expect(response.status).toBe(200)
            const page = Schema.decodeUnknownSync(Schema.fromJsonString(LocalConnectAgents))(await response.text())
            return page.agents.find((agent) => agent.id === id)?.hue
          }, { timeout: 2_000 }).toBe(hue)
        )
      const initial = yield* get("/v1/connect/agents")
      expect(initial.status).toBe(200)
      const initialPage = Schema.decodeUnknownSync(Schema.fromJsonString(FleetConnectAgentPage))(initial.body)
      expect(initialPage.failures).toEqual([])
      expect(initialPage.agents).toHaveLength(8)
      expect(new Set(initialPage.agents.map(({ hue }) => hue)).size).toBe(8)
      expect(initialPage.agents.find(({ id }) => id === "agent-sec-cc")).toHaveProperty("hue", "rose")
      const peerHues = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(join(peerRoot, "approval-app.sqlite"), { readOnly: true })),
        (database) => Effect.sync(() => database.close())
      )
      const liveReservations = () =>
        Schema.decodeUnknownSync(Schema.Array(Schema.Struct({
          agent_id: Schema.String,
          hue: Schema.String,
          body_kind: Schema.String,
          exclusive: Schema.Literals([0, 1])
        })))(
          peerHues.prepare(
            "SELECT agent_id, hue, body_kind, exclusive FROM connect_agent_hues WHERE host = ? AND closed_at IS NULL"
          ).all("atlas")
        )
      // Partial evidence does not release any of the eight peer reservations.
      names = ["skills"]
      partial = true
      observedAt = firstSeenAt + 1
      const partialRead = yield* Effect.promise(() => fetch(`${peerUrl}/v1/connect/agents/local`))
      expect(partialRead.status).toBe(200)
      const partialPage = Schema.decodeUnknownSync(Schema.fromJsonString(LocalConnectAgents))(
        yield* Effect.promise(() => partialRead.text())
      )
      expect(partialPage.complete).toBe(false)
      // Rev6 payload seeds make sec-cc a circle and skills a squircle. With all eight families held,
      // rose is the first shape-safe overflow family; sharing it does not prove the peer released a holder.
      yield* expectPeerHue("agent-skills", "rose")
      const retained = liveReservations()
      expect(retained).toHaveLength(9)
      expect(retained.filter(({ exclusive }) => exclusive === 1)).toHaveLength(8)
      expect(retained.find(({ agent_id }) => agent_id === "agent-sec-cc"))
        .toMatchObject({ hue: "rose", body_kind: "circle", exclusive: 1 })
      expect(retained.find(({ agent_id }) => agent_id === "agent-skills"))
        .toMatchObject({ hue: "rose", body_kind: "squircle", exclusive: 0 })
      names = []
      partial = false
      observedAt = firstSeenAt + 2
      yield* get("/v1/connect/agents")
      observedAt = firstSeenAt + 300_002
      yield* get("/v1/connect/agents")
      const archived = yield* get("/v1/connect/archive")
      expect(archived.status).toBe(200)
      const archivePage = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectArchivePage))(archived.body)
      expect(archivePage.agents).toHaveLength(8)
      expect(archivePage.agents.find(({ agentId }) => agentId === "agent-sec-cc")).toHaveProperty("hue", "rose")
      expect(liveReservations()).toEqual([])
      names = ["skills"]
      observedAt++
      yield* expectPeerHue("agent-skills", "rose")
      // The returning squircle keeps its recorded rose. The new identity probes retired-family reuse.
      names = ["skills", "replacement-4"]
      observedAt++
      // All original families closed together: rose is live again, so ember wins the palette-order tie.
      yield* expectPeerHue("agent-replacement-4", "ember")
      yield* expectPeerHue("agent-skills", "rose")
    })).pipe(provideNodeServices)
  })

  it.effect("archives confirmed closures through the authenticated listener and rejects other listeners and malformed cursors", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-archive-"))
    const tailscaleCommand = join(root, "tailscale-test")
    const identityMode = join(root, "identity-mode")
    writeFileSync(identityMode, "allowed")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois)
    if [ "$(cat '${identityMode}')" = allowed ]; then
      printf '%s\n' '{"Node":{"StableID":"node-phone"},"UserProfile":{"LoginName":"user@example.test"}}'
    else
      printf '%s\n' '{"Node":{"StableID":"node-phone"},"UserProfile":{"LoginName":"outsider@example.test"}}'
    fi ;;
  status) printf '%s\n' '{"Peer":{},"Self":{"HostName":"SER8","ID":"node-ser8","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    const hostConfig: HostConfiguration = {
      ...config(root),
      allowedUsers: ["user@example.test"],
      approvalHub: { host: "SER8", nodeId: "node-ser8", url: "https://ser8.example.test:0/" },
      approvalPort: 0,
      approvalTls: directTls,
      applyMachines: ["SER8"],
      crossHost: true,
      host: "SER8",
      machines: [{ host: "SER8", nodeId: "node-ser8" }],
      tailscaleCommand
    }
    let present = true
    let partial = false
    const archiveOperations: HostOperations = {
      ...operations,
      listAgents: () =>
        Effect.succeed({
          available: true,
          error: partial ? "incomplete inventory" : null,
          agents: [
            {
              activityRevision: 1,
              agentId: "agent-staying",
              kind: "codex",
              name: "staying",
              paneId: "w1:p2",
              parentAgentId: null,
              relation: null,
              status: "working",
              work: "project"
            },
            ...(present ?
              [{
                activityRevision: 1,
                agentId: "agent-archive",
                kind: "codex",
                name: "worker",
                paneId: "w1:p1",
                parentAgentId: null,
                relation: null,
                status: "working",
                work: "project"
              }] :
              [])
          ]
        })
    }
    return Effect.scoped(Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      // The HTTP runtime owns a live Clock; keep this simulated ten-minute absence inside its archive window.
      const firstSeenAt = (yield* TestClock.withLive(Clock.currentTimeMillis)) - 600_003
      let observedAt = firstSeenAt
      const store = yield* Effect.acquireRelease(
        JobStore.open(join(root, "jobs.sqlite")),
        (opened) => Effect.sync(() => opened.close())
      )
      const fleet = yield* makeFleetService({
        approvalEnabled: true,
        host: "SER8",
        operations: archiveOperations,
        store
      })
      const server = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startHttpServer(hostConfig, fleet, assets, {
            terminalConnector: unusedTerminal,
            now: () => observedAt,
            lanWork: { address: "127.0.0.1", port: 0 }
          })
        ),
        (running) => Effect.promise(running.close)
      )
      if (server.serveUrl === null || server.lanWorkUrl === null || server.tailnetUrl === null) {
        return yield* Effect.die("archive listener fixture missing")
      }
      const canonicalUrl = server.serveUrl
      const headers = { host: "ser8.example.test:0" }
      const get = (path: string) => Effect.promise(() => secureRequestBody(`${canonicalUrl}${path}`, headers))
      const page = Effect.fn("ArchiveHttpTest.page")(function*() {
        const response = yield* get("/v1/connect/archive")
        expect(response.status).toBe(200)
        return Schema.decodeUnknownSync(Schema.fromJsonString(ConnectArchivePage))(response.body)
      })
      expect((yield* page()).agents).toEqual([])
      const initialDirectory = yield* get("/v1/connect/agents")
      expect(initialDirectory.status).toBe(200)
      const initialAgents =
        Schema.decodeUnknownSync(Schema.fromJsonString(FleetConnectAgentPage))(initialDirectory.body).agents
      // Rev6 first sighting hashes the canonical stable ID: FNV-1a("ser8:archive") %8 is7, Iris.
      expect(initialAgents.find(({ id }) => id === "agent-archive")).toHaveProperty("hue", "iris")
      present = false
      observedAt = firstSeenAt + 1
      yield* get("/v1/connect/agents")
      observedAt = firstSeenAt + 300_001
      partial = true
      const partialDirectory = yield* get("/v1/connect/agents")
      expect(partialDirectory.status).toBe(200)
      expect(
        Schema.decodeUnknownSync(Schema.fromJsonString(FleetConnectAgentPage))(partialDirectory.body).agents.map((
          { id }
        ) => id)
      ).toEqual(["agent-staying"])
      expect((yield* page()).agents).toEqual([])
      partial = false
      observedAt = firstSeenAt + 300_002
      yield* get("/v1/connect/agents")
      expect((yield* page()).agents).toEqual([])
      observedAt = firstSeenAt + 600_002
      yield* get("/v1/connect/agents")
      expect((yield* page()).agents).toEqual([{
        host: "ser8",
        agentId: "agent-archive",
        name: "worker",
        hue: "iris",
        kind: "codex",
        work: "project",
        state: "working",
        firstSeenAt,
        closedAt: firstSeenAt + 600_002
      }])
      const continuation = encodeURIComponent(
        JSON.stringify({ host: "SER8", agentId: "agent-archive", closedAt: firstSeenAt + 600_002 })
      )
      const afterLast = yield* get(`/v1/connect/archive?cursor=${continuation}`)
      expect(afterLast.status).toBe(200)
      expect(Schema.decodeUnknownSync(Schema.fromJsonString(ConnectArchivePage))(afterLast.body).agents).toEqual([])
      for (
        const cursor of [
          "",
          "null",
          "{",
          "{}",
          "x".repeat(1_025),
          JSON.stringify({ host: "SER8", agentId: "agent-archive", closedAt: -1 })
        ]
      ) {
        const invalid = yield* get(`/v1/connect/archive?cursor=${encodeURIComponent(cursor)}`)
        expect(invalid.status, cursor).toBe(400)
      }
      // The loopback serves the super-app, so it reads the archive too; other listeners never do.
      expect((yield* Effect.promise(() => fetch(`${server.url}/v1/connect/archive`))).status).toBe(200)
      for (const listener of [server.tailnetUrl, server.lanWorkUrl]) {
        expect((yield* Effect.promise(() => fetch(`${listener}/v1/connect/archive`))).status).toBe(404)
      }
      writeFileSync(identityMode, "denied")
      expect((yield* get("/v1/connect/archive")).status).toBe(403)
      writeFileSync(identityMode, "allowed")
      present = true
      observedAt = firstSeenAt + 600_003
      yield* get("/v1/connect/agents")
      expect((yield* page()).agents).toEqual([])
      // Palette writes are optional enrichment; a failed transaction must not hide the host's agents.
      const hueDatabase = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(join(root, "approval-app.sqlite"))),
        (opened) => Effect.sync(() => opened.close())
      )
      hueDatabase.exec(`CREATE TRIGGER hue_failure BEFORE INSERT ON connect_agent_hues
        BEGIN SELECT RAISE(ABORT, 'HUE_PRIVATE_SENTINEL'); END`)
      const hueWarnings = vi.spyOn(Logger.defaultLogger, "log")
      yield* Effect.addFinalizer(() => Effect.sync(() => hueWarnings.mockRestore()))
      const hueFailureDirectory = yield* get("/v1/connect/agents")
      expect(hueFailureDirectory.status).toBe(200)
      const hueFreePage = Schema.decodeUnknownSync(Schema.fromJsonString(FleetConnectAgentPage))(
        hueFailureDirectory.body
      )
      expect(hueFreePage.agents.map(({ id }) => id)).toEqual(["agent-archive", "agent-staying"])
      for (const agent of hueFreePage.agents) expect(agent).not.toHaveProperty("hue")
      expect(hueFreePage.failures).toEqual([])
      expect(hueWarnings.mock.calls.map(([entry]) => entry.logLevel)).toEqual(["Warn"])
      expect(hueWarnings.mock.calls.map(([entry]) => entry.message)).toEqual([
        ["ConnectHueAssignmentFailed", { host: "SER8", cause: "TerminalTransportError" }]
      ])
      hueWarnings.mockRestore()
      hueDatabase.exec("DROP TRIGGER hue_failure")
    })).pipe(provideNodeServices)
  })

  it.effect("serves host resources read-only with usage authorization and no gate default", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "host-resources-test-" })
      const store = yield* Effect.acquireRelease(
        JobStore.open(join(root, "jobs.sqlite")),
        (opened) => Effect.sync(() => opened.close())
      )
      const fleet = yield* makeFleetService({ approvalEnabled: false, host: "ALPHA", operations, store })
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => startHttpServer(config(root), fleet, assets, { terminalConnector: unusedTerminal })),
        (running) => Effect.promise(running.close)
      )
      const denied = yield* Effect.promise(() =>
        fetch(`${server.url}/v1/host/resources`, { headers: { "tailscale-user-login": "viewer@example.test" } })
      )
      expect(denied.status).toBe(403)
      const response = yield* Effect.promise(() => fetch(`${server.url}/v1/host/resources`))
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
      const snapshot = yield* Schema.decodeUnknownEffect(HostResources)(yield* Effect.promise(() => response.json()))
      expect(snapshot.host).toBe("ALPHA")
      expect(snapshot.gate).toEqual({ _tag: "Unavailable", reason: "not_configured" })
      expect(snapshot.heavyJobs).toEqual({ _tag: "Unavailable", reason: "not_configured" })
      expect((yield* Effect.promise(() => fetch(`${server.url}/v1/host/resources`, { method: "POST" }))).status).toBe(
        404
      )
    }).pipe(Effect.scoped, provideNodeServices))

  it.effect("serves this host's usage for the asked range and zone, and refuses a query it cannot pass on", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-usage-"))
    const usage = {
      v: 1,
      machine: "ALPHA",
      observedAt: 1_000,
      range: { preset: "30d", timeZone: "Europe/Amsterdam", from: 0, to: 1_000, bucket: "day" },
      periods: [{ key: "2026-10-08", start: 0 }],
      tokens: [{ period: 0, agent: "claude", model: "claude-opus-5", tokens: 900 }],
      limits: []
    }
    // agent-usage stand-in: answers only `usage --range 30d --time-zone Europe/Amsterdam`.
    const script = `if [ "$*" = "usage --range 30d --time-zone Europe/Amsterdam" ]; then printf '%s' '${
      JSON.stringify(usage)
    }'; else echo "got: $*" >&2; exit 2; fi`
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({ approvalEnabled: false, host: "ALPHA", operations, store })
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(
                { ...config(root), agentUsageLimitsCommand: ["sh", "-c", script, "agent-usage", "limits"] },
                fleet,
                assets,
                { terminalConnector: unusedTerminal }
              )
            ),
            (running) => Effect.promise(running.close)
          )
          const response = yield* Effect.promise(() =>
            fetch(`${server.url}/v1/connect/usage?range=30d&timeZone=Europe%2FAmsterdam`)
          )
          expect(response.status).toBe(200)
          const body = Schema.decodeUnknownSync(FleetUsage)(yield* Effect.promise(() => response.json()))
          expect(body.hosts.map(({ host, reading }) => [host, reading])).toEqual([
            ["ALPHA", { _tag: "Read", usage, skipped: 0 }]
          ])
          // A zone that could split the command line, or a range agent-usage does not offer, never reaches it.
          for (const query of ["range=30d&timeZone=UTC%20limits", "range=90d&timeZone=UTC", "range=7d"]) {
            const refused = yield* Effect.promise(() => fetch(`${server.url}/v1/connect/usage?${query}`))
            expect(refused.status, query).toBe(400)
          }
          // Only a peer's tailnet listener answers the hub's per-host question.
          expect(
            (yield* Effect.promise(() => fetch(`${server.url}/v1/connect/usage/local?range=7d&timeZone=UTC`))).status
          )
            .toBe(404)
        }).pipe(Effect.scoped),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("serves this host's limits on its own listener and keeps the peer route off it", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-limits-"))
    const report = {
      v: 1,
      machine: "ALPHA",
      observedAt: 1_000,
      latest: [{
        agent: "claude",
        machine: "ALPHA",
        source: "claude-oauth-usage",
        label: "*",
        windowMinutes: null,
        observedAt: 900,
        reading: { _tag: "Unknown", reason: "Fetch" }
      }]
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({ approvalEnabled: false, host: "ALPHA", operations, store })
          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startHttpServer(
                {
                  ...config(root),
                  agentUsageLimitsCommand: ["sh", "-c", "printf '%s' \"$1\"", "agent-usage", JSON.stringify(report)]
                },
                fleet,
                assets,
                { terminalConnector: unusedTerminal }
              )
            ),
            (running) => Effect.promise(running.close)
          )
          const response = yield* Effect.promise(() => fetch(`${server.url}/v1/connect/limits`))
          expect(response.status).toBe(200)
          const body = Schema.decodeUnknownSync(FleetLimits)(yield* Effect.promise(() => response.json()))
          expect(body.failures).toEqual([])
          expect(body.hosts.map(({ host, reading }) => [host, reading])).toEqual([
            ["ALPHA", { _tag: "Read", limits: report, skipped: 0 }]
          ])
          // Only a peer's tailnet listener answers the hub's per-host question.
          expect((yield* Effect.promise(() => fetch(`${server.url}/v1/connect/limits/local`))).status).toBe(404)
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

  it.effect("inspects an authenticated PR owner binding without changing Work", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-pr-link-"))
    const identityMode = join(root, "identity-mode")
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(identityMode, "allowed")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois)
    if [ "$(cat '${identityMode}')" = allowed ]; then
      printf '%s\n' '{"Node":{"StableID":"node-phone"},"UserProfile":{"LoginName":"owner@example.com"}}'
    else
      printf '%s\n' '{"Node":{"StableID":"node-phone"},"UserProfile":{"LoginName":"mallory@example.com"}}'
    fi ;;
  status) printf '%s\n' '{"Peer":{},"Self":{"HostName":"SER8","ID":"node-ser8","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    const hostConfig: HostConfiguration = {
      ...config(root),
      approvalHub: { host: "SER8", nodeId: "node-ser8", url: "https://ser8.example.test:0/" },
      approvalNodes: ["node-phone"],
      approvalPort: 0,
      approvalTls: directTls,
      applyMachines: ["SER8"],
      crossHost: true,
      host: "SER8",
      machines: [{ host: "SER8", nodeId: "node-ser8" }],
      port: 0,
      tailscaleCommand
    }
    return Effect.scoped(
      Effect.gen(function*() {
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
        // Local and work listeners bind port 0; only the approval hub's port is chosen up front.
        const baseListenerConfig = {
          ...hostConfig,
          localPort: 0,
          port: 0,
          machines: [...hostConfig.machines, { host: "ALPHA", nodeId: "node-alpha" }]
        }
        const workStore = yield* WorkStore.open(join(root, "approval-app.sqlite"))
        yield* Effect.addFinalizer(() => Effect.sync(() => workStore.close()))
        const work = yield* makeWorkService(workStore)
        const goal: WorkGoalCheckpointType = {
          ...workCheckpoint,
          occurredAt: 0,
          goal: {
            ...workCheckpoint.goal,
            createdAt: 0,
            updatedAt: 0,
            goalFamily: { canonicalGoalId: "goal-work", role: "canonical" },
            review: {
              state: "requested",
              summary: null,
              updatedAt: 0,
              url: "https://github.com/knpkv/npm/pull/433"
            }
          }
        }
        yield* work.record(goal)
        const lane = yield* work.claim({
          operationId: "claim-pr-433",
          goalId: "goal-work",
          laneId: "lane-pr-433",
          worktree: root,
          branch: "feat/pr-433",
          head: "0123456789abcdef0123456789abcdef01234567",
          owner: workCheckpoint.goal.owner,
          parent: null,
          phase: "review",
          expectedRevision: 0
        })
        const worker = { host: "SER8", agentId: "agent-pr-433", name: "Owner", paneId: "w1:p3" }
        const binding = yield* work.bindAgent({
          version: "herdr.work.agent-binding-request.v1",
          dispatchRequestId: "dispatch-pr-433",
          expectedRevision: lane.revision,
          laneId: lane.laneId,
          worker
        })
        const unlinked: WorkGoalCheckpointType = {
          ...workCheckpoint,
          eventId: "original-jcf-event",
          occurredAt: 1_001,
          goal: {
            ...workCheckpoint.goal,
            id: "jcf-ai-review",
            state: "blocked",
            blocker: { summary: "Supported linkage pending", since: 1_001 },
            createdAt: 1_001,
            updatedAt: 1_001,
            delivery: "pull_request",
            repository: { repository: "knpkv/npm", branch: "feat/jcf" },
            goalFamily: {
              canonicalGoalId: "jcf-ai-review",
              role: "canonical"
            }
          }
        }
        yield* work.record(unlinked)
        const before = yield* work.snapshots()
        const jobStore = yield* JobStore.open(join(root, "jobs.sqlite"))
        yield* Effect.addFinalizer(() => Effect.sync(() => jobStore.close()))
        const fleet = yield* makeFleetService({ approvalEnabled: true, host: "SER8", operations, store: jobStore })
        const { approvalPort, listenerConfig, server } = yield* Effect.acquireRelease(
          startWithApprovalPort(async (approvalPort) => {
            const listenerConfig = {
              ...baseListenerConfig,
              approvalPort,
              approvalHub: { ...hostConfig.approvalHub, url: `https://127.0.0.1:${approvalPort}/` }
            }
            const server = await startHttpServer(listenerConfig, fleet, assets, { terminalConnector: unusedTerminal })
            return { approvalPort, listenerConfig, server }
          }),
          (running) => Effect.promise(running.server.close)
        )
        if (server.serveUrl === null) {
          return yield* Effect.die("serve URL missing")
        }
        const path =
          "/v1/work/pull-request-link?repository=knpkv%2Fnpm&pullRequest=433&goalId=goal-work&laneId=lane-pr-433"
        const headers = { host: `127.0.0.1:${approvalPort}` }
        const accepted = yield* Effect.promise(() => secureRequestBody(`${server.serveUrl}${path}`, headers))
        expect(accepted.status).toBe(200)
        expect(JSON.parse(accepted.body)).toMatchObject({
          goalId: "goal-work",
          goalEventId: binding.checkpoint.eventId,
          lane: { revision: binding.lane.revision, head: binding.lane.head },
          binding: { dispatchRequestId: "dispatch-pr-433", worker }
        })
        const admissionTarget = {
          repository: "knpkv/npm",
          pullRequest: 434,
          reviewUrl: "https://github.com/knpkv/npm/pull/434",
          goalId: "release-pr-434",
          laneId: "lane-pr-434",
          head: "a".repeat(40),
          baseHead: "b".repeat(40),
          owner: workCheckpoint.goal.owner,
          sessionId: "01a0ae7d-ed74-73c1-8454-4aed86de10cc",
          expectedWork: "feat/pr-434",
          worker: { host: "SER8", agentId: "agent-pr-434", name: "Owner", paneId: "w1:p4" },
          worktree: `${root}/pr-434`,
          branch: "feat/pr-434"
        }
        const admissionPath = `/v1/work/admission-preflight?target=${
          encodeURIComponent(
            JSON.stringify(admissionTarget)
          )
        }`
        const admission = yield* Effect.promise(() => secureRequestBody(`${server.serveUrl}${admissionPath}`, headers))
        expect(admission.status).toBe(200)
        expect(JSON.parse(admission.body)).toMatchObject({ _tag: "prospective", target: admissionTarget })
        const recoveryTarget = {
          ...admissionTarget,
          pullRequest: 376,
          reviewUrl: "https://github.com/knpkv/npm/pull/376",
          goalId: unlinked.goal.id,
          laneId: "jcf-release-lane",
          owner: unlinked.goal.owner,
          worker: {
            host: "SER8",
            agentId: "agent-jcf",
            name: "JCF owner",
            paneId: "w1:p5"
          },
          worktree: `${root}/jcf`,
          branch: "feat/jcf",
          expectedGoalEventId: unlinked.eventId,
          expectedGoalUpdatedAt: unlinked.goal.updatedAt
        }
        const recoveryPath = `/v1/work/recovery-preflight?target=${encodeURIComponent(JSON.stringify(recoveryTarget))}`
        const recovery = yield* Effect.promise(() => secureRequestBody(`${server.serveUrl}${recoveryPath}`, headers))
        expect(recovery.status).toBe(200)
        expect(JSON.parse(recovery.body)).toMatchObject({
          _tag: "recoverable",
          target: recoveryTarget
        })
        const cliConfigPath = join(root, "fleet.json")
        // fleetctl reaches the listeners hostd actually bound.
        writeFileSync(
          cliConfigPath,
          // On a cross-host hub, `port` is served by the tailnet listener.
          JSON.stringify({ ...listenerConfig, localPort: boundPort(server.url), port: boundPort(server.tailnetUrl) })
        )
        const contextPath = `/v1/work/recovery-context?goalId=${encodeURIComponent(unlinked.goal.id)}`
        const contextResponse = yield* Effect.promise(() =>
          secureRequestBody(`${server.serveUrl}${contextPath}`, headers)
        )
        expect(contextResponse.status).toBe(200)
        const expectedContext = {
          goalId: unlinked.goal.id,
          expectedGoalEventId: unlinked.eventId,
          expectedGoalUpdatedAt: unlinked.goal.updatedAt
        }
        expect(JSON.parse(contextResponse.body)).toEqual(expectedContext)
        const cliContext = yield* Effect.promise(() =>
          workPreflightFromFleetctl("recovery-context", cliConfigPath, unlinked.goal.id)
        )
        expect(cliContext.code, cliContext.stderr).toBe(0)
        expect(JSON.parse(cliContext.stdout)).toEqual(expectedContext)
        const contextFacts = yield* Schema.decodeEffect(Schema.fromJsonString(WorkRecoveryContext), {
          onExcessProperty: "error"
        })(cliContext.stdout)
        for (const invalidId of ["", "missing-goal"]) {
          const invalidContext = yield* Effect.promise(() =>
            secureRequestBody(
              `${server.serveUrl}/v1/work/recovery-context?goalId=${encodeURIComponent(invalidId)}`,
              headers
            )
          )
          expect(invalidContext.status).toBe(invalidId === "" ? 400 : 404)
        }
        const missingContext = yield* Effect.promise(() =>
          secureRequestBody(`${server.serveUrl}/v1/work/recovery-context`, headers)
        )
        expect(missingContext.status).toBe(400)
        const cliRecovery = yield* Effect.promise(() =>
          workPreflightFromFleetctl(
            "recovery-preflight",
            cliConfigPath,
            JSON.stringify({ ...recoveryTarget, ...contextFacts })
          )
        )
        expect(cliRecovery.code, cliRecovery.stderr).toBe(0)
        expect(JSON.parse(cliRecovery.stdout)).toMatchObject({ _tag: "recoverable", target: recoveryTarget })
        const cliAdmission = yield* Effect.promise(() =>
          workPreflightFromFleetctl("admission-preflight", cliConfigPath, JSON.stringify(admissionTarget))
        )
        expect(cliAdmission.code, cliAdmission.stderr).toBe(0)
        expect(JSON.parse(cliAdmission.stdout)).toMatchObject({ _tag: "prospective", target: admissionTarget })
        const preflightOperations: ReadonlyArray<"admission-preflight" | "recovery-preflight"> = [
          "admission-preflight",
          "recovery-preflight"
        ]
        for (const operation of preflightOperations) {
          const target = operation === "admission-preflight" ? admissionTarget : recoveryTarget
          const invalid = yield* Effect.promise(() =>
            workPreflightFromFleetctl(operation, cliConfigPath, JSON.stringify({ ...target, head: "bad" }))
          )
          expect(invalid.code).not.toBe(0)
          expect(invalid.stderr).toContain("invalid")
          const missing = yield* Effect.promise(() => workPreflightFromFleetctl(operation, cliConfigPath, undefined))
          expect(missing.code).not.toBe(0)
          const malformed = yield* Effect.promise(() => workPreflightFromFleetctl(operation, cliConfigPath, "{"))
          expect(malformed.code).not.toBe(0)
          expect(malformed.stderr).toContain("invalid")
          const noncanonical = yield* Effect.promise(() =>
            workPreflightFromFleetctl(operation, cliConfigPath, JSON.stringify(target), "ALPHA")
          )
          expect(noncanonical.code).not.toBe(0)
          expect(noncanonical.stderr).toContain("canonical approval hub")
          const foreign = yield* Effect.promise(() =>
            workPreflightFromFleetctl(operation, cliConfigPath, JSON.stringify(target), "FOREIGN")
          )
          expect(foreign.code).not.toBe(0)
          expect(foreign.stderr).toContain("unknown host")
        }
        expect(yield* work.snapshots()).toEqual(before)
        writeFileSync(identityMode, "denied")
        const deniedContext = yield* Effect.promise(() =>
          secureRequestBody(`${server.serveUrl}${contextPath}`, headers)
        )
        expect(deniedContext.status).toBe(403)
        const deniedContextCli = yield* Effect.promise(() =>
          workPreflightFromFleetctl("recovery-context", cliConfigPath, unlinked.goal.id)
        )
        expect(deniedContextCli.code).not.toBe(0)
        expect(deniedContextCli.stderr).toContain("HTTP 403")
        const denied = yield* Effect.promise(() => secureRequestBody(`${server.serveUrl}${path}`, headers))
        expect(denied.status).toBe(403)
        const deniedAdmission = yield* Effect.promise(() =>
          secureRequestBody(`${server.serveUrl}${admissionPath}`, headers)
        )
        expect(deniedAdmission.status).toBe(403)
        const deniedRecovery = yield* Effect.promise(() =>
          secureRequestBody(`${server.serveUrl}${recoveryPath}`, headers)
        )
        expect(deniedRecovery.status).toBe(403)
        for (const operation of preflightOperations) {
          const target = operation === "admission-preflight" ? admissionTarget : recoveryTarget
          const deniedCli = yield* Effect.promise(() =>
            workPreflightFromFleetctl(operation, cliConfigPath, JSON.stringify(target))
          )
          expect(deniedCli.code).not.toBe(0)
          expect(deniedCli.stderr).toContain("HTTP 403")
        }
        expect(yield* work.snapshots()).toEqual(before)
      }).pipe(provideNodeServices)
    )
  }, 30_000)

  it.effect("routes local admission and recovery preflights through the authenticated local listener", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-local-preflight-"))
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      // Both listeners bind port 0; fleetctl gets the ports hostd actually bound.
      const hostConfig = { ...config(root), approvalNodes: ["node-phone"], localPort: 0, port: 0 }
      const workStore = yield* WorkStore.open(join(root, "approval-app.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => workStore.close()))
      const work = yield* makeWorkService(workStore)
      const unlinked: WorkGoalCheckpointType = {
        ...workCheckpoint,
        goal: {
          ...workCheckpoint.goal,
          id: "jcf-local-goal",
          delivery: "pull_request",
          repository: { repository: "knpkv/npm", branch: "feat/pr-434" },
          goalFamily: { canonicalGoalId: "jcf-local-goal", role: "canonical" },
          state: "blocked",
          blocker: { since: 1_000, summary: "Linkage pending" }
        }
      }
      yield* work.record(unlinked)
      const before = yield* work.snapshots()
      const store = yield* JobStore.open(join(root, "jobs.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const fleet = yield* makeFleetService({ approvalEnabled: false, host: "ALPHA", operations, store })
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => startHttpServer(hostConfig, fleet, assets, { terminalConnector: unusedTerminal })),
        (running) => Effect.promise(running.close)
      )
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/)
      const admissionTarget = {
        repository: "knpkv/npm",
        pullRequest: 434,
        reviewUrl: "https://github.com/knpkv/npm/pull/434",
        goalId: "release-pr-434",
        laneId: "lane-pr-434",
        head: "a".repeat(40),
        baseHead: "b".repeat(40),
        owner: workCheckpoint.goal.owner,
        sessionId: "01a0ae7d-ed74-73c1-8454-4aed86de10cc",
        expectedWork: "feat/pr-434",
        worker: { host: "ALPHA", agentId: "agent-pr-434", name: "Owner", paneId: "w1:p4" },
        worktree: `${root}/pr-434`,
        branch: "feat/pr-434"
      }
      const recoveryTarget = {
        ...admissionTarget,
        goalId: unlinked.goal.id,
        expectedGoalEventId: unlinked.eventId,
        expectedGoalUpdatedAt: unlinked.goal.updatedAt
      }
      const cliConfigPath = join(root, "fleet.json")
      writeFileSync(
        cliConfigPath,
        JSON.stringify({ ...hostConfig, localPort: boundPort(server.url), port: boundPort(server.workUrl) })
      )
      const context = yield* Effect.promise(() =>
        workPreflightFromFleetctl("recovery-context", cliConfigPath, unlinked.goal.id, "ALPHA")
      )
      expect(context.code, context.stderr).toBe(0)
      expect(JSON.parse(context.stdout)).toEqual({
        goalId: unlinked.goal.id,
        expectedGoalEventId: unlinked.eventId,
        expectedGoalUpdatedAt: unlinked.goal.updatedAt
      })
      const nonlocalContext = yield* Effect.promise(() =>
        workPreflightFromFleetctl("recovery-context", cliConfigPath, unlinked.goal.id)
      )
      expect(nonlocalContext.code).not.toBe(0)
      expect(nonlocalContext.stderr).toContain("local host")
      const admission = yield* Effect.promise(() =>
        workPreflightFromFleetctl("admission-preflight", cliConfigPath, JSON.stringify(admissionTarget), "ALPHA")
      )
      expect(admission.code, admission.stderr).toBe(0)
      expect(JSON.parse(admission.stdout)).toMatchObject({ _tag: "prospective", target: admissionTarget })
      const recovery = yield* Effect.promise(() =>
        workPreflightFromFleetctl("recovery-preflight", cliConfigPath, JSON.stringify(recoveryTarget), "ALPHA")
      )
      expect(recovery.code, recovery.stderr).toBe(0)
      expect(JSON.parse(recovery.stdout)).toMatchObject({ _tag: "recoverable", target: recoveryTarget })
      const nonlocal = yield* Effect.promise(() =>
        workPreflightFromFleetctl("recovery-preflight", cliConfigPath, JSON.stringify(recoveryTarget))
      )
      expect(nonlocal.code).not.toBe(0)
      expect(nonlocal.stderr).toContain("local host")
      expect(yield* work.snapshots()).toEqual(before)
    }).pipe(Effect.scoped, provideNodeServices)
  }, 15_000)

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
      } satisfies WorkCheckpointTestPayload
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
      } satisfies WorkCheckpointTestPayload
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

      if (server.workUrl === null) {
        return yield* Effect.die("Work listener missing")
      }
      const workUrl = server.workUrl
      for (const route of ["/v1/modules/connect/needs-you", "/v1/modules/unknown/read", "/v1/modules"]) {
        const response = yield* Effect.promise(() => fetch(`${workUrl}${route}`))
        expect(response.status).toBe(404)
      }
      const workListenerUrl = new URL(workUrl)
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
            `${workUrl}/v1/work`,
            `attacker.example:${workListenerUrl.port}`
          )
        )
      ).toBe(403)

      const recorded = yield* Effect.promise(() =>
        fetch(`${workUrl}/v1/work/checkpoints`, {
          body: JSON.stringify(workCheckpoint),
          headers: { "content-type": "application/json" },
          method: "POST"
        })
      )
      expect(recorded.status).toBe(201)
      expect(Schema.decodeUnknownSync(WorkGoalCheckpoint)(yield* Effect.promise(() => recorded.json()))).toEqual(
        workCheckpoint
      )

      const replay = yield* Effect.promise(() =>
        fetch(`${workUrl}/v1/work/checkpoints`, {
          body: JSON.stringify(workCheckpoint),
          headers: { "content-type": "application/json" },
          method: "POST"
        })
      )
      expect(replay.status).toBe(201)
      expect(Schema.decodeUnknownSync(WorkGoalCheckpoint)(yield* Effect.promise(() => replay.json()))).toEqual(
        workCheckpoint
      )

      const conflict = yield* Effect.promise(() =>
        fetch(`${workUrl}/v1/work/checkpoints`, {
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

      const snapshot = yield* Effect.promise(() => fetch(`${workUrl}/v1/work`))
      expect(snapshot.status).toBe(200)
      expect(Schema.decodeUnknownSync(WorkSnapshots)(yield* Effect.promise(() => snapshot.json())).now.goals).toEqual([
        workCheckpoint.goal
      ])

      const browserWrite = yield* Effect.promise(() =>
        fetch(`${workUrl}/v1/work/checkpoints`, {
          body: JSON.stringify(workCheckpoint),
          headers: { "content-type": "application/json", origin: workUrl },
          method: "POST"
        })
      )
      expect(browserWrite.status).toBe(403)

      const genericJob = yield* Effect.promise(() =>
        fetch(`${workUrl}/v1/jobs`, {
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

  it("passes the scroll-state opt-in through the hub only when the client sent it", () => {
    const decode = Schema.decodeUnknownSync(TerminalSelection)
    const base = { host: "SER9", agentId: "agent-1", cols: 100, rows: 30 }
    const browser = new URL("wss://hub.example.test/v1/connect/session?host=SER9&agent=agent-1&cols=100&rows=30")
    // An older client never asked, so the remote host must stay silent toward it.
    const legacy = decode(terminalSelectionInput(browser))
    expect(legacy).toEqual(base)
    expect(remoteTerminalUrl("wss://ser9.example.test/v1/connect/terminal", legacy).searchParams.has("scrollState"))
      .toBe(false)
    browser.searchParams.set("scrollState", "1")
    const current = decode(terminalSelectionInput(browser))
    expect(current).toEqual({ ...base, scrollState: true })
    const remote = remoteTerminalUrl("wss://ser9.example.test/v1/connect/terminal", current)
    expect(remote.searchParams.get("scrollState")).toBe("1")
    expect(decode(terminalSelectionInput(remote))).toEqual(current)
  })

  /** Takeover survives the hub hop only as a validated explicit opt-in, never as a default. */
  it("passes explicit takeover intent to the remote host and rejects malformed intent", () => {
    const decode = Schema.decodeUnknownSync(TerminalSelection)
    const browser = new URL("wss://hub.example.test/v1/connect/session?host=SER9&agent=agent-1&cols=100&rows=30")
    const ordinary = decode(terminalSelectionInput(browser))
    expect(remoteTerminalUrl("ws://ser9.example.test/v1/connect/terminal", ordinary).searchParams.has("takeover"))
      .toBe(false)
    browser.searchParams.set("takeover", "1")
    const explicit = decode(terminalSelectionInput(browser))
    expect(explicit).toEqual({ host: "SER9", agentId: "agent-1", cols: 100, rows: 30, takeover: true })
    const remote = remoteTerminalUrl("ws://ser9.example.test/v1/connect/terminal", explicit)
    expect(remote.searchParams.get("takeover")).toBe("1")
    expect(decode(terminalSelectionInput(remote))).toEqual(explicit)
    for (const invalid of ["", "0", "false", "true", "yes"]) {
      browser.searchParams.set("takeover", invalid)
      expect(Result.isFailure(Schema.decodeUnknownResult(TerminalSelection)(terminalSelectionInput(browser))))
        .toBe(true)
    }
  })

  it("relays scroll states only to a client that opted in, whatever produced them", () => {
    const relayed: Array<string> = []
    const base = { host: "SER9", agentId: "agent-1", cols: 100, rows: 30 }
    relayScrollState(base, "legacy", (payload) => relayed.push(payload))
    relayScrollState({ ...base, scrollState: false }, "declined", (payload) => relayed.push(payload))
    relayScrollState({ ...base, scrollState: true }, "opted in", (payload) => relayed.push(payload))
    expect(relayed).toEqual(["opted in"])
  })

  it("tells a remote host's scroll states from its frames and other signals", () => {
    const text = (value: string) => Buffer.from(value)
    expect(
      isRelayedScrollState(
        text(JSON.stringify({ type: "terminal.scroll_state", offsetFromBottom: 3, scrollsForwarded: 0 })),
        false
      )
    )
      .toBe(true)
    // The same bytes as a binary frame, other signals, and junk keep the close-on-backpressure rule.
    expect(
      isRelayedScrollState(
        text(JSON.stringify({ type: "terminal.scroll_state", offsetFromBottom: 3, scrollsForwarded: 0 })),
        true
      )
    )
      .toBe(false)
    expect(isRelayedScrollState(text(JSON.stringify({ type: "terminal.ready" })), false)).toBe(false)
    expect(isRelayedScrollState(text("not json"), false)).toBe(false)
    expect(
      isRelayedScrollState([
        text("{\"type\":\"terminal.scroll_state\","),
        text("\"offsetFromBottom\":null,\"scrollsForwarded\":2}")
      ], false)
    )
      .toBe(true)
  })

  it("holds the newest scroll state under backpressure and sends it once the socket drains", () => {
    vi.useFakeTimers()
    try {
      let buffered = terminalBufferLimitBytes
      const sent: Array<string> = []
      const signals = makeLatestSignalSender({
        bufferedAmount: () => buffered,
        isOpen: () => true,
        send: (payload) => sent.push(payload)
      }, 100)
      signals.offer("offset 7")
      signals.offer("offset 0")
      vi.advanceTimersByTime(1_000)
      expect(sent).toEqual([])
      buffered = 0
      vi.advanceTimersByTime(100)
      expect(sent).toEqual(["offset 0"])
      signals.offer("offset 3")
      expect(sent).toEqual(["offset 0", "offset 3"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops retrying a held scroll state once the socket closes", () => {
    vi.useFakeTimers()
    try {
      let buffered = terminalBufferLimitBytes
      const sent: Array<string> = []
      const signals = makeLatestSignalSender({
        bufferedAmount: () => buffered,
        isOpen: () => true,
        send: (payload) => sent.push(payload)
      }, 100)
      signals.offer("offset 7")
      signals.dispose()
      buffered = 0
      vi.advanceTimersByTime(1_000)
      expect(sent).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it.effect("pages pending approvals below the peer response limit", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-pending-page-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
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
          yield* Effect.forEach(
            Array.from({
              length: pendingApprovalPageMaxRecords + 2
            }, (_, index): JobRecord => ({
              actor: "owner@example.com",
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
          if (server.tailnetUrl === null) {
            return yield* Effect.die("tailnet listener missing")
          }

          const ids: Array<string> = []
          let cursor: (typeof PendingApprovalSummary.Type)["nextCursor"] = null
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
  whois) printf '%s\n' '{"Node":{"StableID":"node-alpha"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
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
  whois) printf '%s\n' '{"Node":{"StableID":"node-alpha"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
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
              const mainConfigFor = (peerPort: number, approvalPort: number): HostConfiguration => ({
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
              })
              const mainFleet = yield* makeFleetService({
                approvalEnabled: true,
                host: "ALPHA",
                operations,
                store: mainStore
              })
              // The hub reaches the peer on its own ports, so it binds the ports the peer got on 127.0.0.2
              // again on 127.0.0.1, where nothing reserved them: an outgoing connection from a parallel suite
              // can already hold one. Only that collision restarts the pair, on fresh peer ports.
              const { approvalPort, mainServer } = yield* Effect.acquireRelease(
                Effect.tryPromise({
                  try: async (): Promise<PairStart> => {
                    const peerServer = await startHttpServer(peerConfig, peerFleet, assets, {
                      terminalConnector: unusedTerminal
                    })
                    // A peer listener that did not start throws here; close the peer before rethrowing.
                    const { approvalPort, peerPort } = await Promise.resolve()
                      .then(() => ({
                        approvalPort: boundPort(peerServer.approvalUrl),
                        peerPort: boundPort(peerServer.tailnetUrl)
                      }))
                      .catch(async (cause: unknown) => {
                        await peerServer.close()
                        throw cause
                      })
                    try {
                      const mainServer = await startHttpServer(
                        mainConfigFor(peerPort, approvalPort),
                        mainFleet,
                        assets,
                        { terminalConnector: unusedTerminal }
                      )
                      return { _tag: "Started", approvalPort, mainServer, peerServer }
                    } catch (cause) {
                      await peerServer.close()
                      if (isAddressInUse(cause) && (cause.port === peerPort || cause.port === approvalPort)) {
                        return { _tag: "PortTaken", cause }
                      }
                      throw cause
                    }
                  },
                  catch: (cause) => new ApprovalStartFailed({ cause })
                }).pipe(
                  Effect.flatMap((started) =>
                    started._tag === "PortTaken"
                      ? Effect.fail(new ApprovalPortTaken({ cause: started.cause }))
                      : Effect.succeed(started)
                  ),
                  Effect.retry({ times: 4, while: (error) => error._tag === "ApprovalPortTaken" })
                ),
                ({ mainServer, peerServer }) =>
                  Effect.promise(async () => {
                    await mainServer.close()
                    await peerServer.close()
                  })
              )
              if (mainServer.serveUrl === null) {
                return yield* Effect.die("canonical listener missing")
              }
              const requestHeaders = {
                host: `alpha.example.test:${approvalPort}`,
                "tailscale-user-login": "owner@example.com"
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
                for (const { approval } of page.remote) {
                  remoteIds.push(approval.id)
                }
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
  whois) printf '%s\n' '{"Node":{"StableID":"node-alpha"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
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
                    actor: "owner@example.com",
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
            yield* Effect.acquireRelease(
              Effect.sync(() => peerServer),
              (server) => Effect.promise(() => closePeer(server))
            )
            const hostConfigFor = (approvalPort: number, pendingPort: number): HostConfiguration => ({
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
            })
            const fleet = yield* makeFleetService({
              approvalEnabled: true,
              host: "ALPHA",
              operations,
              store
            })
            const { approvalPort, server } = yield* Effect.acquireRelease(
              startWithPeerPort(peerServer, "127.0.0.2", (pendingPort) =>
                startWithApprovalPort(async (approvalPort) => ({
                  approvalPort,
                  server: await startHttpServer(hostConfigFor(approvalPort, pendingPort), fleet, assets, {
                    terminalConnector: unusedTerminal
                  })
                }))),
              (running) => Effect.promise(running.server.close)
            )
            if (server.serveUrl === null) {
              return yield* new FleetValidationError({
                detail: "legacy peer disclosure test requires the approval hub listener"
              })
            }
            const requestHeaders = {
              host: `alpha.example.test:${approvalPort}`,
              "tailscale-user-login": "owner@example.com"
            }
            const dashboardResponse = yield* Effect.promise(() =>
              secureRequestBody(`${server.serveUrl}/v1/dashboard`, requestHeaders)
            )
            expect(dashboardResponse.status).toBe(200)
            expect(dashboardResponse.body).not.toContain("peer-secret-canary")
            expect(dashboardResponse.body).toContain("/srv/npm")
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
            expect(continuationResponse.body).toContain("/srv/npm")
            const targetResponse = yield* Effect.promise(() =>
              secureRequestBody(
                `${server.serveUrl}/v1/pending-approval?host=SER8&jobId=legacy-peer-job`,
                requestHeaders
              )
            )
            expect(targetResponse.status).toBe(200)
            expect(targetResponse.body).not.toContain("peer-secret-canary")
            expect(targetResponse.body).toContain("/srv/npm")
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
              actor: "owner@example.com",
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
          let cursor: (typeof JobHistoryPage.Type)["nextCursor"] = null
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
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
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
          { login: "owner@example.com", remoteAddress: "127.0.0.1" },
          ["owner@example.com"],
          false
        )
      )
      expect(Result.isFailure(forged)).toBe(true)
      const socketless = yield* Effect.result(
        authorize(
          { login: "owner@example.com", remoteAddress: undefined },
          ["owner@example.com"],
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
  whois) printf '%s\n' '{"Node":{"StableID":"node-phone"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
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
          yield* store.put(pendingRecord("SER8", 0))
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
          // Recording never fails for size; the snapshot below bounds itself instead.
          expect(acceptedWorkCheckpoints).toBe(11)
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
                    actor: "owner@example.com",
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
          expect(dashboardResponse.setCookie).toContain("Secure")
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
          const workNow = Schema.decodeUnknownSync(WorkSnapshots)(JSON.parse(workResponse.body)).now
          expect(workNow.goalsOmitted).toBeGreaterThan(0)
          expect(workNow.goals.length + (workNow.goalsOmitted ?? 0)).toBe(acceptedWorkCheckpoints)
          const missingLink = yield* Effect.promise(() =>
            secureRequestBody(
              `${server.serveUrl}/v1/work/pull-request-link?repository=knpkv%2Fnpm&pullRequest=433&goalId=missing-goal&laneId=missing-lane`,
              requestHeaders
            )
          )
          expect(missingLink.status).toBe(409)
          expect(JSON.parse(missingLink.body)).toEqual({
            error: "WorkPullRequestLinkError",
            reason: "missing_provenance"
          })
          const afterInspection = yield* Effect.promise(() =>
            secureRequestBody(`${server.serveUrl}/v1/work`, requestHeaders)
          )
          expect(
            Schema.decodeUnknownSync(WorkSnapshots)(JSON.parse(afterInspection.body)).now.goals
          ).toEqual(Schema.decodeUnknownSync(WorkSnapshots)(JSON.parse(workResponse.body)).now.goals)
          const chatResponse = yield* Effect.promise(() =>
            secureRequestBody(`${server.serveUrl}/v1/chat`, requestHeaders)
          )
          // The coordinator chat is gone from the hub: its route no longer exists.
          expect(chatResponse.status).toBe(404)
          const agentIds: Array<string> = []
          let agentCursor: (typeof FleetConnectAgentPage.Type)["nextCursor"] = null
          do {
            const path = agentCursor === null
              ? "/v1/connect/agents"
              : `/v1/connect/agents?cursorHost=${encodeURIComponent(agentCursor.host)}&cursorId=${
                encodeURIComponent(
                  agentCursor.id
                )
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

  // A script on a fleet host runs under the owner's tailnet login. It can read the dashboard for a proof
  // and set any Origin header, so only the node keeps it from approving: the hub checks approval nodes
  // exactly as a peer's approval listener does.
  it.effect("approves on the hub only from an approval node, even for an allowed login holding a proof", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-serve-approval-node-"))
    const caller = join(root, "caller-node")
    writeFileSync(caller, "node-alpha")
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '{"Node":{"StableID":"%s"},"UserProfile":{"LoginName":"owner@example.com"}}\n' "$(cat '${caller}')" ;;
  status) printf '%s\n' '{"Peer":{},"Self":{"HostName":"SER8","ID":"node-ser8","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    const hostConfig: HostConfiguration = {
      ...config(root),
      approvalHub: { host: "SER8", nodeId: "node-ser8", url: "https://ser8.example.test:0/" },
      approvalNodes: ["node-phone"],
      approvalPort: 0,
      approvalTls: directTls,
      applyMachines: ["SER8"],
      crossHost: true,
      host: "SER8",
      port: 0,
      tailscaleCommand
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const fleet = yield* makeFleetService({ approvalEnabled: true, host: hostConfig.host, operations, store })
          yield* store.put(pendingRecord("SER8", 0))
          yield* store.put(pendingRecord("SER8", 1))
          const server = yield* Effect.acquireRelease(
            Effect.promise(() => startHttpServer(hostConfig, fleet, assets, { terminalConnector: unusedTerminal })),
            (running) => Effect.promise(running.close)
          )
          const serveUrl = yield* Schema.decodeUnknownEffect(Schema.String)(server.serveUrl)
          const scripted = { host: "ser8.example.test:0", origin: "https://ser8.example.test:0" }
          const approveAs = (node: string, jobId: string) =>
            Effect.promise(async () => {
              writeFileSync(caller, node)
              const dashboard = await secureRequestBody(`${serveUrl}/v1/dashboard`, scripted)
              const cookie = dashboard.setCookie?.split(";", 1).join("") ?? ""
              return secureRequestBody(`${serveUrl}/v1/jobs/${jobId}/approve`, { ...scripted, cookie }, {
                method: "POST"
              })
            })

          const fromFleetHost = yield* approveAs("node-alpha", "ser8-job-00")
          expect(fromFleetHost.status, fromFleetHost.body).toBe(403)
          expect((yield* store.get("ser8-job-00"))?.status).toBe("pending_approval")

          const fromPhone = yield* approveAs("node-phone", "ser8-job-01")
          expect(fromPhone.status, fromPhone.body).toBe(200)
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

          const relative = yield* Effect.promise(() =>
            fetch(`${server.url}/v1/jobs`, {
              body: JSON.stringify({
                payload: { kind: "agent.delegate", mode: "work", prompt: "ship", repository: "nix" }
              }),
              headers: { "content-type": "application/json" },
              method: "POST"
            })
          )
          expect(relative.status).toBe(400)
          expect(yield* Effect.promise(() => relative.json())).toEqual({
            error: "FleetRepositoryNotAbsoluteError",
            repository: "nix"
          })
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
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
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
          const approvalUrl = server.approvalUrl
          const path = `/v1/jobs/${pending.id}/approve`
          const body = new URLSearchParams({
            hash: pending.hash,
            nonce: pending.approvalNonce ?? ""
          })
          const hostile = yield* Effect.promise(() =>
            fetch(`${approvalUrl}${path}`, {
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
            fetch(`${approvalUrl}${path}`, {
              body: new URLSearchParams({
                hash: pending.hash,
                nonce: pending.approvalNonce ?? ""
              }),
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                origin: new URL(approvalUrl).origin
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
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
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
          const approvalUrl = server.approvalUrl
          const segment = encodeURIComponent(pending.id)
          const fetched = yield* Effect.promise(() => fetch(`${server.url}/v1/jobs/${segment}`))
          expect(fetched.status).toBe(200)
          expect(
            Schema.decodeUnknownSync(JobRecord)(yield* Effect.promise(() => fetched.json())).id
          ).toBe(pending.id)

          const decided = yield* Effect.promise(() =>
            fetch(`${approvalUrl}/v1/jobs/${segment}/approve`, {
              body: new URLSearchParams({
                hash: pending.hash,
                nonce: pending.approvalNonce ?? ""
              }),
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                origin: new URL(approvalUrl).origin
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
      // This test probes the local port before hostd binds it, so it needs the
      // number up front; every other test lets hostd bind port 0.
      const localPort = yield* Effect.promise(reserveLoopbackPort)
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
      const hostConfig = { ...config(root), localPort: 0 }
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
                // The blocker takes an ephemeral port first, so hostd's local listener cannot bind it.
                const blocker = createServer()
                const blockedPort = yield* Effect.promise(() => listenOn(blocker, "127.0.0.1"))
                yield* Effect.addFinalizer(() =>
                  Effect.promise(
                    () => new Promise<void>((resolve) => blocker.close(() => resolve()))
                  )
                )
                const failed = yield* Effect.result(
                  Effect.tryPromise(() =>
                    startHttpServer({ ...hostConfig, localPort: blockedPort }, fleet, assets, {
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
            expect(boundPort(server.url)).toBeGreaterThan(0)
            expect(runs).toBe(1)
          }).pipe(Effect.scoped),
        (store) => Effect.sync(() => store.close())
      )
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("derives job approval from the authenticated listener, never from request content", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-local-policy-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-alpha"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
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
          const tailnetUrl = server.tailnetUrl
          if (tailnetUrl === null) return yield* Effect.die("tailnet listener missing")
          const submit = (url: string, headers: Record<string, string>, extra: Record<string, string> = {}) =>
            Effect.promise(async () => {
              const response = await fetch(`${url}/v1/jobs`, {
                body: JSON.stringify({ payload: { kind: "nix.apply", ref: "abc123" }, ...extra }),
                headers: { "content-type": "application/json", ...headers },
                method: "POST"
              })
              return { body: await response.json(), status: response.status }
            })
          expect(yield* submit(server.url, {})).toMatchObject({
            body: { approvalNonce: null, approvedBy: null, status: "queued" },
            status: 202
          })
          expect(yield* submit(tailnetUrl, { "x-forwarded-for": "127.0.0.1" })).toMatchObject({
            body: { status: "pending_approval" },
            status: 202
          })
          expect(yield* submit(server.url, { forwarded: "for=192.0.2.1" })).toMatchObject({
            body: { status: "pending_approval" },
            status: 202
          })
          expect(yield* submit(server.url, { "x-forwarded-for": "192.0.2.1" })).toMatchObject({
            body: { status: "pending_approval" },
            status: 202
          })
          expect((yield* submit(server.url, { "tailscale-user-login": "local" })).status).toBe(403)
          expect(yield* submit(tailnetUrl, {}, { provenance: "verified_local_listener" })).toMatchObject({
            body: { error: "FleetValidationError" },
            status: 400
          })
        }).pipe(Effect.scoped),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
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

  it.effect("keeps a ponging terminal exclusive and releases a silent controller after the heartbeat", () =>
    Effect.gen(function*() {
      const server = yield* controllerServer({
        open: () => Effect.succeed({ events: Stream.never, send: () => Effect.void })
      })
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()))
      const alive = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => alive.ready)).toBe("ready")
      const ping = new Promise<void>((resolve) => alive.socket.once("ping", () => resolve()))
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(25_000))
      yield* Effect.promise(() => ping)
      // Echoing a message synchronizes after the automatic pong reached the server.
      const echo = new Promise<void>((resolve) => alive.socket.once("pong", () => resolve()))
      alive.socket.ping()
      yield* Effect.promise(() => echo)
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(25_000))
      const duplicate = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => duplicate.ready)).toBe(4_423)
      alive.socket.terminate()
      yield* Effect.promise(() => alive.closed)
      const silent = yield* controllerClient(server.url, false)
      expect(yield* Effect.promise(() => silent.ready)).toBe("ready")
      const silentPing = new Promise<void>((resolve) => silent.socket.once("ping", () => resolve()))
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(25_000))
      yield* Effect.promise(() => silentPing)
      expect(silent.socket.readyState).toBe(WebSocketClient.OPEN)
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(25_000))
      expect(yield* Effect.promise(() => silent.closed)).toBe(1_006)
      const replacement = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => replacement.ready)).toBe("ready")
    }).pipe(Effect.scoped, provideNodeServices))

  /** Client close can finish before scope cleanup; ordinary reconnect waits without taking over a live socket. */
  it.effect("ordinary reconnect waits for a closing controller's bounded release", () =>
    Effect.gen(function*() {
      const releaseStarted = yield* Deferred.make<void>()
      const allowRelease = yield* Deferred.make<void>()
      let opens = 0
      const server = yield* controllerServer({
        open: () => {
          opens += 1
          return opens === 1 ?
            Effect.acquireRelease(
              Effect.succeed({ events: Stream.never, send: () => Effect.void }),
              () => Deferred.succeed(releaseStarted, undefined).pipe(Effect.andThen(Deferred.await(allowRelease)))
            ) :
            Effect.succeed({ events: Stream.never, send: () => Effect.void })
        }
      })
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(allowRelease, undefined).pipe(
          Effect.andThen(Effect.sync(() => vi.useRealTimers()))
        )
      )
      const first = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => first.ready)).toBe("ready")
      first.socket.close()
      yield* Effect.promise(() => first.closed)
      yield* Deferred.await(releaseStarted)
      const incoming = yield* controllerClient(server.url)
      yield* Effect.promise(() => new Promise<void>((resolve) => incoming.socket.once("open", resolve)))
      let settled = false
      void incoming.ready.then(() => {
        settled = true
      })
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(9_999))
      expect(settled).toBe(false)
      expect(incoming.socket.readyState).toBe(WebSocketClient.OPEN)
      expect(opens).toBe(1)
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1))
      expect(yield* Effect.promise(() => incoming.ready)).toBe("ready")
      expect(opens).toBe(2)
      const duplicate = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => duplicate.ready)).toBe(4_423)
    }).pipe(Effect.scoped, provideNodeServices))

  it.effect("an aborted ordinary reconnect waiter releases its reservation without opening a session", () =>
    Effect.gen(function*() {
      const releaseStarted = yield* Deferred.make<void>()
      const allowRelease = yield* Deferred.make<void>()
      let opens = 0
      const server = yield* controllerServer({
        open: () => {
          opens += 1
          return opens === 1 ?
            Effect.acquireRelease(
              Effect.succeed({ events: Stream.never, send: () => Effect.void }),
              () => Deferred.succeed(releaseStarted, undefined).pipe(Effect.andThen(Deferred.await(allowRelease)))
            ) :
            Effect.succeed({ events: Stream.never, send: () => Effect.void })
        }
      })
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(allowRelease, undefined).pipe(
          Effect.andThen(Effect.sync(() => vi.useRealTimers()))
        )
      )
      const first = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => first.ready)).toBe("ready")
      first.socket.close()
      yield* Effect.promise(() => first.closed)
      yield* Deferred.await(releaseStarted)
      const incoming = yield* controllerClient(server.url)
      yield* Effect.promise(() => new Promise<void>((resolve) => incoming.socket.once("open", resolve)))
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(9_999))
      expect(incoming.socket.readyState).toBe(WebSocketClient.OPEN)
      expect(opens).toBe(1)
      incoming.socket.terminate()
      yield* Effect.promise(() => incoming.closed)
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1))
      expect(opens).toBe(1)
      const replacement = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => replacement.ready)).toBe("ready")
      expect(opens).toBe(2)
      const duplicate = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => duplicate.ready)).toBe(4_423)
    }).pipe(Effect.scoped, provideNodeServices))

  it.effect("a takeover supersedes an ordinary reconnect waiter without bypassing cleanup", () =>
    Effect.gen(function*() {
      const releaseStarted = yield* Deferred.make<void>()
      const allowRelease = yield* Deferred.make<void>()
      let opens = 0
      const server = yield* controllerServer({
        open: () => {
          opens += 1
          return opens === 1 ?
            Effect.acquireRelease(
              Effect.succeed({ events: Stream.never, send: () => Effect.void }),
              () => Deferred.succeed(releaseStarted, undefined).pipe(Effect.andThen(Deferred.await(allowRelease)))
            ) :
            Effect.succeed({ events: Stream.never, send: () => Effect.void })
        }
      })
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(allowRelease, undefined).pipe(
          Effect.andThen(Effect.sync(() => vi.useRealTimers()))
        )
      )
      const first = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => first.ready)).toBe("ready")
      first.socket.close()
      yield* Effect.promise(() => first.closed)
      yield* Deferred.await(releaseStarted)
      const incoming = yield* controllerClient(server.url)
      yield* Effect.promise(() => new Promise<void>((resolve) => incoming.socket.once("open", resolve)))
      const url = new URL(server.url)
      url.searchParams.set("takeover", "1")
      const newest = yield* controllerClient(url)
      yield* Effect.promise(() => new Promise<void>((resolve) => newest.socket.once("open", resolve)))
      expect(yield* Effect.promise(() => incoming.ready)).toBe(4_424)
      let settled = false
      void newest.ready.then(() => {
        settled = true
      })
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(9_999))
      expect(settled).toBe(false)
      expect(opens).toBe(1)
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1))
      expect(yield* Effect.promise(() => newest.ready)).toBe("ready")
      expect(opens).toBe(2)
      yield* Deferred.succeed(allowRelease, undefined)
      const duplicate = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => duplicate.ready)).toBe(4_423)
    }).pipe(Effect.scoped, provideNodeServices))

  /** Explicit takeover closes and releases the prior controller before the replacement can send input. */
  it.effect("takes over an agent only on explicit intent and reports the typed close to the old device", () =>
    Effect.gen(function*() {
      const lifecycle: Array<string> = []
      let opens = 0
      const server = yield* controllerServer({
        open: () => {
          opens += 1
          const number = opens
          return Effect.acquireRelease(
            Effect.sync(() => {
              lifecycle.push(`open ${String(number)}`)
              return { events: Stream.never, send: () => Effect.void }
            }),
            () => Effect.sync(() => lifecycle.push(`release ${String(number)}`))
          )
        }
      })
      const first = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => first.ready)).toBe("ready")
      const ordinary = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => ordinary.ready)).toBe(4_423)
      const agent = Schema.decodeUnknownSync(ConnectAgent)({
        host: server.url.searchParams.get("host"),
        id: server.url.searchParams.get("agent"),
        name: "Worker",
        kind: "test",
        state: "working",
        work: "Checking changes",
        lastActivityAt: 0
      })
      expect(terminalConnectionAfterClose(agent, yield* Effect.promise(() => ordinary.closeEvent)))
        .toEqual({ _tag: "controlled", agent })
      expect(opens).toBe(1)
      const previousClose = new Promise<{ code: number; reason: string }>((resolve) =>
        first.socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))
      )
      const takeover = new URL(server.url)
      takeover.searchParams.set("takeover", "1")
      const replacement = yield* controllerClient(takeover)
      expect(yield* Effect.promise(() => replacement.ready)).toBe("ready")
      expect(yield* Effect.promise(() => previousClose)).toEqual({ code: 4_424, reason: "taken_over" })
      expect(terminalConnectionAfterClose(agent, yield* Effect.promise(() => first.closeEvent)))
        .toEqual({ _tag: "taken-over", agent })
      expect(lifecycle.slice(0, 3)).toEqual(["open 1", "release 1", "open 2"])
      const reconnect = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => reconnect.ready)).toBe(4_423)
      expect(opens).toBe(2)
    }).pipe(Effect.scoped, provideNodeServices))

  /** A host advertises takeover through the same authenticated hub-node boundary as terminal upgrades. */
  it.effect("advertises terminal takeover only to an authenticated originless hub request", () =>
    Effect.gen(function*() {
      const server = yield* controllerServer({
        open: () => Effect.succeed({ events: Stream.never, send: () => Effect.void })
      })
      const capabilities = new URL(server.url)
      capabilities.protocol = "http:"
      capabilities.pathname = "/v1/connect/terminal/capabilities"
      capabilities.search = ""
      const accepted = yield* Effect.promise(() => fetch(capabilities))
      expect(accepted.status).toBe(200)
      expect(yield* Effect.promise(() => accepted.json())).toEqual({ takeover: true })
      const browser = yield* Effect.promise(() => fetch(capabilities, { headers: { origin: capabilities.origin } }))
      expect(browser.status).toBe(403)
    }).pipe(Effect.scoped, provideNodeServices))

  /** Waiting for release is still an admitted connection, not a refusal or an early ready signal. */
  it.effect("keeps takeover pending until bounded cleanup reaches ten seconds", () =>
    Effect.gen(function*() {
      const releaseStarted = yield* Deferred.make<void>()
      const allowRelease = yield* Deferred.make<void>()
      let opens = 0
      const server = yield* controllerServer({
        open: () => {
          opens += 1
          return opens === 1 ?
            Effect.acquireRelease(
              Effect.succeed({ events: Stream.never, send: () => Effect.void }),
              () => Deferred.succeed(releaseStarted, undefined).pipe(Effect.andThen(Deferred.await(allowRelease)))
            ) :
            Effect.succeed({ events: Stream.never, send: () => Effect.void })
        }
      })
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(allowRelease, undefined).pipe(
          Effect.andThen(Effect.sync(() => vi.useRealTimers()))
        )
      )
      const first = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => first.ready)).toBe("ready")
      const url = new URL(server.url)
      url.searchParams.set("takeover", "1")
      const incoming = yield* controllerClient(url)
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
      expect(
        yield* Effect.promise(() =>
          Promise.race([
            runPromise(Deferred.await(releaseStarted)).then(() => "cleanup"),
            incoming.ready
          ])
        )
      ).toBe("cleanup")
      expect(yield* Effect.promise(() => first.closed)).toBe(4_424)
      let settled = false
      void incoming.ready.then(() => {
        settled = true
      })
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(9_999))
      expect(settled).toBe(false)
      expect(incoming.socket.readyState).toBe(WebSocketClient.OPEN)
      expect(opens).toBe(1)
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1))
      expect(yield* Effect.promise(() => incoming.ready)).toBe("ready")
      expect(opens).toBe(2)
    }).pipe(Effect.scoped, provideNodeServices))

  /** Three viewers share one release barrier; superseding a waiter cannot bypass the first cleanup. */
  it.effect("admits only the newest concurrent takeover and retains ownership after late cleanup", () =>
    Effect.gen(function*() {
      const releaseStarted = yield* Deferred.make<void>()
      const allowRelease = yield* Deferred.make<void>()
      const releaseFinished = yield* Deferred.make<void>()
      let opens = 0
      const server = yield* controllerServer({
        open: () => {
          opens += 1
          return opens === 1 ?
            Effect.acquireRelease(
              Effect.succeed({ events: Stream.never, send: () => Effect.void }),
              () =>
                Deferred.succeed(releaseStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(allowRelease)),
                  Effect.ensuring(Deferred.succeed(releaseFinished, undefined))
                )
            ) :
            Effect.succeed({ events: Stream.never, send: () => Effect.void })
        }
      })
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(allowRelease, undefined).pipe(
          Effect.andThen(Effect.sync(() => vi.useRealTimers()))
        )
      )
      const first = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => first.ready)).toBe("ready")
      const url = new URL(server.url)
      url.searchParams.set("takeover", "1")
      const middle = yield* controllerClient(url)
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
      expect(
        yield* Effect.promise(() =>
          Promise.race([
            runPromise(Deferred.await(releaseStarted)).then(() => "cleanup"),
            middle.ready
          ])
        )
      ).toBe("cleanup")
      const newest = yield* controllerClient(url)
      expect(yield* Effect.promise(() => middle.ready)).toBe(4_424)
      let settled = false
      void newest.ready.then(() => {
        settled = true
      })
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(9_999))
      expect(settled).toBe(false)
      expect(opens).toBe(1)
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1))
      expect(yield* Effect.promise(() => newest.ready)).toBe("ready")
      expect(opens).toBe(2)
      yield* Deferred.succeed(allowRelease, undefined)
      yield* Deferred.await(releaseFinished)
      const duplicate = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => duplicate.ready)).toBe(4_423)
      expect(opens).toBe(2)
    }).pipe(Effect.scoped, provideNodeServices))

  it.effect("replaces one controller at cap four without admitting a fifth agent", () =>
    Effect.gen(function*() {
      let opens = 0
      const server = yield* controllerServer({
        open: () =>
          Effect.sync(() => {
            opens += 1
            return { events: Stream.never, send: () => Effect.void }
          })
      })
      for (let index = 0; index < 4; index += 1) {
        const url = new URL(server.url)
        url.searchParams.set("agent", `agent-cap-${String(index)}`)
        const client = yield* controllerClient(url)
        expect(yield* Effect.promise(() => client.ready)).toBe("ready")
      }
      const url = new URL(server.url)
      url.searchParams.set("agent", "agent-cap-0")
      const ordinary = yield* controllerClient(url)
      expect(yield* Effect.promise(() => ordinary.ready)).toBe(4_423)
      const agent = Schema.decodeUnknownSync(ConnectAgent)({
        host: url.searchParams.get("host"),
        id: "agent-cap-0",
        name: "Worker",
        kind: "test",
        state: "working",
        work: "Checking changes",
        lastActivityAt: 0
      })
      expect(terminalConnectionAfterClose(agent, yield* Effect.promise(() => ordinary.closeEvent)))
        .toEqual({ _tag: "controlled", agent })
      url.searchParams.set("takeover", "1")
      const replacement = yield* controllerClient(url)
      expect(yield* Effect.promise(() => replacement.ready)).toBe("ready")
      const fifth = new URL(server.url)
      const refused = yield* controllerClient(fifth)
      expect(yield* Effect.promise(() => refused.ready)).toBe(4_429)
      expect(opens).toBe(5)
    }).pipe(Effect.scoped, provideNodeServices))

  it.effect("an aborted takeover waiter releases its reservation without opening a session", () =>
    Effect.gen(function*() {
      const releaseStarted = yield* Deferred.make<void>()
      const allowRelease = yield* Deferred.make<void>()
      let opens = 0
      const server = yield* controllerServer({
        open: () => {
          opens += 1
          return opens === 1 ?
            Effect.acquireRelease(
              Effect.succeed({ events: Stream.never, send: () => Effect.void }),
              () => Deferred.succeed(releaseStarted, undefined).pipe(Effect.andThen(Deferred.await(allowRelease)))
            ) :
            Effect.succeed({ events: Stream.never, send: () => Effect.void })
        }
      })
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(allowRelease, undefined).pipe(
          Effect.andThen(Effect.sync(() => vi.useRealTimers()))
        )
      )
      const first = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => first.ready)).toBe("ready")
      const url = new URL(server.url)
      url.searchParams.set("takeover", "1")
      const incoming = yield* controllerClient(url)
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
      expect(
        yield* Effect.promise(() =>
          Promise.race([
            runPromise(Deferred.await(releaseStarted)).then(() => "cleanup"),
            incoming.ready
          ])
        )
      ).toBe("cleanup")
      incoming.socket.terminate()
      yield* Effect.promise(() => incoming.closed)
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(10_000))
      expect(opens).toBe(1)
      const replacement = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => replacement.ready)).toBe("ready")
      expect(opens).toBe(2)
    }).pipe(Effect.scoped, provideNodeServices))

  it.effect.each(["false", "invalid"] satisfies ReadonlyArray<"false" | "invalid">)(
    "retries the complete terminal relay pair when capability is %s and its shared port is occupied",
    (capability) =>
      Effect.gen(function*() {
        const attempted: Array<number> = []
        let blockedPort: number | undefined
        const peer = yield* terminalRelayFixture(capability, (port) =>
          Effect.gen(function*() {
            attempted.push(port)
            if (blockedPort !== undefined) return
            const blocker = yield* Effect.acquireRelease(
              Effect.sync(() => createServer()),
              (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
            )
            yield* Effect.tryPromise({
              try: () =>
                new Promise<void>((resolve, reject) => {
                  blocker.once("error", reject)
                  blocker.listen(port, "127.0.0.1", resolve)
                }),
              catch: (cause) => new ApprovalStartFailed({ cause })
            })
            blockedPort = port
          }))
        const client = yield* controllerClient(peer.url, true, {
          rejectUnauthorized: false,
          headers: { origin: peer.origin }
        })
        expect(yield* Effect.promise(() => client.ready)).toBe(4_423)
        expect(blockedPort).toBeDefined()
        expect(attempted.length).toBeGreaterThanOrEqual(2)
        expect(attempted.length).toBeLessThanOrEqual(5)
        expect(attempted.at(-1)).not.toBe(blockedPort)
        expect(peer.probes).toEqual(["/v1/connect/terminal/capabilities"])
        expect(peer.upgrades).toEqual([])
      }).pipe(Effect.scoped, provideNodeServices)
  )

  it.effect.each(
    ["missing", "false", "invalid", "redirect"] satisfies ReadonlyArray<
      "missing" | "false" | "invalid" | "redirect"
    >
  )("refuses takeover before a remote upgrade when capability is %s", (capability) =>
    Effect.gen(function*() {
      const peer = yield* terminalRelayFixture(capability)
      const client = yield* controllerClient(peer.url, true, {
        rejectUnauthorized: false,
        headers: { origin: peer.origin }
      })
      expect(yield* Effect.promise(() => client.ready)).toBe(4_423)
      expect(peer.upgrades).toEqual([])
      expect(peer.probes).toEqual(["/v1/connect/terminal/capabilities"])
    }).pipe(Effect.scoped, provideNodeServices))

  it.effect("keeps capability transport failure unavailable without an ordinary remote attach", () =>
    Effect.gen(function*() {
      const peer = yield* terminalRelayFixture("transport")
      const client = yield* controllerClient(peer.url, true, {
        rejectUnauthorized: false,
        headers: { origin: peer.origin }
      })
      expect(yield* Effect.promise(() => client.ready)).toBe(4_503)
      expect(peer.upgrades).toEqual([])
    }).pipe(Effect.scoped, provideNodeServices))

  // A terminal session is a WebSocket upgrade, outside the request handler: shadow mode still sees it once
  // today's checks accept it. The fixture's WhoIs answers the hub's own node, a fleet host.
  it.effect("shadows an accepted terminal session from a fleet-host node as a refused host terminal", () =>
    Effect.gen(function*() {
      const logged = vi.spyOn(Logger.defaultLogger, "log")
      yield* Effect.addFinalizer(() => Effect.sync(() => logged.mockRestore()))
      const peer = yield* terminalRelayFixture("supported")
      const client = yield* controllerClient(peer.url, true, {
        rejectUnauthorized: false,
        headers: { origin: peer.origin }
      })
      expect(yield* Effect.promise(() => client.ready)).toBe("ready")
      const shadowLines = () =>
        logged.mock.calls.flatMap(([entry]) =>
          [entry.message].flat().filter(Schema.is(Schema.String.check(Schema.isPattern(/^identity shadow:/u))))
        )
      for (
        let attempt = 0;
        attempt < 100 && !shadowLines().includes("identity shadow: refused serve Host connect.terminal");
        attempt++
      ) {
        yield* Effect.sleep("20 millis")
      }
      expect(shadowLines()).toContain("identity shadow: refused serve Host connect.terminal")
    }).pipe(Effect.scoped, provideNodeServices))

  it.effect("probes takeover freshly and relays intent and the typed close through a capable host", () =>
    Effect.gen(function*() {
      const peer = yield* terminalRelayFixture("supported")
      const client = yield* controllerClient(peer.url, true, {
        rejectUnauthorized: false,
        headers: { origin: peer.origin }
      })
      let reason = ""
      client.socket.once("close", (_code, text) => {
        reason = text.toString()
      })
      const ready = yield* Effect.promise(() => client.ready)
      expect(ready, JSON.stringify({ probes: peer.probes, upgrades: peer.upgrades, reason }))
        .toBe("ready")
      expect(peer.probes).toEqual(["/v1/connect/terminal/capabilities"])
      expect(peer.upgrades).toHaveLength(1)
      expect(new URL(peer.upgrades[0] ?? "", "http://peer").searchParams.get("takeover")).toBe("1")
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        client.socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))
      )
      for (const socket of peer.sockets) socket.close(4_424, "taken_over")
      expect(yield* Effect.promise(() => closed)).toEqual({ code: 4_424, reason: "taken_over" })
      const ordinary = new URL(peer.url)
      ordinary.searchParams.delete("takeover")
      const reconnect = yield* controllerClient(ordinary, true, {
        rejectUnauthorized: false,
        headers: { origin: peer.origin }
      })
      expect(yield* Effect.promise(() => reconnect.ready)).toBe("ready")
      expect(peer.probes).toHaveLength(1)
      const fresh = yield* controllerClient(peer.url, true, {
        rejectUnauthorized: false,
        headers: { origin: peer.origin }
      })
      expect(yield* Effect.promise(() => fresh.ready)).toBe("ready")
      expect(peer.probes).toHaveLength(2)
    }).pipe(Effect.scoped, provideNodeServices))

  it.effect("does not exhaust the four-controller cap after five disconnected held releases", () =>
    Effect.gen(function*() {
      const allowRelease = yield* Deferred.make<void>()
      const releaseStarted = yield* Queue.unbounded<string>()
      const connector: TerminalConnector = {
        open: (selection) =>
          Effect.acquireRelease(
            Effect.succeed({ events: Stream.never, send: () => Effect.void }),
            () => Queue.offer(releaseStarted, selection.agentId).pipe(Effect.andThen(Deferred.await(allowRelease)))
          )
      }
      const server = yield* controllerServer(connector)
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(allowRelease, undefined).pipe(
          Effect.andThen(Effect.sync(() => vi.useRealTimers()))
        )
      )
      for (let index = 0; index < 5; index += 1) {
        const url = new URL(server.url)
        const agentId = `agent-controller-${index}`
        url.searchParams.set("agent", agentId)
        const client = yield* controllerClient(url)
        expect(yield* Effect.promise(() => client.ready)).toBe("ready")
        client.socket.terminate()
        yield* Effect.promise(() => client.closed)
        expect(yield* Queue.take(releaseStarted)).toBe(agentId)
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(10_000))
      }
      const replacement = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => replacement.ready)).toBe("ready")
    }).pipe(Effect.scoped, provideNodeServices))

  it.effect("a late release cannot clear the replacement controller's reservation", () =>
    Effect.gen(function*() {
      const releaseStarted = yield* Deferred.make<void>()
      const releaseFinished = yield* Deferred.make<void>()
      const allowRelease = yield* Deferred.make<void>()
      let opens = 0
      const connector: TerminalConnector = {
        open: () => {
          opens += 1
          return opens === 1
            ? Effect.acquireRelease(
              Effect.succeed({ events: Stream.never, send: () => Effect.void }),
              () =>
                Deferred.succeed(releaseStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(allowRelease)),
                  Effect.ensuring(Deferred.succeed(releaseFinished, undefined))
                )
            )
            : Effect.succeed({ events: Stream.never, send: () => Effect.void })
        }
      }
      const server = yield* controllerServer(connector)
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(allowRelease, undefined).pipe(
          Effect.andThen(Effect.sync(() => vi.useRealTimers()))
        )
      )
      const first = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => first.ready)).toBe("ready")
      first.socket.terminate()
      yield* Effect.promise(() => first.closed)
      yield* Deferred.await(releaseStarted)
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(10_000))
      const replacement = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => replacement.ready)).toBe("ready")
      yield* Deferred.succeed(allowRelease, undefined)
      yield* Deferred.await(releaseFinished)
      const duplicate = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => duplicate.ready)).toBe(4_423)
      expect(opens).toBe(2)
    }).pipe(Effect.scoped, provideNodeServices))

  it.effect("releases a failed terminal setup even when its peer never answers the close handshake", () =>
    Effect.gen(function*() {
      let opens = 0
      const connector: TerminalConnector = {
        open: () => {
          opens += 1
          if (opens === 1) {
            throw new FleetOperationError({
              cause: undefined,
              detail: "controller fixture failed",
              operation: "controller.fixture"
            })
          }
          return Effect.succeed({ events: Stream.never, send: () => Effect.void })
        }
      }
      const server = yield* controllerServer(connector)
      const broken = yield* controllerClient(server.url)
      yield* Effect.promise(() =>
        new Promise<void>((resolve) =>
          broken.socket.once("open", () => {
            broken.socket.pause()
            resolve()
          })
        )
      )
      const replacement = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => replacement.ready)).toBe("ready")
    }).pipe(Effect.scoped, provideNodeServices))

  it.effect("hub shutdown interrupts a cooperative controller finalizer without leaking its slot", () =>
    Effect.gen(function*() {
      const releaseStarted = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const connector: TerminalConnector = {
        open: () =>
          Effect.acquireRelease(
            Effect.succeed({ events: Stream.never, send: () => Effect.void }),
            () =>
              Effect.interruptible(
                Deferred.succeed(releaseStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
                )
              )
          )
      }
      const server = yield* controllerServer(connector)
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()))
      const client = yield* controllerClient(server.url)
      expect(yield* Effect.promise(() => client.ready)).toBe("ready")
      const closing = server.close()
      yield* Deferred.await(releaseStarted)
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(10_000))
      yield* Effect.promise(() => closing)
      expect(yield* Deferred.isDone(interrupted)).toBe(true)
    }).pipe(Effect.scoped, provideNodeServices))

  it.effect("releases a disconnected terminal open and closes a clean exit", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-terminal-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
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
      const shutdownReleaseFinished = yield* Deferred.make<void>()
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
              ? Stream.make({ type: "terminal.scroll_state", offsetFromBottom: 42, scrollsForwarded: 0 }, {
                bytes: Buffer.alloc((terminalFrameMaxEncodedBytes / 4) * 3).toString("base64"),
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
                  Effect.andThen(Deferred.await(allowShutdownRelease)),
                  Effect.ensuring(Deferred.succeed(shutdownReleaseFinished, undefined))
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
            if (server.tailnetUrl === null) {
              return yield* Effect.die("tailnet listener missing")
            }
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
            const signals: Array<string> = []
            // This client opted in to scroll states; a legacy one would get none.
            const optedIn = new URL(url)
            optedIn.searchParams.set("scrollState", "1")
            const maximumFrameClose = yield* Effect.promise(
              () =>
                new Promise<number>((resolve, reject) => {
                  const socket = new WebSocketClient(optedIn)
                  socket.once("error", reject)
                  socket.on("message", (data, isBinary) => {
                    if (isBinary) {
                      maximumFrameBytes = Array.isArray(data)
                        ? Buffer.concat(data).byteLength
                        : Buffer.byteLength(data)
                    } else signals.push(data.toString())
                  })
                  socket.once("close", (code) => resolve(code))
                })
            )
            expect(maximumFrameClose).toBe(1_000)
            expect(maximumFrameBytes).toBe((terminalFrameMaxEncodedBytes / 4) * 3)
            // The scroll position is relayed as a signal and does not end the session.
            expect(signals).toContain(
              JSON.stringify({ type: "terminal.scroll_state", offsetFromBottom: 42, scrollsForwarded: 0 })
            )

            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
            const warnings = vi.spyOn(Logger.defaultLogger, "log")
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(allowControllerRelease, undefined).pipe(
                Effect.andThen(Deferred.succeed(allowShutdownRelease, undefined)),
                Effect.andThen(Effect.sync(() => {
                  vi.useRealTimers()
                  warnings.mockRestore()
                }))
              )
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
            yield* Effect.promise(() => vi.advanceTimersByTimeAsync(9_999))
            // The reservation still holds, but a reconnect waits instead of reporting a live controller.
            const waiting = yield* controllerClient(new URL(url))
            yield* Effect.promise(() => new Promise<void>((resolve) => waiting.socket.once("open", resolve)))
            let waitingSettled = false
            void waiting.ready.then(() => {
              waitingSettled = true
            })
            expect(waiting.socket.readyState).toBe(WebSocketClient.OPEN)
            expect(waitingSettled).toBe(false)
            expect(opens).toBe(5)
            yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1))
            expect(yield* Effect.promise(() => waiting.ready)).toBe("ready")
            const timeoutWarnings = warnings.mock.calls.map(([entry]) => entry.message).filter((message) =>
              JSON.stringify(message).includes("TerminalReleaseTimeout")
            )
            expect(timeoutWarnings).toEqual([[{
              _tag: "TerminalReleaseTimeout",
              host: hostConfig.host,
              agentId: "agent-1",
              elapsed: 10_000
            }]])
            vi.useRealTimers()
            warnings.mockRestore()
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
            yield* Deferred.await(shutdownReleaseFinished)
            expect(yield* Deferred.isDone(closeFinished)).toBe(false)
            yield* Deferred.succeed(allowControllerRelease, undefined)
            yield* Deferred.await(controllerReleaseFinished)
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
    printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"owner@example.com"}}'
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
          if (server.tailnetUrl === null) {
            return yield* Effect.die("tailnet listener missing")
          }
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
  it.effect("refuses browser upgrades on the tailnet terminal", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-http-terminal-origin-test-"))
    const tailscaleCommand = join(root, "tailscale-test")
    writeFileSync(
      tailscaleCommand,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\n' '127.0.0.1' ;;
  whois) printf '%s\n' '{"Node":{"StableID":"node-ser8"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
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
          if (server.tailnetUrl === null) {
            return yield* Effect.die("tailnet listener missing")
          }
          const url = new URL("/v1/connect/terminal", server.tailnetUrl)
          url.protocol = "ws:"
          url.searchParams.set("agent", "agent-1")
          url.searchParams.set("cols", "100")
          url.searchParams.set("host", hostConfig.host)
          url.searchParams.set("rows", "30")
          const upgrade = (headers: Record<string, string>) =>
            Effect.acquireRelease(
              Effect.sync(() => new WebSocketClient(url, { headers })),
              (client) => Effect.sync(() => client.terminate())
            ).pipe(
              Effect.flatMap((socket) =>
                Effect.promise(() =>
                  new Promise<string>((resolve) => {
                    socket.once("open", () => resolve("open"))
                    socket.once("unexpected-response", (_request, response) => {
                      response.resume()
                      resolve(`status:${response.statusCode}`)
                    })
                    socket.once("error", (error) => resolve(`error:${String(error)}`))
                  })
                )
              )
            )
          expect(yield* upgrade({ origin: server.tailnetUrl })).toBe("status:403")
          expect(yield* upgrade({ origin: "https://elsewhere.example.test" })).toBe("status:403")
          expect(yield* upgrade({ "sec-fetch-site": "cross-site" })).toBe("status:403")
          expect(opens).toBe(0)
          // The hub's own relay sends neither header.
          expect(yield* upgrade({})).toBe("open")
        })),
      (store) => Effect.sync(() => store.close())
    ).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
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

describe("Relay in the hub", () => {
  /** A Claude Code backend over a scripted model that answers every turn with `reply`. */
  const scriptedBackends = (reply: string, onStart: Effect.Effect<void> = Effect.void): RelayHubBackends => () =>
    Effect.gen(function*() {
      yield* onStart
      const backend: RelayBackend = {
        id: "claude-code",
        name: "Claude Code",
        model: makeDeterministicLanguageModel(() => ({
          _tag: "response",
          parts: [{ type: "text", text: JSON.stringify({ reply, toolCalls: [] }) }]
        })).layer,
        probe: Effect.succeed("2.1.0 (Claude Code)"),
        signInFix: "Run claude and sign in with /login."
      }
      const backends: readonly [RelayBackend] = [backend]
      return backends
    })

  /** One request to the hub's TLS listener, with its whole body. */
  const hubRequest = (
    url: string,
    options: { readonly method?: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string }
  ): Promise<{ readonly status: number; readonly body: string; readonly cookies: ReadonlyArray<string> }> =>
    new Promise((resolve, reject) => {
      const request = httpsRequest(
        url,
        { headers: options.headers, method: options.method ?? "GET", rejectUnauthorized: false },
        (response) => {
          let body = ""
          response.setEncoding("utf8")
          response.on("data", (chunk: string) => {
            body += chunk
          })
          response.once(
            "end",
            () => resolve({ body, status: response.statusCode ?? 0, cookies: response.headers["set-cookie"] ?? [] })
          )
        }
      )
      request.once("error", reject)
      request.end(options.body)
    })

  /** Reads `data:` frames from the hub's event stream until `done` says stop, then leaves. */
  const readFrames = (
    url: string,
    headers: Readonly<Record<string, string>>,
    done: (frames: ReadonlyArray<{ readonly _tag: string }>) => boolean,
    onOpen: () => void = () => undefined
  ): Promise<ReadonlyArray<{ readonly _tag: string }>> =>
    new Promise((resolve, reject) => {
      const frames: Array<{ readonly _tag: string }> = []
      const request = httpsRequest(url, { headers, rejectUnauthorized: false }, (response) => {
        let buffer = ""
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => {
          buffer += chunk
          const parts = buffer.split("\n\n")
          buffer = parts.pop() ?? ""
          for (const part of parts) {
            if (!part.startsWith("data: ")) continue
            frames.push(Schema.decodeUnknownSync(Schema.Struct({ _tag: Schema.String }))(JSON.parse(part.slice(6))))
            if (frames.length === 1) onOpen()
          }
          if (done(frames)) {
            request.destroy()
            resolve(frames)
          }
        })
      })
      request.once("error", (error) => (frames.length > 0 && done(frames) ? resolve(frames) : reject(error)))
      request.end()
    })

  /** A hub whose canonical listener serves Relay from `relayDirectory`, signed in as `identity`. */
  const startHub = (
    root: string,
    relayDirectory: string,
    backends: RelayHubBackends,
    seed: (store: JobStore) => Effect.Effect<void, unknown> = () => Effect.void,
    modules: ReadonlyArray<ServerModule> = [],
    overrides: Partial<HostConfiguration> = {},
    transformFleet: (fleet: FleetService) => FleetService = (fleet) => fleet
  ) =>
    Effect.gen(function*() {
      const identityMode = join(root, "identity-mode")
      const whoisNodeFile = join(root, "whois-node")
      const tailscaleCommand = join(root, "tailscale-test")
      const statusFile = join(root, "tailscale-status")
      writeFileSync(identityMode, "allowed")
      writeFileSync(whoisNodeFile, "node-phone")
      writeFileSync(
        statusFile,
        JSON.stringify({
          Peer: {},
          Self: {
            HostName: "SER8",
            ID: "node-ser8",
            Online: true,
            TailscaleIPs: ["127.0.0.1"]
          }
        })
      )
      writeFileSync(
        tailscaleCommand,
        `#!/bin/sh
case "$1" in
  ip) printf '%s\\n' '127.0.0.1' ;;
  whois)
    if [ "$(cat '${identityMode}')" = allowed ]; then
      printf '{"Node":{"StableID":"%s"},"UserProfile":{"LoginName":"owner@example.com"}}\\n' "$(cat '${whoisNodeFile}')"
    else
      printf '{"Node":{"StableID":"%s"},"UserProfile":{"LoginName":"mallory@example.com"}}\\n' "$(cat '${whoisNodeFile}')"
    fi ;;
  status) cat '${statusFile}' ;;
esac
`,
        { mode: 0o700 }
      )
      const store = yield* Effect.acquireRelease(
        JobStore.open(join(root, "jobs.sqlite")),
        (opened) => Effect.sync(() => opened.close())
      )
      yield* Effect.orDie(seed(store))
      const fleet = transformFleet(yield* makeFleetService({ approvalEnabled: true, host: "SER8", operations, store }))
      const { approvalPort, server } = yield* Effect.acquireRelease(
        startWithApprovalPort(async (approvalPort) => {
          const hubConfig: HostConfiguration = {
            ...config(root),
            approvalHub: { host: "SER8", nodeId: "node-ser8", url: `https://127.0.0.1:${approvalPort}/` },
            // The fixture's caller is the phone, the one node that decides approvals.
            approvalNodes: ["node-phone"],
            approvalPort,
            approvalTls: directTls,
            applyMachines: ["SER8"],
            crossHost: true,
            host: "SER8",
            machines: [{ host: "SER8", nodeId: "node-ser8" }],
            port: 0,
            tailscaleCommand,
            ...overrides
          }
          const server = await startHttpServer(hubConfig, fleet, assets, {
            modules,
            relay: { directory: relayDirectory, backends },
            terminalConnector: unusedTerminal
          })
          return { approvalPort, server }
        }),
        (running) => Effect.promise(running.server.close)
      )
      if (server.serveUrl === null) return yield* Effect.die("serve URL missing")
      const origin = `https://127.0.0.1:${approvalPort}`
      return {
        server,
        serveUrl: server.serveUrl,
        headers: { host: `127.0.0.1:${approvalPort}` },
        origin,
        statusFile,
        deny: () => writeFileSync(identityMode, "denied"),
        allow: () => writeFileSync(identityMode, "allowed"),
        /** The tailnet node WhoIs reports for every caller; the hub itself is `node-ser8`. */
        whoisNode: (stableId: string) => writeFileSync(whoisNodeFile, stableId)
      }
    })

  /** Seed once, then retry only the peer and hub listeners on their shared port. */
  const startPeerAvailabilityHub = Effect.fn("HttpTest.startPeerAvailabilityHub")(function*(
    root: string,
    peer: ReturnType<typeof createServer>,
    beforeHubStart: (port: number) => Effect.Effect<void, ApprovalStartFailed, Scope.Scope> = () => Effect.void
  ) {
    yield* Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) => store.put(pendingRecord("SER8", 0)),
      (store) => Effect.sync(() => store.close())
    ).pipe(Effect.mapError((cause) => new ApprovalStartFailed({ cause })))
    return yield* startWithPeerPort(peer, "127.0.0.2", (port) =>
      beforeHubStart(port).pipe(
        Effect.andThen(startHub(
          root,
          join(root, "relay"),
          scriptedBackends("Nothing waits."),
          () => Effect.void,
          [],
          {
            port,
            machines: [
              { host: "SER8", nodeId: "node-ser8" },
              { host: "ser8", nodeId: "node-ser8" },
              { host: "ALPHA", nodeId: "node-alpha" },
              { host: "alpha", nodeId: "node-alpha" }
            ]
          }
        )),
        Effect.mapError((cause) =>
          cause._tag === "ApprovalPortTaken" || cause._tag === "ApprovalStartFailed"
            ? cause
            : new ApprovalStartFailed({ cause })
        )
      ))
  })

  describe("shared peer port startup", () => {
    it.effect("recovers the seeded peer-availability hub after a shared-port collision", () =>
      Effect.gen(function*() {
        const root = mkdtempSync(join(tmpdir(), "herdr-seeded-peer-retry-"))
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
        const peer = yield* Effect.acquireRelease(
          Effect.sync(() => createServer((_request, response) => response.end("{}"))),
          (server) => Effect.promise(() => closePeer(server))
        )
        const occupied = yield* Effect.acquireRelease(
          Effect.sync(() => createServer()),
          (server) => Effect.promise(() => closePeer(server))
        )
        const ports: Array<number> = []
        const hub = yield* startPeerAvailabilityHub(root, peer, (port) =>
          Effect.gen(function*() {
            ports.push(port)
            if (ports.length !== 1) return
            yield* Effect.tryPromise({
              try: () =>
                new Promise<void>((resolve, reject) => {
                  occupied.once("error", reject)
                  occupied.listen(port, "127.0.0.1", resolve)
                }),
              catch: (cause) => new ApprovalStartFailed({ cause })
            })
          }))
        expect(ports.length).toBeGreaterThanOrEqual(2)
        expect(ports.length).toBeLessThanOrEqual(5)
        expect(boundPort(hub.server.tailnetUrl)).not.toBe(ports[0])
        const dashboard = yield* Effect.promise(() =>
          hubRequest(`${hub.serveUrl}/v1/dashboard`, { headers: hub.headers })
        )
        expect(dashboard.status).toBe(200)
        const snapshot = Schema.decodeUnknownSync(Schema.fromJsonString(DashboardSnapshot))(dashboard.body)
        expect(snapshot.pendingApprovals.local.map((job) => job.id)).toEqual(["ser8-job-00"])
      }).pipe(Effect.scoped, provideNodeServices))
  })

  const conversation = "product=herdr&kind=fleet&id=SER8"
  const hubRef = { product: "herdr", kind: "fleet", id: "SER8" }

  it.effect("reuses authorized Usage reports and caches without forwarding local-only fields", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-usage-module-"))
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const calls = join(root, "command-calls")
      const usage = {
        v: 1,
        machine: "SER8",
        observedAt: 1_000,
        range: { preset: "30d", timeZone: "Europe/Amsterdam", from: 0, to: 1_000, bucket: "day" },
        periods: [{ key: "2026-10-08", start: 0 }],
        tokens: [{ period: 0, agent: "claude", model: "claude-opus-5", tokens: 900 }],
        limits: []
      }
      const localOnly = {
        costUsd: 12,
        balances: [42],
        bookings: ["private-booking"],
        sessions: ["private-session"],
        path: "/private/store",
        promptPrefix: "private-prompt"
      }
      const rawUsage = { ...usage, ...localOnly, tokens: usage.tokens.map((cell) => ({ ...cell, ...localOnly })) }
      const limits = { v: 1, machine: "SER8", observedAt: 1_000, latest: [] }
      const script = `printf '%s\\n' "$*" >> '${calls}'; case "$1" in usage) printf '%s' '${
        JSON.stringify(rawUsage)
      }' ;; limits) printf '%s' '${JSON.stringify({ ...limits, ...localOnly })}' ;; *) exit 2 ;; esac`
      const hub = yield* startHub(
        root,
        join(root, "relay"),
        scriptedBackends("No report actions."),
        () => Effect.void,
        [],
        {
          agentUsageLimitsCommand: ["sh", "-c", script, "agent-usage", "limits"]
        }
      )
      const get = (path: string) => Effect.promise(() => hubRequest(`${hub.serveUrl}${path}`, { headers: hub.headers }))
      hub.deny()
      const dashboard = yield* get("/v1/dashboard")
      for (const path of ["/v1/connect/usage?range=30d&timeZone=Europe%2FAmsterdam", "/v1/connect/limits"]) {
        expect((yield* get(path)).status).toBe(dashboard.status)
      }
      expect(dashboard.status).toBe(403)
      expect(existsSync(calls)).toBe(false)
      hub.allow()
      const report = yield* get("/v1/connect/usage?range=30d&timeZone=Europe%2FAmsterdam")
      const currentLimits = yield* get("/v1/connect/limits")
      expect(report.status).toBe(200)
      expect(currentLimits.status).toBe(200)
      expect(report.cookies).toEqual([])
      expect(currentLimits.cookies).toEqual([])
      const body = Schema.decodeUnknownSync(FleetUsage)(JSON.parse(report.body))
      expect(body.hosts[0]?.reading).toEqual({ _tag: "Read", usage, skipped: 0 })
      expect(Schema.decodeUnknownSync(FleetLimits)(JSON.parse(currentLimits.body)).hosts[0]?.reading).toEqual({
        _tag: "Read",
        limits,
        skipped: 0
      })
      for (const field of Object.keys(localOnly)) {
        expect(report.body).not.toContain(`"${field}"`)
        expect(currentLimits.body).not.toContain(`"${field}"`)
      }
      yield* get("/v1/connect/usage?range=30d&timeZone=Europe%2FAmsterdam")
      yield* get("/v1/connect/limits")
      expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
        "usage --range 30d --time-zone Europe/Amsterdam",
        "limits"
      ])
      expect((yield* get("/v1/modules/usage/report")).status).toBe(404)
    }).pipe(Effect.scoped, provideNodeServices)
  })

  it.effect("serves one bounded Today list without approval proofs or job payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-today-list-"))
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const hub = yield* startHub(
        root,
        join(root, "relay"),
        scriptedBackends("Nothing waits."),
        (store) =>
          Effect.forEach(
            Array.from({ length: 12 }, (_, index) => pendingRecord("SER8", index)),
            (record) => store.put(record),
            { discard: true }
          )
      )
      const response = yield* Effect.promise(() =>
        hubRequest(`${hub.serveUrl}/v1/modules/connect/needs-you`, {
          headers: hub.headers
        })
      )
      const retired = yield* Effect.promise(() =>
        hubRequest(`${hub.serveUrl}/v1/modules/today/needs-you`, { headers: hub.headers })
      )
      expect(retired.status).toBe(404)
      expect(response.status, response.body).toBe(200)
      expect(response.cookies).toEqual([])
      const body = Schema.decodeUnknownSync(Schema.TaggedStruct("Complete", {
        items: Schema.Array(
          Schema.Struct({ key: Schema.String, destination: Schema.Struct({ host: Schema.String }) })
        )
      }))(JSON.parse(response.body))
      expect(body.items).toHaveLength(12)
      expect(body.items[0]).toMatchObject({ key: "fleet:ser8:ser8-job-00", destination: { host: "SER8" } })
      for (const field of ["payload", "hash", "nonce", "approvalUrl", "repository", "href"]) {
        expect(response.body).not.toContain(`"${field}"`)
      }
      const dashboard = yield* Effect.promise(() =>
        hubRequest(`${hub.serveUrl}/v1/dashboard`, { headers: hub.headers })
      )
      const snapshot = Schema.decodeUnknownSync(DashboardSnapshot)(JSON.parse(dashboard.body))
      expect(snapshot.pendingApprovals.local.some((job) => job.id === "ser8-job-00")).toBe(false)
      const cookie = dashboard.cookies[0]?.split(";", 1).join("")
      if (cookie === undefined) return yield* Effect.die("Dashboard must issue its proof cookie")
      const existingSession = yield* Effect.promise(() =>
        hubRequest(`${hub.serveUrl}/v1/modules/connect/needs-you`, {
          headers: { ...hub.headers, cookie }
        })
      )
      expect(existingSession.cookies).toEqual([])
      const undisclosed = yield* Effect.promise(() =>
        hubRequest(`${hub.serveUrl}/v1/jobs/ser8-job-00/approve`, {
          method: "POST",
          headers: { ...hub.headers, cookie, origin: hub.origin }
        })
      )
      expect(undisclosed.status).toBe(409)
    }).pipe(Effect.scoped, provideNodeServices)
  })

  /** The production mount uses whois authority, never a browser-supplied login header or query. */
  it.effect("keeps Code local, read-only and caller identity sourced from authenticated whois", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-code-auth-"))
    const callers: Array<string> = []
    const descriptor = defineModule({
      id: "caller-fixture",
      label: "Fixture",
      defaultPage: "overview",
      pages: [{ id: "overview", label: "Fixture" }],
      listeners: ["serve"],
      requires: ["read"]
    })
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const hub = yield* startHub(root, join(root, "relay"), scriptedBackends("Nothing waits."), () => Effect.void, [{
        descriptor,
        handlers: Layer.succeed(ModuleHandlers, {
          routes: [
            moduleReadRoute(
              "/caller",
              Schema.fromURLSearchParams(Schema.Struct({ login: Schema.optionalKey(Schema.String) })),
              Schema.String,
              (_query, caller) =>
                Effect.sync(() => {
                  callers.push(caller.login)
                  return caller.login
                })
            ),
            moduleReadRoute(
              "/same-node",
              Schema.fromURLSearchParams(Schema.Struct({})),
              Schema.Boolean,
              (_query, caller) => Effect.succeed(caller.sameNode)
            )
          ]
        })
      }])
      const get = (path: string) =>
        Effect.promise(() =>
          hubRequest(`${hub.serveUrl}${path}`, {
            headers: { ...hub.headers, "tailscale-user-login": "spoof@example.test" }
          })
        )
      hub.deny()
      expect((yield* get("/v1/modules/code/queue")).status).toBe((yield* get("/v1/dashboard")).status)
      expect((yield* get("/v1/modules/caller-fixture/caller?login=spoof@example.test")).status).toBe(403)
      expect(callers).toEqual([])
      hub.allow()
      const identity = yield* get("/v1/modules/caller-fixture/caller?login=spoof@example.test")
      expect(identity.status).toBe(200)
      expect(JSON.parse(identity.body)).toBe("owner@example.com")
      expect(callers).toEqual(["owner@example.com"])
      const missing = yield* get("/v1/modules/code/queue")
      expect(missing.status).toBe(200)
      expect(JSON.parse(missing.body)).toEqual({ _tag: "Unavailable", reason: "not_configured", host: null })
      expect((yield* get("/v1/modules/code/queue?profile=private")).status).toBe(400)
      expect((yield* get("/v1/modules/code/missing")).status).toBe(404)
      const write = yield* Effect.promise(() =>
        hubRequest(`${hub.serveUrl}/v1/modules/code/queue`, { method: "POST", headers: hub.headers })
      )
      expect(write.status).toBe(404)

      // "On the hub machine" is the WhoIs peer being the hub's own node, never a header the browser sends.
      const sameNode = (headers: Record<string, string> = {}) =>
        Effect.promise(() =>
          hubRequest(`${hub.serveUrl}/v1/modules/caller-fixture/same-node`, { headers: { ...hub.headers, ...headers } })
        ).pipe(Effect.map((response) => JSON.parse(response.body)))
      const spoofed = {
        "tailscale-user-login": "owner@example.com",
        "x-forwarded-for": "127.0.0.1",
        "x-real-ip": "127.0.0.1",
        forwarded: "for=127.0.0.1;host=ser8",
        "x-tailscale-node": "node-ser8"
      }
      expect(yield* sameNode()).toBe(false)
      expect(yield* sameNode(spoofed)).toBe(false)
      hub.whoisNode("node-ser8")
      expect(yield* sameNode()).toBe(true)
      hub.whoisNode("node-phone")
      // The loopback serves the super-app; the tailnet listener never serves modules.
      if (hub.server.tailnetUrl === null) return yield* Effect.die("Expected a tailnet listener URL")
      const remote = yield* Effect.promise(() => fetch(`${hub.server.tailnetUrl}/v1/modules/code/queue`))
      expect(remote.status).toBe(404)
      yield* Effect.promise(() => remote.text())
      const loopback = yield* Effect.promise(() => fetch(`${hub.server.url}/v1/modules/code/queue`))
      expect(loopback.status).toBe(200)
      yield* Effect.promise(() => loopback.text())
    }).pipe(Effect.scoped, provideNodeServices)
  })

  it.effect("uses dashboard authorization before Today providers and rejects extra query selectors", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-today-auth-"))
    let reads = 0
    const code = defineModule({
      id: "fixture",
      label: "Code",
      defaultPage: "overview",
      pages: [{ id: "overview", label: "Code" }],
      listeners: ["serve"],
      requires: ["read"]
    })
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const hub = yield* startHub(root, join(root, "relay"), scriptedBackends("Nothing waits."), () => Effect.void, [
        {
          descriptor: code,
          handlers: Layer.succeed(ModuleHandlers, {
            routes: [],
            needsYou: Effect.sync(() => {
              reads += 1
              return { items: [], issues: [], asOf: null }
            })
          })
        }
      ])
      const get = (path: string) => Effect.promise(() => hubRequest(`${hub.serveUrl}${path}`, { headers: hub.headers }))
      hub.deny()
      const dashboard = yield* get("/v1/dashboard")
      const denied = yield* get("/v1/modules/connect/needs-you")
      expect(denied.status).toBe(dashboard.status)
      expect(denied.status).toBe(403)
      expect(reads).toBe(0)
      hub.allow()
      const malformed = yield* get("/v1/modules/connect/needs-you?extra=yes")
      expect(malformed.status).toBe(400)
      expect(JSON.parse(malformed.body)).toEqual({ error: "invalid_query" })
      expect(reads).toBe(0)
      expect((yield* get("/v1/modules/connect/needs-you")).status).toBe(200)
      expect(reads).toBe(1)
      for (const path of ["/v1/modules", "/v1/modules/today/missing", "/v1/modules/unknown/needs-you"]) {
        expect((yield* get(path)).status).toBe(404)
      }
      if (hub.server.tailnetUrl === null) return yield* Effect.die("Expected a tailnet listener URL")
      const wrongListener = yield* Effect.promise(() => fetch(`${hub.server.tailnetUrl}/v1/modules/connect/needs-you`))
      expect(wrongListener.status).toBe(404)
      yield* Effect.promise(() => wrongListener.text())
      expect(reads).toBe(1)
    }).pipe(Effect.scoped, provideNodeServices)
  })

  it.effect("rereads peer availability and deduplicates case variants while preserving display case", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-today-peer-"))
    const peer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        host: "ALPHA",
        nextCursor: null,
        approvals: [{
          id: "alpha-job-00",
          actor: "operator",
          createdAt: 1,
          approvalExpiresAt: null,
          status: "pending_approval",
          payload: {
            kind: "agent.delegate",
            mode: "work",
            prompt: "peer private output text",
            repository: "/srv/fixture"
          }
        }]
      }))
    })
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      yield* Effect.acquireRelease(
        Effect.sync(() => peer),
        (server) => Effect.promise(() => closePeer(server))
      )
      const hub = yield* startPeerAvailabilityHub(root, peer)
      const setOnline = (online: boolean) =>
        writeFileSync(
          hub.statusFile,
          JSON.stringify({
            Self: { HostName: "SER8", ID: "node-ser8", Online: true, TailscaleIPs: ["127.0.0.1"] },
            Peer: { alpha: { HostName: "ALPHA", ID: "node-alpha", Online: online, TailscaleIPs: ["127.0.0.2"] } }
          })
        )
      const get = () =>
        Effect.promise(() => hubRequest(`${hub.serveUrl}/v1/modules/connect/needs-you`, { headers: hub.headers }))
      setOnline(true)
      const online = yield* get()
      expect(online.status).toBe(200)
      expect(JSON.parse(online.body)).toMatchObject({
        _tag: "Complete",
        items: [
          { key: "fleet:alpha:alpha-job-00", destination: { host: "ALPHA" } },
          { key: "fleet:ser8:ser8-job-00", destination: { host: "SER8" } }
        ]
      })
      expect(online.body).not.toContain("peer private output text")
      expect(online.body).not.toContain("/srv/fixture")
      setOnline(false)
      const offline = yield* get()
      expect(JSON.parse(offline.body)).toMatchObject({
        _tag: "Partial",
        items: [
          { key: "fleet:ser8:ser8-job-00" }
        ],
        sources: [{
          provider: "fleet",
          issue: {
            state: "hosts",
            hosts: [
              { host: "ALPHA", reason: "offline" },
              { host: "alpha", reason: "offline" }
            ]
          }
        }]
      })
    }).pipe(Effect.scoped, provideNodeServices)
  })

  it.effect("names a failed local host separately from failed peer discovery", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-today-source-failure-"))
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const hub = yield* startHub(
        root,
        join(root, "relay"),
        scriptedBackends("Nothing waits."),
        () => Effect.void,
        [],
        {},
        (fleet) => ({
          ...fleet,
          pendingApprovalPage: () =>
            Effect.fail(
              new FleetStoreBusyError({
                operation: "pending",
                detail: "fixture busy",
                cause: "fixture"
              })
            )
        })
      )
      const get = () =>
        Effect.promise(() => hubRequest(`${hub.serveUrl}/v1/modules/connect/needs-you`, { headers: hub.headers }))
      const localFailure = yield* get()
      expect(JSON.parse(localFailure.body)).toEqual({
        _tag: "Partial",
        items: [],
        sources: [
          { provider: "fleet", issue: { state: "hosts", hosts: [{ host: "SER8", reason: "request_failed" }] } }
        ],
        contributions: [
          { provider: "sandboxes", asOf: null },
          { provider: "fleet", asOf: null }
        ]
      })
      writeFileSync(hub.statusFile, "invalid status JSON")
      const discoveryFailure = yield* get()
      expect(JSON.parse(discoveryFailure.body)).toEqual({
        _tag: "Partial",
        items: [],
        sources: [
          { provider: "fleet", issue: { state: "failed", reason: "request_failed" } },
          { provider: "fleet", issue: { state: "hosts", hosts: [{ host: "SER8", reason: "request_failed" }] } }
        ],
        contributions: [
          { provider: "sandboxes", asOf: null },
          { provider: "fleet", asOf: null }
        ]
      })
      expect(discoveryFailure.body).not.toContain("fixture busy")
      expect(discoveryFailure.body).not.toContain("invalid status JSON")
    }).pipe(Effect.scoped, provideNodeServices)
  })

  it.effect("uses the production module mount's origin, content-type and body budget before writes", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-module-write-"))
    let writes = 0
    const code = defineModule({
      id: "fixture",
      label: "Code",
      defaultPage: "overview",
      pages: [{ id: "overview", label: "Code" }],
      listeners: ["serve"],
      requires: ["read", "write"]
    })
    const query = Schema.fromURLSearchParams(Schema.Record(Schema.String, Schema.Never))
    const modules = [{
      descriptor: code,
      handlers: Layer.succeed(ModuleHandlers, {
        routes: [
          moduleReadRoute("/status", query, Schema.Boolean, () => Effect.succeed(true)),
          moduleWriteRoute(
            "POST",
            "/decide",
            query,
            Schema.Struct({ decision: Schema.Literal("approve") }),
            Schema.Null,
            () =>
              Effect.sync(() => {
                writes += 1
                return null
              })
          )
        ]
      })
    }]
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const hub = yield* startHub(
        root,
        join(root, "relay"),
        scriptedBackends("Nothing waits."),
        () => Effect.void,
        modules
      )
      const post = (contentType: string, body: string, origin = hub.origin) =>
        Effect.promise(() =>
          hubRequest(`${hub.serveUrl}/v1/modules/fixture/decide`, {
            method: "POST",
            headers: { ...hub.headers, "content-type": contentType, origin },
            body
          })
        )
      const valid = JSON.stringify({ decision: "approve" })
      expect((yield* post("application/json", valid, "https://other.example.test")).status).toBe(403)
      expect((yield* post("text/plain", valid)).status).toBe(400)
      expect((yield* post("application/json", "{")).status).toBe(400)
      expect(
        (yield* post("application/json", JSON.stringify({ decision: "approve", padding: "x".repeat(1_024 * 1_024) })))
          .status
      ).toBe(400)
      expect(writes).toBe(0)
      expect((yield* post("application/json", valid)).status).toBe(200)
      expect(writes).toBe(1)
      const read = yield* Effect.promise(() =>
        hubRequest(`${hub.serveUrl}/v1/modules/fixture/status`, { headers: hub.headers })
      )
      expect(read.status).toBe(200)
      expect(JSON.parse(read.body)).toBe(true)
    }).pipe(Effect.scoped, provideNodeServices)
  })

  // A Relay decision lets a waiting tool call run, so it is an approval: a script on a fleet host holds the
  // owner's login and can set any Origin, and only an approval node may decide.
  it.effect("takes a Relay decision only from an approval node, even with the allowed login and its own Origin", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-relay-decide-"))
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const hub = yield* startHub(
        root,
        join(root, "relay"),
        scriptedBackends("Nothing waits."),
        () => Effect.void,
        [],
        { approvalNodes: ["node-phone"] }
      )
      const decide = (node: string) =>
        Effect.promise(() => {
          hub.whoisNode(node)
          return hubRequest(`${hub.serveUrl}/v1/relay/decisions`, {
            method: "POST",
            headers: { ...hub.headers, "content-type": "application/json", origin: hub.origin },
            body: JSON.stringify({ ref: hubRef, callId: "call-1", allow: true })
          })
        })
      const fromFleetHost = yield* decide("node-alpha")
      expect(fromFleetHost.status, fromFleetHost.body).toBe(403)
      // The phone is past the check; nothing waits for that call, so Relay answers it is not pending.
      const fromPhone = yield* decide("node-phone")
      expect(fromPhone.status, fromPhone.body).toBe(409)
      // Loopback is the hub's own agents: the local listener decides nothing.
      const local = new URL(hub.server.url).origin
      const fromLoopback = yield* Effect.promise(() =>
        fetch(`${local}/v1/relay/decisions`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: local },
          body: JSON.stringify({ ref: hubRef, callId: "call-1", allow: true })
        }).then(async (response) => ({ status: response.status, body: await response.text() }))
      )
      expect(fromLoopback.status, fromLoopback.body).toBe(403)
    }).pipe(Effect.scoped, provideNodeServices)
  })

  it.effect("refuses before Relay starts, and serves the hub's conversation only on its super-app listeners", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-relay-routes-"))
    const relayDirectory = join(root, "relay")
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const hub = yield* startHub(root, relayDirectory, scriptedBackends("Nothing waits."))
      const get = (path: string) => Effect.promise(() => hubRequest(`${hub.serveUrl}${path}`, { headers: hub.headers }))

      hub.deny()
      expect((yield* get(`/v1/relay/session?${conversation}`)).status).toBe(403)
      hub.allow()
      const otherHost = yield* get("/v1/relay/session?product=herdr&kind=fleet&id=ALPHA")
      expect(otherHost.status).toBe(400)
      expect(JSON.parse(otherHost.body)).toMatchObject({ _tag: "RelayBadRequestError" })
      const message = JSON.stringify({ ref: hubRef, text: "Hi", requestId: "r-1" })
      const crossOrigin = yield* Effect.promise(() =>
        hubRequest(`${hub.serveUrl}/v1/relay/messages`, {
          method: "POST",
          headers: { ...hub.headers, "content-type": "application/json", origin: "https://evil.example.test" },
          body: message
        })
      )
      expect(crossOrigin.status).toBe(403)
      // Nothing above was allowed to use Relay, so its store was never opened.
      expect(existsSync(relayDirectory)).toBe(false)

      const session = yield* get(`/v1/relay/session?${conversation}`)
      expect(session.status).toBe(200)
      expect(
        Schema.decodeUnknownSync(Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }))(
          JSON.parse(session.body)
        ).tools.map(({ name }) => name)
      ).toEqual(["list_agents", "list_pending_approvals", "get_job", "get_work_board"])
      expect(existsSync(join(relayDirectory, "sessions.sqlite"))).toBe(true)

      // The loopback serves the super-app and so this host's Relay; peer-facing listeners never do.
      for (const url of [hub.server.workUrl, hub.server.tailnetUrl, hub.server.approvalUrl]) {
        if (url === null || url === hub.serveUrl) continue
        const elsewhere = yield* Effect.promise(() =>
          url.startsWith("https:")
            ? hubRequest(`${url}/v1/relay/session?${conversation}`, { headers: hub.headers })
            : fetch(`${url}/v1/relay/session?${conversation}`).then(async (response) => ({
              status: response.status,
              body: await response.text()
            }))
        )
        expect(elsewhere.status, url).not.toBe(200)
      }
    }).pipe(Effect.scoped, provideNodeServices)
  })

  it.effect("answers a message on the event stream: the Snapshot, the person's message, then Relay's reply", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-relay-stream-"))
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const hub = yield* startHub(root, join(root, "relay"), scriptedBackends("Nothing waits for approval."))
      let accepted: Promise<{ readonly status: number; readonly body: string }> | undefined
      const frames = yield* Effect.promise(() =>
        readFrames(
          `${hub.serveUrl}/v1/relay/events?${conversation}`,
          hub.headers,
          (seen) => seen.some(({ _tag }) => _tag === "RunFinished"),
          () => {
            accepted = hubRequest(`${hub.serveUrl}/v1/relay/messages`, {
              method: "POST",
              headers: { ...hub.headers, "content-type": "application/json", origin: hub.origin },
              body: JSON.stringify({ ref: hubRef, text: "What waits?", requestId: "r-1" })
            })
          }
        )
      )
      const sent = accepted
      if (sent === undefined) return yield* Effect.die("the message was never sent")
      const answer = yield* Effect.promise(() => sent)
      expect(answer.status).toBe(202)
      expect(JSON.parse(answer.body)).toEqual({ runId: "r-1" })
      const tags = frames.map(({ _tag }) => _tag)
      expect(tags[0]).toBe("Snapshot")
      expect(tags.indexOf("MessagePlaced")).toBeGreaterThan(0)
      expect(tags.indexOf("MessagePlaced")).toBeLessThan(tags.indexOf("RunStarted"))
      expect(tags).toContain("TextDelta")
      expect(tags.at(-1)).toBe("RunFinished")
    }).pipe(Effect.scoped, provideNodeServices)
  })

  it.effect("reads every pending job past the first page into Relay's answer", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-relay-pending-"))
    const prompts: Array<string> = []
    // Calls list_pending_approvals once, then answers; every prompt is kept so the tool result can be read.
    const backends: RelayHubBackends = () =>
      Effect.sync(() => {
        const backend: RelayBackend = {
          id: "claude-code",
          name: "Claude Code",
          model: makeDeterministicLanguageModel((request) => {
            const prompt = JSON.stringify(request.prompt.content)
            prompts.push(prompt)
            const turn = /TOOL (RESULT|ERROR) \w+ \(/u.test(prompt)
              ? { reply: "Twelve wait.", toolCalls: [] }
              : { reply: "", toolCalls: [{ name: "list_pending_approvals", arguments: {} }] }
            return { _tag: "response", parts: [{ type: "text", text: JSON.stringify(turn) }] }
          }).layer,
          probe: Effect.succeed("2.1.0 (Claude Code)"),
          signInFix: "Run claude and sign in with /login."
        }
        const all: readonly [RelayBackend] = [backend]
        return all
      })
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const hub = yield* startHub(
        root,
        join(root, "relay"),
        backends,
        (store) =>
          Effect.forEach(
            Array.from({ length: 12 }, (_, index) => pendingRecord("SER8", index)),
            (record) => store.put(record)
          )
      )
      yield* Effect.promise(() =>
        readFrames(
          `${hub.serveUrl}/v1/relay/events?${conversation}`,
          hub.headers,
          (seen) => seen.some(({ _tag }) => _tag === "RunFinished"),
          () => {
            void hubRequest(`${hub.serveUrl}/v1/relay/messages`, {
              method: "POST",
              headers: { ...hub.headers, "content-type": "application/json", origin: hub.origin },
              body: JSON.stringify({ ref: hubRef, text: "What waits?", requestId: "r-1" })
            })
          }
        )
      )
      const result = prompts.find((prompt) => /TOOL RESULT list_pending_approvals \(/u.test(prompt)) ?? ""
      // A page holds eight; all twelve reach the model.
      for (let index = 0; index < 12; index += 1) {
        expect(result).toContain(`ser8-job-${String(index).padStart(2, "0")}`)
      }
    }).pipe(Effect.scoped, provideNodeServices)
  })

  /** Another process holding the store's exclusive lock, as a second hostd's Relay does, until `release`. */
  const holdStore = (directory: string) =>
    Effect.acquireRelease(
      Effect.promise(() =>
        new Promise<{ readonly release: () => Promise<void> }>((resolve, reject) => {
          mkdirSync(directory, { recursive: true, mode: 0o700 })
          const child = spawn(process.execPath, [
            "-e",
            `const { DatabaseSync } = require("node:sqlite")
const database = new DatabaseSync(${JSON.stringify(join(directory, "sessions.sqlite"))})
database.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; BEGIN IMMEDIATE; COMMIT")
process.stdout.write("locked\\n")
process.stdin.resume()
process.stdin.on("end", () => process.exit(0))`
          ], { stdio: ["pipe", "pipe", "inherit"] })
          const exited = new Promise<void>((done) => child.once("exit", () => done()))
          child.once("error", reject)
          child.stdout.once("data", () =>
            resolve({
              release: () => {
                child.stdin.end()
                return exited
              }
            }))
        })
      ),
      (holder) => Effect.promise(holder.release)
    )

  it.effect("says Relay is unavailable, with the fix, while another process holds its store, and starts once it is free", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-relay-locked-"))
    const relayDirectory = join(root, "relay")
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const holder = yield* holdStore(relayDirectory)
      const hub = yield* startHub(root, relayDirectory, scriptedBackends("Here."))
      const session = () =>
        Effect.promise(() => hubRequest(`${hub.serveUrl}/v1/relay/session?${conversation}`, { headers: hub.headers }))
      const locked = yield* session()
      expect(locked.status).toBe(503)
      expect(JSON.parse(locked.body)).toMatchObject({
        _tag: "RelayUnavailableError",
        fix: expect.stringContaining("Another hostd owns Relay's sessions")
      })
      // The rest of the hub keeps working.
      const manifest = yield* Effect.promise(() =>
        hubRequest(`${hub.serveUrl}/manifest.webmanifest`, { headers: hub.headers })
      )
      expect(manifest.status).toBe(200)
      // The other process stops: the next request starts Relay here, without a restart.
      yield* Effect.promise(holder.release)
      const freed = yield* session()
      expect(freed.status, freed.body).toBe(200)
    }).pipe(Effect.scoped, provideNodeServices)
  })
})

describe("Relay mount", () => {
  it.effect("starts once for concurrent and cancelled requests, and retries a start that failed", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-relay-mount-"))
    const directory = join(root, "relay")
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      // A file where the directory should be: the first start fails.
      writeFileSync(directory, "")
      let starts = 0
      const release = yield* Deferred.make<void>()
      const backends: RelayHubBackends = () =>
        Effect.gen(function*() {
          starts += 1
          yield* Deferred.await(release)
          const backend: RelayBackend = {
            id: "claude-code",
            name: "Claude Code",
            model: makeDeterministicLanguageModel([]).layer,
            probe: Effect.succeed("2.1.0 (Claude Code)"),
            signInFix: "Run claude and sign in with /login."
          }
          const all: readonly [RelayBackend] = [backend]
          return all
        })
      const mount = yield* makeRelayHubMount({ directory, instructions: "Test.", capabilities: () => [], backends })

      const failed = yield* Effect.flip(mount.harness)
      expect(failed.fix).toContain(directory)
      expect(starts).toBe(0)

      rmSync(directory)
      const cancelled = yield* Effect.forkChild(mount.harness)
      const waiting = yield* Effect.forkChild(mount.harness)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(cancelled)
      yield* Deferred.succeed(release, undefined)
      const harness = yield* Fiber.join(waiting)
      expect(yield* harness.backends).toHaveLength(1)
      expect(yield* mount.harness).toBe(harness)
      expect(starts).toBe(1)
    }).pipe(Effect.scoped, provideNodeServices)
  })
})

describe("busy loopback port", () => {
  // A taken port must stop startup at once and name the address, not hang or retry.
  it.effect("fails startup naming the loopback address when its port is taken", () =>
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "herdr-busy-port-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const holder = yield* Effect.acquireRelease(
        Effect.promise(() =>
          new Promise<ReturnType<typeof createServer>>((resolve) => {
            const server = createServer()
            server.listen(0, "127.0.0.1", () => resolve(server))
          })
        ),
        (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
      )
      const port = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(holder.address()).port
      const store = yield* Effect.acquireRelease(
        JobStore.open(join(root, "jobs.sqlite")),
        (opened) => Effect.sync(() => opened.close())
      )
      const fleet = yield* makeFleetService({ approvalEnabled: false, host: "ALPHA", operations, store })
      const failure = yield* Effect.tryPromise({
        try: () =>
          startHttpServer({ ...config(root), localPort: port }, fleet, assets, { terminalConnector: unusedTerminal }),
        // Keep Node's own listen error: its message is what the operator sees.
        catch: (cause) => String(cause)
      }).pipe(Effect.flip)
      expect(failure).toContain("EADDRINUSE")
      expect(failure).toContain(`127.0.0.1:${String(port)}`)
    }).pipe(Effect.scoped, provideNodeServices))
})

describe("local super-app", () => {
  /** A tailscale stand-in whose whois answers for `nodeId` and whose status lists only this host. */
  const tailscaleFixture = (root: string, host: string, nodeId: string): string => {
    const command = join(root, "tailscale-test")
    writeFileSync(
      command,
      `#!/bin/sh
case "$1" in
  ip) printf '%s\\n' '127.0.0.1' ;;
  whois) printf '%s\\n' '{"Node":{"StableID":"${nodeId}"},"UserProfile":{"LoginName":"owner@example.com"}}' ;;
  status) printf '%s\\n' '{"Peer":{},"Self":{"HostName":"${host}","ID":"${nodeId}","Online":true,"TailscaleIPs":["127.0.0.1"]}}' ;;
esac
`,
      { mode: 0o700 }
    )
    return command
  }

  const started = Effect.fn("LocalSuperappTest.started")(
    function*(
      prefix: string,
      hostConfig: (root: string) => HostConfiguration,
      apps?: (root: string) => NonNullable<NonNullable<Parameters<typeof startHttpServer>[3]>["apps"]>
    ) {
      const root = mkdtempSync(join(tmpdir(), prefix))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const resolved = hostConfig(root)
      const store = yield* Effect.acquireRelease(
        JobStore.open(join(root, "jobs.sqlite")),
        (opened) => Effect.sync(() => opened.close())
      )
      const fleet = yield* makeFleetService({ approvalEnabled: true, host: resolved.host, operations, store })
      return yield* Effect.acquireRelease(
        Effect.promise(() =>
          startHttpServer(
            resolved,
            fleet,
            assets,
            apps === undefined
              ? { terminalConnector: unusedTerminal }
              : { terminalConnector: unusedTerminal, apps: apps(root) }
          )
        ),
        (running) => Effect.promise(running.close)
      )
    }
  )

  const plainSnapshot = (base: string) =>
    Effect.promise(() => fetch(`${base}/v1/dashboard`).then((response) => response.json())).pipe(
      Effect.map(Schema.decodeUnknownSync(DashboardSnapshot))
    )

  const plainStatus = (url: string) => Effect.promise(() => fetch(url).then((response) => response.status))

  it.effect("serves the super-app on a standalone host's loopback and opens no tailnet listener", () =>
    Effect.gen(function*() {
      const server = yield* started("herdr-local-superapp-", (root) => config(root))
      expect(server.tailnetUrl).toBeNull()
      expect(server.approvalUrl).toBeNull()
      expect(server.serveUrl).toBeNull()
      const snapshot = yield* plainSnapshot(server.url)
      expect(snapshot.approvalApp).toEqual({
        canonical: false,
        canonicalUrl: "https://ser8.example.test:4779/",
        pushEnabled: false,
        superapp: true,
        fleet: false,
        workEnabled: true,
        sandboxesEnabled: false
      })
      // Modules answer on loopback; one that is not set up here says why instead of vanishing.
      const sandboxes = yield* Effect.promise(() =>
        fetch(`${server.url}/v1/modules/sandboxes/overview`).then(async (response) => ({
          status: response.status,
          body: Schema.decodeUnknownSync(Schema.Struct({ _tag: Schema.String, reason: Schema.String }))(
            await response.json()
          )
        }))
      )
      expect(sandboxes).toEqual({ status: 200, body: { _tag: "Unavailable", reason: "not_configured" } })
      // Push stays with the notification hub.
      expect(yield* plainStatus(`${server.url}/v1/push/config`)).toBe(404)
    }).pipe(Effect.scoped, provideNodeServices))

  it.effect("serves the super-app on a fleet host's loopback and keeps it off its tailnet listeners", () =>
    Effect.gen(function*() {
      const server = yield* started("herdr-peer-superapp-", (root) => ({
        ...config(root),
        approvalPort: 0,
        crossHost: true,
        tailscaleCommand: tailscaleFixture(root, "ALPHA", "node-alpha")
      }))
      expect(server.serveUrl).toBeNull()
      if (server.tailnetUrl === null || server.approvalUrl === null) return yield* Effect.die("peer listeners missing")
      expect((yield* plainSnapshot(server.url)).approvalApp).toMatchObject({
        canonical: false,
        fleet: true,
        superapp: true
      })
      expect((yield* plainSnapshot(server.tailnetUrl)).approvalApp).toMatchObject({ canonical: false, superapp: false })
      expect(yield* plainStatus(`${server.url}/v1/modules/sandboxes/overview`)).toBe(200)
      expect(yield* plainStatus(`${server.tailnetUrl}/v1/modules/sandboxes/overview`)).toBe(404)
    }).pipe(Effect.scoped, provideNodeServices))

  /** Resolves to the refusal status, "attached" once the terminal speaks, or "error". */
  const upgradeOutcome = (url: string, headers: Readonly<Record<string, string>>) =>
    Effect.promise(
      () =>
        new Promise<number | "attached" | "error">((resolve) => {
          const socket = new WebSocketClient(url, { headers })
          socket.once("unexpected-response", (_request, response) => {
            resolve(response.statusCode ?? 0)
            socket.terminate()
          })
          socket.once("message", () => {
            resolve("attached")
            socket.terminate()
          })
          socket.once("error", () => resolve("error"))
        })
    )

  it.effect("attaches only this host's terminal on the hub's loopback, and never for a proxied request", () =>
    Effect.gen(function*() {
      const opened: Array<string> = []
      const root = mkdtempSync(join(tmpdir(), "herdr-hub-loopback-terminal-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const hostConfig: HostConfiguration = {
        ...config(root),
        host: "SER8",
        crossHost: true,
        approvalHub: { host: "SER8", nodeId: "node-ser8", url: "https://ser8.example.test:0/" },
        approvalPort: 0,
        approvalTls: directTls,
        tailscaleCommand: tailscaleFixture(root, "SER8", "node-ser8")
      }
      const store = yield* Effect.acquireRelease(
        JobStore.open(join(root, "jobs.sqlite")),
        (opened) => Effect.sync(() => opened.close())
      )
      const fleet = yield* makeFleetService({ approvalEnabled: true, host: "SER8", operations, store })
      const server = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startHttpServer(hostConfig, fleet, assets, {
            terminalConnector: {
              open: (selection) => {
                opened.push(selection.host)
                return Effect.succeed({ events: Stream.never, send: () => Effect.void })
              }
            }
          })
        ),
        (running) => Effect.promise(running.close)
      )
      const session = (host: string) => {
        const url = new URL("/v1/connect/session", server.url)
        url.protocol = "ws:"
        for (const [key, value] of Object.entries({ host, agent: "agent-1", cols: "100", rows: "30" })) {
          url.searchParams.set(key, value)
        }
        return url.href
      }
      const origin = new URL(server.url).origin
      // A peer's terminal stays tailnet-only: the loopback never proxies one.
      expect(yield* upgradeOutcome(session("ALPHA"), { origin })).toBe(403)
      // A request a local proxy relayed may come from anywhere, so it is not local.
      expect(yield* upgradeOutcome(session("SER8"), { origin, "x-forwarded-for": "198.51.100.7" })).toBe(403)
      expect(opened).toEqual([])
      expect(yield* upgradeOutcome(session("SER8"), { origin })).toBe("attached")
      expect(opened).toEqual(["SER8"])
    }).pipe(Effect.scoped, provideNodeServices))

  // The shell decides between mounting an app and showing a panel from the dashboard snapshot, so the gate must hold
  // there: a third-party app (by the package apps.json names; the fixture claims a @knpkv name) is local_only on the
  // hub's tailnet listener and Ready on its loopback, while a first-party one is Ready on both.
  // Live clock: the apps start as real child processes, and the poll waits on them.
  it.live(
    "lists a third-party app as local_only in the hub listener's dashboard and Ready on its loopback",
    () =>
      Effect.gen(function*() {
        const short = mkdtempSync(join(tmpdir(), "hub-apps-"))
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(short, { force: true, recursive: true })))
        const resolve = (specifier: string) => JSON.stringify(import.meta.resolve(specifier))
        const entry = (id: string, pkg: string) => {
          const dir = join(short, id)
          mkdirSync(dir)
          writeFileSync(
            join(dir, "bin.mjs"),
            `import { runApp } from ${resolve("@knpkv/hub-app/node")}
import { fixtureApp } from ${resolve("@knpkv/hub-app-fixture")}
import { Layer } from ${resolve("effect")}
runApp(fixtureApp("ok", ${JSON.stringify(id)}), Layer.empty)
`
          )
          return {
            id,
            package: pkg,
            version: "0.0.0",
            dir,
            bin: "bin.mjs",
            enabled: true,
            memoryMb: 128,
            allowScripts: false
          }
        }
        const configPath = join(short, "apps.json")
        writeFileSync(
          configPath,
          JSON.stringify({
            v: 2,
            managedBy: "cli",
            trust: { scopes: ["@knpkv", "elsewhere-app"] },
            apps: [entry("first", "@knpkv/hub-app-fixture"), entry("third", "elsewhere-app")]
          })
        )
        const server = yield* started("herdr-hub-apps-gate-", (root) => ({
          ...config(root),
          host: "SER8",
          crossHost: true,
          approvalHub: { host: "SER8", nodeId: "node-ser8", url: "https://ser8.example.test:0/" },
          approvalPort: 0,
          approvalTls: directTls,
          tailscaleCommand: tailscaleFixture(root, "SER8", "node-ser8")
        }), () => ({
          configPath,
          node: process.execPath,
          stateDirectory: join(short, "state"),
          runtimeDirectory: join(short, "run")
        }))
        if (server.serveUrl === null) return yield* Effect.die("canonical listener missing")
        const reasons = (snapshot: DashboardSnapshot) =>
          snapshot.apps.states.map((state) => state._tag === "Ready" ? "ready" : state.reason)
        const local = yield* plainSnapshot(server.url).pipe(
          Effect.filterOrFail((snapshot) =>
            reasons(snapshot).length === 2 && reasons(snapshot).every((reason) => reason === "ready")
          ),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 })
        )
        expect(reasons(local)).toEqual(["ready", "ready"])
        const canonical = yield* Effect.promise(() =>
          secureRequestBody(`${server.serveUrl}/v1/dashboard`, { host: "ser8.example.test:0" })
        )
        expect(reasons(Schema.decodeUnknownSync(Schema.fromJsonString(DashboardSnapshot))(canonical.body))).toEqual([
          "ready",
          "local_only"
        ])
      }).pipe(Effect.scoped, provideNodeServices),
    30_000
  )

  it.effect("keeps the hub's canonical listener and push where they were, and serves the super-app on its loopback too", () =>
    Effect.gen(function*() {
      const server = yield* started("herdr-hub-superapp-", (root) => ({
        ...config(root),
        host: "SER8",
        crossHost: true,
        approvalHub: { host: "SER8", nodeId: "node-ser8", url: "https://ser8.example.test:0/" },
        approvalPort: 0,
        approvalTls: directTls,
        tailscaleCommand: tailscaleFixture(root, "SER8", "node-ser8")
      }))
      if (server.serveUrl === null) return yield* Effect.die("canonical listener missing")
      expect(server.approvalUrl).toBe(server.serveUrl)
      const canonical = yield* Effect.promise(() =>
        secureRequestBody(`${server.serveUrl}/v1/dashboard`, { host: "ser8.example.test:0" })
      )
      expect(canonical.status).toBe(200)
      expect(Schema.decodeUnknownSync(Schema.fromJsonString(DashboardSnapshot))(canonical.body).approvalApp).toEqual({
        canonical: true,
        canonicalUrl: "https://ser8.example.test:0/",
        pushEnabled: true,
        superapp: true,
        fleet: true,
        workEnabled: true,
        sandboxesEnabled: false
      })
      const push = yield* Effect.promise(() =>
        secureRequestBody(`${server.serveUrl}/v1/push/config`, { host: "ser8.example.test:0" })
      )
      expect(push.status).toBe(200)
      expect((yield* plainSnapshot(server.url)).approvalApp).toMatchObject({
        canonical: false,
        pushEnabled: false,
        superapp: true
      })
      expect(yield* plainStatus(`${server.url}/v1/push/config`)).toBe(404)
    }).pipe(Effect.scoped, provideNodeServices))
})
