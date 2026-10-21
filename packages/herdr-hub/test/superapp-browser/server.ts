/** Loopback fixture serving the real built hub clients against schema-checked API responses. */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { StackDetailResult, StackPlanResult, StacksOverviewResult } from "@knpkv/alchemy-console/host"
import {
  CodeCommitSummaryResult,
  CodeDetail,
  CodeDiffContentQuery,
  CodeDiffContentResult,
  CodeDiffResult,
  CodeQueue,
  CodeQueueQuery,
  CodeReviewResult
} from "@knpkv/codecommit-web/host"
import { FleetLimits, FleetUsage } from "@knpkv/herdr-connect"
import { FleetConnectAgentPage } from "@knpkv/herdr-connect/model"
import { type WorkGoal, WorkSnapshots } from "@knpkv/herdr-work/model"
import { BackendStatus, RelayEvent, SessionInfo } from "@knpkv/relay/wire"
import { SandboxesOverview } from "@knpkv/sandbox-pool/host"
import { Clock, Config, Effect, FileSystem, Schema } from "effect"
import { createServer, type ServerResponse } from "node:http"
import { BlockedPushSettings } from "../../src/blocked-push-model.js"
import { DashboardSnapshot, PendingApprovalTarget } from "../../src/dashboard-model.js"
import { fontPreloadLink } from "../../src/font-preload.js"
import { HostResources } from "../../src/host-resources-model.js"
import { dashboardPage } from "../../src/internal/dashboard-page.js"
import { NeedsYouResult } from "../../src/modules.js"
import { relayIconSvg } from "../../src/relay-icon.js"
import {
  CODE_OTHER_REF,
  CODE_REF,
  CODE_REVIEW_STATES,
  codeCommitFixture,
  codeContentFixture,
  codeDetailFixture,
  codeDiffFixture,
  codeQueueFixture,
  codeReviewFixture
} from "./code-fixture.js"
import { connectFixture } from "./connect-fixture.js"
import { resourceFixtureNow, resourcesFixture, resourcesStates } from "./resources-fixture.js"
import { sandboxesOverviewFixture } from "./sandboxes-fixture.js"
import { stackDetailFixture, stackPlanFixture, stacksOverviewFixture, stacksStates } from "./stacks-fixture.js"
import { limitsFixture, usageFixture } from "./usage-fixture.js"

class FixtureStateError extends Schema.TaggedError<FixtureStateError>()("FixtureStateError", {
  state: Schema.String,
  cause: Schema.Defect()
}) {}

class FixtureServerError extends Schema.TaggedError<FixtureServerError>()("FixtureServerError", {
  cause: Schema.Defect()
}) {}

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const now = yield* Clock.currentTimeMillis
  const port = yield* Config.Int("SUPERAPP_FIXTURE_PORT")
  const reviewReadings = new Map<string, CodeReviewResult>()
  for (const state of CODE_REVIEW_STATES) {
    for (const ref of [CODE_REF, CODE_OTHER_REF]) {
      const reading = yield* Effect.try({
        try: () => codeReviewFixture(ref, now, state),
        catch: (cause) => new FixtureStateError({ state: `code-review/${state}/${ref}`, cause })
      })
      if (reading !== null) reviewReadings.set(`${state}/${ref}`, reading)
    }
  }
  // Decode every synthetic state before listening; a bad fixture names its state and cannot kill a mid-run server.
  const connectReadings = new Map<string, FleetConnectAgentPage>()
  for (const state of ["normal", "ready", "empty", "partial", "unknown", "design", "designready", "designpartial"]) {
    connectReadings.set(
      state,
      yield* Effect.try({
        try: () => connectFixture(now, state),
        catch: (cause) => new FixtureStateError({ state, cause })
      })
    )
  }
  const dist = new URL("../../dist/", import.meta.url).pathname
  const assets = new Map<string, Uint8Array>()
  for (const name of yield* fs.readDirectory(dist)) {
    if (/\.(js|css|woff2|png)$/.test(name)) assets.set(`/assets/${name}`, yield* fs.readFile(`${dist}${name}`))
  }
  const fontPreload = fontPreloadLink(
    new Map([...assets].map(([pathname, bytes]) => [pathname.slice("/assets/".length), bytes]))
  )
  const goal: WorkGoal = {
    id: "goal-1",
    title: "Check the module navigation",
    detail: "One exact goal in the browser fixture.",
    summary: "Review ready",
    state: "working",
    delivery: "local",
    blocker: null,
    owner: { id: "agent-1", name: "Agent" },
    repository: { repository: "npm", branch: "feat/navigation" },
    connectTarget: { agentId: "agent-1", host: "hub", url: "/connect/?agent=agent-1&host=hub" },
    spend: null,
    createdAt: now,
    updatedAt: now
  }
  const window = (window: "now" | "day" | "week" | "month") => ({ window, asOf: now, observedAt: now, goals: [goal] })
  const work = Schema.decodeUnknownSync(WorkSnapshots)({
    observedAt: now,
    now: window("now"),
    day: window("day"),
    week: window("week"),
    month: window("month")
  })
  const record = {
    id: "job-1",
    actor: "Requester",
    status: "pending_approval",
    payload: { kind: "nix.apply", ref: "main" },
    approvalAvailable: true,
    approvalExpiresAt: now + 600_000,
    approvedAt: null,
    approvedBy: null,
    createdAt: now,
    expiredAt: null,
    rejectedAt: null,
    rejectedBy: null,
    updatedAt: now
  }
  const snapshot = Schema.decodeUnknownSync(DashboardSnapshot)({
    host: "hub",
    observedAt: now,
    approvalsEnabled: true,
    approvalApp: {
      canonical: true,
      canonicalUrl: `http://127.0.0.1:${String(port)}/`,
      pushEnabled: false,
      superapp: true,
      fleet: true,
      workEnabled: true,
      sandboxesEnabled: true
    },
    work,
    records: [{ ...record, id: "job-finished", actor: "Requester", status: "succeeded" }],
    historyNextCursor: null,
    directory: null,
    pendingApprovals: { local: [record], remote: [], failures: [], nextCursors: [] },
    status: {
      host: "hub",
      applyConfigured: true,
      branch: "main",
      dirty: false,
      repository: "npm",
      revision: "abc123",
      herdr: {
        agents: [{
          agentId: "agent-1",
          activityRevision: 1,
          parentAgentId: null,
          relation: null,
          name: "Agent",
          kind: "test",
          paneId: "w9:p1",
          status: "working",
          work: "Checking module navigation"
        }],
        available: true,
        error: null
      }
    }
  })
  // The target is absent from page one and must be resolved through the exact-target endpoint.
  const offPageTarget = Schema.decodeUnknownSync(PendingApprovalTarget)({
    _tag: "local",
    record: { ...record, id: "job-off-page", actor: "Off-page requester" }
  })
  const alphaTarget = Schema.decodeUnknownSync(PendingApprovalTarget)({
    _tag: "remote",
    remote: {
      host: "ALPHA",
      approvalUrl: `http://127.0.0.1:${String(port)}/`,
      approval: {
        id: "alpha-off-page",
        actor: "Peer requester",
        createdAt: now,
        status: "pending_approval",
        approvalExpiresAt: now + 900_000,
        payload: { kind: "nix.apply", ref: "main" }
      }
    }
  })
  const todayItem = (host: string, jobId: string, expiresAt: number) => ({
    key: `fleet:${host.toLowerCase()}:${jobId}`,
    provider: "fleet",
    destination: { _tag: "FleetApproval", module: "fleet", host, jobId },
    kind: "nix.apply",
    actor: host === "ALPHA" ? "Peer requester" : "Requester",
    createdAt: now,
    expiresAt
  })
  const todayItems = [
    todayItem("hub", "job-off-page", now + 180_000),
    todayItem("hub", "job-1", now + 600_000),
    todayItem("ALPHA", "alpha-off-page", now + 900_000)
  ]
  const todayReadings = new Map<string, NeedsYouResult>([
    ["normal", Schema.decodeUnknownSync(NeedsYouResult)({ _tag: "Complete", items: todayItems })],
    ["empty", Schema.decodeUnknownSync(NeedsYouResult)({ _tag: "Complete", items: [] })],
    [
      "partial",
      Schema.decodeUnknownSync(NeedsYouResult)({
        _tag: "Partial",
        items: todayItems,
        sources: [
          { provider: "fleet", issue: { state: "hosts", hosts: [{ host: "cedar", reason: "offline" }] } }
        ]
      })
    ],
    [
      "expired",
      Schema.decodeUnknownSync(NeedsYouResult)({ _tag: "Complete", items: [todayItem("hub", "job-1", now - 1_000)] })
    ]
  ])
  const responses = new Map([
    [
      "/v1/push/blocked-settings",
      Schema.encodeSync(Schema.fromJsonString(BlockedPushSettings))({ mutedAgents: [], quietHours: null })
    ],
    ["/v1/dashboard", Schema.encodeSync(Schema.fromJsonString(DashboardSnapshot))(snapshot)],
    ["/v1/work", Schema.encodeSync(Schema.fromJsonString(WorkSnapshots))(work)],
    [
      "/v1/connect/agents",
      Schema.encodeSync(Schema.fromJsonString(FleetConnectAgentPage))({
        agents: [
          {
            id: "agent-1",
            host: "hub",
            name: "Agent",
            kind: "test",
            state: "working",
            work: "npm",
            lastActivityAt: now
          }
        ],
        failures: [],
        nextCursor: null
      })
    ],
    [
      "/v1/connect/limits",
      Schema.encodeSync(Schema.fromJsonString(FleetLimits))({ hosts: [], failures: [], peersListed: true })
    ],
    [
      "/v1/connect/usage",
      Schema.encodeSync(Schema.fromJsonString(FleetUsage))({ hosts: [], failures: [], peersListed: true })
    ],
    ["/v1/connect/archive", JSON.stringify({ agents: [], nextCursor: null })],
    [
      "/v1/relay/session",
      Schema.encodeSync(Schema.fromJsonString(SessionInfo))({ tools: [], backend: "codex-cli", cancel: false })
    ],
    [
      "/v1/relay/backends",
      Schema.encodeSync(Schema.fromJsonString(Schema.Array(BackendStatus)))([
        { _tag: "Ready", backend: "codex-cli", label: "Test backend", version: "1" }
      ])
    ],
    ["/manifest.webmanifest", JSON.stringify({ name: "Relay", start_url: "/", display: "standalone" })]
  ])
  const noncanonical = {
    ...snapshot,
    approvalApp: { ...snapshot.approvalApp, canonical: false, superapp: false, workEnabled: false }
  }
  // A hub that does not own the sandbox pool: the shell leaves the Sandboxes row out.
  const withoutSandboxes = { ...snapshot, approvalApp: { ...snapshot.approvalApp, sandboxesEnabled: false } }
  const initialFrame = Schema.encodeSync(Schema.fromJsonString(RelayEvent))({
    _tag: "Snapshot",
    session: "session-1",
    seq: 0,
    messages: [],
    runIds: [],
    queued: []
  })
  const activeFrame = Schema.encodeSync(Schema.fromJsonString(RelayEvent))({
    _tag: "Snapshot",
    session: "session-1",
    seq: 0,
    messages: [
      { id: "reply-1", role: "relay", text: "First reply" },
      { id: "message-1", role: "user", text: "Another question" },
      { id: "reply-2", role: "relay", text: "Second reply" },
      { id: "message-2", role: "user", text: "Latest question" },
      { id: "reply-3", role: "relay", text: "Current reply" }
    ],
    runIds: ["run-1"],
    queued: []
  })
  const frameOf = (event: RelayEvent): string => Schema.encodeSync(Schema.fromJsonString(RelayEvent))(event)
  const at = { session: "session-1", seq: 1 }
  const idleFrame = frameOf({
    _tag: "Snapshot",
    session: "session-1",
    seq: 0,
    messages: [
      { id: "message-1", role: "user", text: "What needs me across my tools?" },
      { id: "reply-1", role: "relay", text: "No tool needs your decision. Open Fleet to review its current work." }
    ],
    runIds: [],
    queued: []
  })
  const phaseFrames = new Map<string, ReadonlyArray<string>>([
    ["idle", [idleFrame]],
    ["listening", [idleFrame]],
    ["thinking", [activeFrame]],
    ["turns", [activeFrame]],
    [
      "answering",
      [
        activeFrame,
        frameOf({ _tag: "TextDelta", ...at, text: "Reading the latest work and explaining the next step." })
      ]
    ],
    [
      "needs-you",
      [
        activeFrame,
        frameOf({
          _tag: "ConfirmationRequired",
          ...at,
          call: "call-1",
          action: { verb: "prompt_agent", target: { product: "herdr", kind: "fleet", id: "hub" }, args: {} },
          reversible: false
        })
      ]
    ]
  ])
  const streams = new Set<ServerResponse>()
  let relaySubscriptions = 0
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid")
    const asset = assets.get(url.pathname)
    if (asset !== undefined) {
      const type = url.pathname.endsWith(".css")
        ? "text/css"
        : url.pathname.endsWith(".woff2")
        ? "font/woff2"
        : url.pathname.endsWith(".png")
        ? "image/png"
        : "text/javascript"
      response.writeHead(200, { "content-type": type })
      response.end(asset)
      return
    }
    if (url.pathname === "/" || url.pathname === "/fleet") {
      response.writeHead(200, { "content-type": "text/html" })
      response.end(
        dashboardPage(
          url.searchParams.has("noncanonical")
            ? noncanonical
            : url.searchParams.has("nosandboxes")
            ? withoutSandboxes
            : snapshot,
          fontPreload
        )
      )
      return
    }
    if (url.pathname === "/connect/") {
      response.writeHead(200, { "content-type": "text/html" })
      response.end(
        "<!doctype html><html lang=\"en\"><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><link rel=\"stylesheet\" href=\"/assets/index.css\"></head><body data-rly-root data-rly-theme=\"dark\" class=\"connect-body\"><div id=\"fleet-connect-root\"></div><script src=\"/assets/connect.js\"></script></body></html>"
      )
      return
    }
    if (url.pathname === "/v1/relay/events") {
      relaySubscriptions += 1
      streams.add(response)
      response.on("close", () => streams.delete(response))
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      const source = request.headers.referer !== undefined && URL.canParse(request.headers.referer)
        ? new URL(request.headers.referer)
        : null
      for (const frame of phaseFrames.get(source?.searchParams.get("relayFixture") ?? "") ?? [initialFrame]) {
        response.write(`data: ${frame}\n\n`)
      }
      return
    }
    if (url.pathname === "/__fixture/relay-subscriptions") {
      response.end(String(relaySubscriptions))
      return
    }
    if (url.pathname === "/v1/modules/connect/needs-you") {
      const source = request.headers.referer !== undefined && URL.canParse(request.headers.referer)
        ? new URL(request.headers.referer)
        : null
      const state = source?.searchParams.get("todayFixture") ?? "normal"
      if (state === "failed") {
        response.writeHead(503, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "unavailable" }))
      } else {
        const reading = todayReadings.get(state)
        if (reading === undefined) {
          response.writeHead(404)
          response.end()
        } else {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(Schema.encodeSync(Schema.fromJsonString(NeedsYouResult))(reading))
        }
      }
      return
    }
    if (url.pathname === "/v1/connect/agents") {
      const state = request.headers.cookie?.match(/(?:^|;\s*)connect-fixture=([a-z]+)/u)?.[1]
      if (state !== undefined) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          Schema.encodeSync(Schema.fromJsonString(FleetConnectAgentPage))(
            connectReadings.get(state) ?? connectFixture(now, "normal")
          )
        )
        return
      }
    }
    if (url.pathname === "/v1/pending-approval") {
      if (
        url.searchParams.get("host")?.toLowerCase() === "alpha" && url.searchParams.get("jobId") === "alpha-off-page"
      ) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(Schema.encodeSync(Schema.fromJsonString(PendingApprovalTarget))(alphaTarget))
      } else if (url.searchParams.get("host") === "hub" && url.searchParams.get("jobId") === "job-off-page") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(Schema.encodeSync(Schema.fromJsonString(PendingApprovalTarget))(offPageTarget))
      } else {
        response.writeHead(404)
        response.end()
      }
      return
    }
    if (url.pathname === "/v1/host/resources") {
      const selected = request.headers.cookie?.match(/(?:^|;\s*)resources-fixture=([a-z-]+)/u)?.[1]
      const state = resourcesStates.find((state) => state === selected) ?? "live-healthy"
      const fixture = resourcesFixture(state, resourceFixtureNow)
      if (fixture.loading) return
      if (fixture.snapshot === null) {
        response.writeHead(503, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "unavailable" }))
      } else {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        response.end(Schema.encodeSync(Schema.fromJsonString(HostResources))(fixture.snapshot))
      }
      return
    }
    if (url.pathname === "/v1/dashboard" && request.headers.cookie?.includes("resources-fixture=") === true) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(Schema.encodeSync(Schema.fromJsonString(DashboardSnapshot))({ ...snapshot, host: "maple" }))
      return
    }
    if (url.pathname === "/v1/connect/usage" || url.pathname === "/v1/connect/limits") {
      const state = request.headers.cookie?.match(/(?:^|;\s*)usage-fixture=([a-z]+)/u)?.[1] ?? "normal"
      if (state === "failed") {
        response.writeHead(503, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "unavailable" }))
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
      if (url.pathname === "/v1/connect/usage") {
        const range = url.searchParams.get("range")
        const query = {
          range: range === "24h" || range === "30d" ? range : "7d",
          timeZone: url.searchParams.get("timeZone") ?? "UTC"
        } satisfies Parameters<typeof usageFixture>[0]
        response.end(Schema.encodeSync(Schema.fromJsonString(FleetUsage))(usageFixture(query, now, state)))
      } else response.end(Schema.encodeSync(Schema.fromJsonString(FleetLimits))(limitsFixture(now, state)))
      return
    }
    if (url.pathname.startsWith("/v1/modules/stacks/")) {
      const selected = request.headers.cookie?.match(/(?:^|;\s*)stacks-fixture=([a-z-]+)/u)?.[1]
      const state = stacksStates.find((candidate) => candidate === selected) ?? "overview"
      // Loading never answers, so the page stays in its reading state.
      if (state === "loading") return
      response.setHeader("content-type", "application/json")
      const id = url.searchParams.get("id") ?? ""
      if (url.pathname.endsWith("/overview")) {
        response.end(Schema.encodeSync(Schema.fromJsonString(StacksOverviewResult))(stacksOverviewFixture(state)))
      } else if (url.pathname.endsWith("/stack")) {
        const detail = stackDetailFixture(id)
        if (detail === null) {
          response.writeHead(404)
          response.end()
        } else response.end(Schema.encodeSync(Schema.fromJsonString(StackDetailResult))(detail))
      } else if (url.pathname.endsWith("/plan")) {
        response.end(Schema.encodeSync(Schema.fromJsonString(StackPlanResult))(stackPlanFixture(id)))
      } else {
        response.writeHead(404)
        response.end()
      }
      return
    }
    if (url.pathname.startsWith("/v1/modules/code/")) {
      const state = request.headers.cookie?.match(/(?:^|;\s*)code-fixture=([a-z]+)/u)?.[1] ?? "normal"
      if (state === "failed") {
        response.writeHead(503, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "unavailable" }))
        return
      }
      response.setHeader("content-type", "application/json")
      if (url.pathname.endsWith("/queue")) {
        const query = Schema.decodeUnknownResult(CodeQueueQuery)(url.searchParams, { onExcessProperty: "error" })
        if (query._tag === "Failure") {
          response.writeHead(400)
          response.end()
          return
        }
        response.end(Schema.encodeSync(Schema.fromJsonString(CodeQueue))(codeQueueFixture(query.success, now, state)))
      } else if (url.pathname.endsWith("/detail")) {
        const reading = codeDetailFixture(url.searchParams.get("ref") ?? "", now, state)
        if (reading === null) {
          response.writeHead(404)
          response.end()
          return
        }
        response.end(Schema.encodeSync(Schema.fromJsonString(CodeDetail))(reading))
      } else if (url.pathname.endsWith("/review")) {
        const ref = url.searchParams.get("ref") ?? ""
        const reading = reviewReadings.get(`${CODE_REVIEW_STATES.includes(state) ? state : "normal"}/${ref}`)
        if (reading === undefined) {
          response.writeHead(404)
          response.end()
          return
        }
        response.end(Schema.encodeSync(Schema.fromJsonString(CodeReviewResult))(reading))
      } else if (url.pathname.endsWith("/commit")) {
        const reading = codeCommitFixture(url.searchParams.get("commit") ?? "", now)
        if (reading === null) {
          response.writeHead(404)
          response.end()
          return
        }
        response.end(Schema.encodeSync(Schema.fromJsonString(CodeCommitSummaryResult))(reading))
      } else if (url.pathname.endsWith("/diff")) {
        const reading = codeDiffFixture(url.searchParams.get("ref") ?? "", now, state)
        if (reading === null) {
          response.writeHead(404)
          response.end()
          return
        }
        response.end(Schema.encodeSync(Schema.fromJsonString(CodeDiffResult))(reading))
      } else if (url.pathname.endsWith("/diff-content")) {
        const query = Schema.decodeUnknownResult(CodeDiffContentQuery)(url.searchParams, { onExcessProperty: "error" })
        if (query._tag === "Failure") {
          response.writeHead(400)
          response.end()
          return
        }
        response.end(
          Schema.encodeSync(Schema.fromJsonString(CodeDiffContentResult))(
            codeContentFixture(query.success.fileIndex, query.success.revisionId, state)
          )
        )
      } else {
        response.writeHead(404)
        response.end()
      }
      return
    }
    if (
      url.pathname === "/assets/relay-icon.svg" || url.pathname === "/assets/relay-favicon.svg" ||
      url.pathname === "/favicon.ico"
    ) {
      response.writeHead(200, { "content-type": "image/svg+xml" })
      response.end(
        relayIconSvg(
          url.pathname === "/assets/relay-icon.svg" ? "tile" : "favicon",
          url.pathname === "/assets/relay-icon.svg" ? 512 : 16
        )
      )
      return
    }
    if (
      url.pathname === "/v1/dashboard" &&
      request.headers.referer !== undefined &&
      URL.canParse(request.headers.referer) &&
      new URL(request.headers.referer).searchParams.has("noncanonical")
    ) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(Schema.encodeSync(Schema.fromJsonString(DashboardSnapshot))(noncanonical))
      return
    }
    if (
      url.pathname === "/v1/dashboard" &&
      request.headers.referer !== undefined &&
      URL.canParse(request.headers.referer) &&
      new URL(request.headers.referer).searchParams.has("nosandboxes")
    ) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(Schema.encodeSync(Schema.fromJsonString(DashboardSnapshot))(withoutSandboxes))
      return
    }
    if (url.pathname === "/v1/modules/sandboxes/overview") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(Schema.encodeSync(Schema.fromJsonString(SandboxesOverview))(sandboxesOverviewFixture(now)))
      return
    }
    if (url.pathname === "/v1/push/stage-heartbeat" && request.method === "POST") {
      response.writeHead(204)
      response.end()
      return
    }
    const json = responses.get(url.pathname)
    if (json !== undefined) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(json)
      return
    }
    response.writeHead(404)
    response.end()
  })
  yield* Effect.acquireRelease(
    Effect.callback<void, FixtureServerError>((resume) => {
      server.once("error", (cause) => resume(Effect.fail(new FixtureServerError({ cause }))))
      server.listen(port, "127.0.0.1", () => resume(Effect.void))
    }),
    () =>
      Effect.sync(() => {
        for (const stream of streams) stream.end()
        server.closeAllConnections()
        server.close()
      })
  )
  return yield* Effect.never
})
NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
