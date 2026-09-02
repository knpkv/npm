import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import type {
  ConnectPeerError,
  TerminalAgentNotFoundError,
  TerminalBusyError,
  TerminalConnector,
  TerminalProtocolError,
  TerminalTransportError
} from "@knpkv/herdr-connect"
import {
  AgentActivityStore,
  AgentRelationshipStore,
  ConnectAgentCursor,
  fleetConnectAgents,
  localConnectAgents,
  makeHerdrTerminalConnector,
  pageFleetConnectAgents,
  TerminalClientCommand,
  terminalCommandMaxPayloadBytes,
  terminalFrameMaxEncodedBytes,
  TerminalSelection,
  TerminalServerSignal
} from "@knpkv/herdr-connect"
import type { ChatHistoryError } from "@knpkv/herdr-coordinator"
import { ChatRequest, ChatStore, makeCoordinatorChat } from "@knpkv/herdr-coordinator"
import type {
  FleetJobConflictError,
  FleetService,
  FleetStoreError,
  FleetTransitionConflictError,
  HostConfiguration,
  JobRecord
} from "@knpkv/herdr-fleet"
import {
  decodeBoundedResponseJson,
  FleetApprovalError,
  FleetAuthorizationError,
  FleetJobNotFoundError,
  FleetOperationError,
  fleetResponseBodyMaxBytes,
  FleetValidationError,
  JobHash,
  JobIdentifier,
  JobRequest,
  PeerPendingDecodeError,
  PeerPendingHostMismatchError,
  PeerPendingStatusError,
  PeerPendingTimeoutError,
  PeerPendingTransportError,
  PeerPendingUnavailableError,
  PendingApprovalCursor
} from "@knpkv/herdr-fleet"
import type { TailscaleAuthorizationError } from "@knpkv/herdr-tailscale"
import { authorizeWhois, discoverFleetPeers, layer as tailscaleLayer, Tailscale } from "@knpkv/herdr-tailscale"
import type {
  WorkCheckpointConflictError,
  WorkProjectionError,
  WorkService,
  WorkSnapshots,
  WorkStoreError
} from "@knpkv/herdr-work"
import { approvalTargetMatchesOrigin, makeWorkService, WorkSnapshotWindow, WorkStore } from "@knpkv/herdr-work"
import { WorkGoalCheckpoint, type WorkGoalCheckpoint as WorkGoalCheckpointType } from "@knpkv/herdr-work/model"
import {
  Cause,
  Clock,
  Crypto,
  Effect,
  Equal,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  ManagedRuntime,
  Queue,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream
} from "effect"
import type { Redacted } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as createSecureServer } from "node:https"
import type { Duplex } from "node:stream"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import WebSocketClient, { WebSocketServer } from "ws"
import { type SanitizedJobRecord, sanitizeJobRecord } from "./approval-request.js"
import { resolveApprovalPage } from "./approval-url.js"
import { authorize, authorizeLoopback } from "./auth.js"
import {
  type ApprovalDirectory,
  type DashboardHistoryPage,
  type DashboardSnapshot,
  type PendingApproval,
  PendingApprovalContinuation,
  type PendingApprovalFailure,
  PendingApprovalSummary,
  type PendingApprovalTarget
} from "./dashboard-model.js"
import { DashboardView } from "./dashboard-view.js"
import { DashboardResponseBudgetError } from "./errors.js"
import type { ApprovalAppStoreError, PushEndpointNotAllowedError } from "./errors.js"
import { dashboardDocumentTitle } from "./internal/html.js"
import { relayTerminalCloseCode, terminalBufferCanAccept } from "./internal/websocket.js"
import { LanWorkPage, LanWorkPairPage } from "./lan-work-view.js"
import {
  decodeLanWorkPairRequest,
  LanWorkConfigurationError,
  type LanWorkCryptoError,
  type LanWorkListenerOptions,
  LanWorkOriginRejectedError,
  type LanWorkPairing,
  type LanWorkPairingExpiredError,
  LanWorkPairingMalformedError,
  type LanWorkPairingRejectedError,
  type LanWorkPairingReplayedError,
  LanWorkPairRequestInput,
  LanWorkSelectionMalformedError,
  lanWorkSessionCookie,
  type LanWorkSessionRejectedError,
  type LanWorkSessionRequiredError,
  makeLanWorkPairing,
  readLanWorkSessionCookie
} from "./lan-work.js"
import {
  ApprovalNotificationCandidate,
  type ApprovalNotificationCandidate as ApprovalNotificationCandidateType,
  PushSubscriptionRecord,
  PushSubscriptionRemoval
} from "./model.js"
import { generateVapidKeys, makePushSender } from "./push-sender.js"
import { validatePushEndpoint } from "./push-subscription.js"
import { type ApprovalNotificationBatch, makePushWorker } from "./push-worker.js"
import { ApprovalAppStore } from "./store.js"
import { workCheckpointPath, workSnapshotPath } from "./work-checkpoint.js"

const Approval = Schema.Struct({ hash: JobHash, nonce: Schema.String })
type Approval = typeof Approval.Type
type ApprovalProof = {
  readonly expiresAt: number
  readonly hash: typeof JobHash.Type
  readonly jobId: string
  readonly nonce: string
}
type ApprovalProofIssuer = (records: ReadonlyArray<JobRecord>) => Effect.Effect<void, FleetOperationError>
const approvalProofCookiePrefix = "fleet_approval_proof_"
const approvalProofMaxAgeSeconds = 15 * 60

const approvalProofCookieName = (jobId: string): string =>
  `${approvalProofCookiePrefix}${Buffer.from(jobId).toString("base64url")}`

const cookieValue = (request: IncomingMessage, name: string): string | undefined =>
  header(request, "cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)

const approvalProofCookie = (jobId: string, token: string): string =>
  `${approvalProofCookieName(jobId)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${approvalProofMaxAgeSeconds}`
const TcpAddress = Schema.Struct({ address: Schema.String, port: Schema.Number })

const decodeJobPathSegment = Effect.fn("ApprovalHttp.decodeJobPathSegment")((segment: string) =>
  Effect.try({
    try: () => decodeURIComponent(segment),
    catch: () => new FleetValidationError({ detail: "invalid job identifier path segment" })
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(JobIdentifier)(value).pipe(
        Effect.mapError(() => new FleetValidationError({ detail: "invalid job identifier path segment" }))
      )
    )
  )
)

const peerPendingTimeoutMs = 1_500
const terminalFrameMaxPayload = terminalFrameMaxEncodedBytes

export type UiAssets = {
  readonly script: string
  readonly connectScript: string
  readonly worker: string
  readonly stylesheet: string
  readonly fonts: ReadonlyMap<string, Uint8Array>
}

type ApiError =
  | ApprovalAppStoreError
  | ChatHistoryError
  | ConnectPeerError
  | DashboardResponseBudgetError
  | FleetApprovalError
  | FleetAuthorizationError
  | FleetJobConflictError
  | FleetJobNotFoundError
  | FleetOperationError
  | FleetStoreError
  | FleetTransitionConflictError
  | FleetValidationError
  | LanWorkConfigurationError
  | LanWorkCryptoError
  | LanWorkOriginRejectedError
  | LanWorkPairingExpiredError
  | LanWorkPairingMalformedError
  | LanWorkPairingRejectedError
  | LanWorkPairingReplayedError
  | LanWorkSelectionMalformedError
  | LanWorkSessionRejectedError
  | LanWorkSessionRequiredError
  | PushEndpointNotAllowedError
  | TerminalTransportError
  | WorkCheckpointConflictError
  | WorkProjectionError
  | WorkStoreError

type LanPairError =
  | LanWorkConfigurationError
  | LanWorkCryptoError
  | LanWorkOriginRejectedError
  | LanWorkPairingExpiredError
  | LanWorkPairingMalformedError
  | LanWorkPairingRejectedError
  | LanWorkPairingReplayedError
  | LanWorkSessionRejectedError
  | LanWorkSessionRequiredError

type Runner = {
  readonly close: () => Promise<void>
  readonly enqueue: (jobId: string) => Promise<boolean>
}

type ListenerMode = "local" | "tailnet" | "approval" | "serve" | "work" | "lan"

type TlsCredentials = {
  readonly certificate: string
  readonly privateKey: string
}

type PushSender = ReturnType<typeof makePushSender>

export type HttpServerOptions = {
  readonly lanWork?: LanWorkListenerOptions
  readonly now?: () => number
  readonly pushSender?: PushSender
  readonly terminalConnector?: TerminalConnector
}

type PeerTarget = {
  readonly host: string
  readonly online: boolean
  readonly approvalUrl: string | null
  readonly pendingUrl: string | null
  readonly connectAgentsUrl: string | null
  readonly terminalUrl: string | null
}

type PeerPendingError =
  | PeerPendingDecodeError
  | PeerPendingHostMismatchError
  | PeerPendingStatusError
  | PeerPendingTimeoutError
  | PeerPendingTransportError
  | PeerPendingUnavailableError

type ResponseHeaderValue = string | Array<string>

const json = <Value>(
  response: ServerResponse,
  status: number,
  value: Value,
  headers: Readonly<Record<string, ResponseHeaderValue>> = {}
): void => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers
  })
  response.end(`${JSON.stringify(value)}\n`)
}

interface ApiErrorResponse {
  readonly status: number
  readonly body: Readonly<Record<string, string | number>>
}

const apiError = (error: ApiError): ApiErrorResponse => {
  switch (error._tag) {
    case "FleetAuthorizationError":
      return { status: 403, body: { error: error._tag, actor: error.actor } }
    case "FleetJobNotFoundError":
      return { status: 404, body: { error: error._tag, jobId: error.jobId } }
    case "FleetJobConflictError":
      return { status: 409, body: { error: error._tag, jobId: error.jobId } }
    case "FleetApprovalError":
      return { status: 409, body: { error: error._tag, detail: error.detail } }
    case "FleetTransitionConflictError":
      return { status: 409, body: { error: error._tag, jobId: error.jobId } }
    case "FleetValidationError":
      return { status: 400, body: { error: error._tag, detail: error.detail } }
    case "LanWorkPairingMalformedError":
      return { status: 400, body: { error: error._tag, detail: error.detail } }
    case "LanWorkSelectionMalformedError":
      return { status: 400, body: { error: error._tag, detail: error.detail } }
    case "LanWorkOriginRejectedError":
      return { status: 403, body: { error: error._tag } }
    case "LanWorkPairingRejectedError":
    case "LanWorkPairingExpiredError":
    case "LanWorkPairingReplayedError":
    case "LanWorkSessionRejectedError":
    case "LanWorkSessionRequiredError":
      return { status: 401, body: { error: error._tag } }
    case "PushEndpointNotAllowedError":
      return { status: 400, body: { error: error._tag, origin: error.origin } }
    case "ConnectPeerError":
      return {
        status: 503,
        body: { error: error._tag, host: error.host, reason: error.reason }
      }
    case "FleetOperationError":
    case "TerminalTransportError":
      return { status: 503, body: { error: error._tag, detail: error.detail } }
    case "LanWorkCryptoError":
      return { status: 503, body: { error: error._tag, detail: error.operation } }
    case "LanWorkConfigurationError":
      return { status: 500, body: { error: error._tag, detail: error.detail } }
    case "FleetStoreError":
      return { status: 500, body: { error: error._tag, detail: error.detail } }
    case "ApprovalAppStoreError":
    case "ChatHistoryError":
    case "WorkProjectionError":
      return { status: 500, body: { error: error._tag, detail: error.detail } }
    case "WorkStoreError":
      return { status: 500, body: { error: error._tag, detail: error.operation } }
    case "WorkCheckpointConflictError":
      return { status: 409, body: { error: error._tag, eventId: error.eventId } }
    case "DashboardResponseBudgetError":
      return {
        status: 413,
        body: {
          error: error._tag,
          encodedBytes: error.encodedBytes,
          maximumBytes: error.maximumBytes
        }
      }
  }
}

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

const actor = (
  request: IncomingMessage,
  config: HostConfiguration,
  allowLocal: boolean
) =>
  authorize(
    {
      remoteAddress: request.socket.remoteAddress,
      login: header(request, "tailscale-user-login")
    },
    config.allowedUsers,
    allowLocal
  )

const sameOrigin = (request: IncomingMessage, expected: string) => {
  const received = header(request, "origin")
  return received === expected
    ? Effect.void
    : Effect.fail(
      new FleetAuthorizationError({ actor: received ?? "missing-origin" })
    )
}

export const listenerAuthority = (address: string, port: number): string =>
  new URL(
    `http://${address.includes(":") && !address.startsWith("[") ? `[${address}]` : address}:${port}/`
  ).host.toLowerCase()

const approvalIcon =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#111418"/><path d="M146 264l72 72 148-160" fill="none" stroke="#a6e3a1" stroke-linecap="round" stroke-linejoin="round" stroke-width="52"/></svg>`

const approvalManifest = JSON.stringify({
  id: "/",
  name: "Fleet approvals",
  short_name: "Approvals",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#111418",
  theme_color: "#111418",
  icons: [
    {
      src: "/assets/approval-icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any maskable"
    }
  ]
})

const tailnetActor = Effect.fn("ApprovalHttp.tailnetActor")(function*(
  request: IncomingMessage,
  config: HostConfiguration,
  requiredNodeIds: ReadonlyArray<string> | null
) {
  const address = request.socket.remoteAddress
  if (address === undefined) {
    return yield* new FleetAuthorizationError({ actor: "unknown" })
  }
  const tailscale = yield* Tailscale
  const identity = yield* tailscale.whois(address).pipe(
    Effect.mapError(
      (cause) =>
        new FleetOperationError({
          cause,
          detail: String(cause),
          operation: "tailscale.whois"
        })
    )
  )
  return yield* authorizeWhois(
    identity,
    config.allowedUsers,
    requiredNodeIds
  ).pipe(
    Effect.mapError(
      (error: TailscaleAuthorizationError) => new FleetAuthorizationError({ actor: error.actor })
    )
  )
})

const readBody = (request: IncomingMessage) =>
  Effect.tryPromise({
    try: async () => {
      const chunks: Array<Buffer> = []
      let size = 0
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > 1024 * 1024) throw new Error("request body exceeds 1 MiB")
        chunks.push(buffer)
      }
      return Buffer.concat(chunks).toString("utf8")
    },
    catch: (cause) => new FleetValidationError({ detail: String(cause) })
  })

const readJson = Effect.fn("ApprovalHttp.readJson")(function*<A>(
  request: IncomingMessage,
  schema: Schema.Codec<A, unknown, never, never>
) {
  const mediaType = (header(request, "content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase()
  if (mediaType !== "application/json") {
    return yield* new FleetValidationError({
      detail: "content-type must be application/json"
    })
  }
  const text = yield* readBody(request)
  const unknown = yield* Effect.try({
    try: () => JSON.parse(text),
    catch: (cause) => new FleetValidationError({ detail: `invalid JSON: ${String(cause)}` })
  })
  return yield* Schema.decodeUnknownEffect(schema, {
    onExcessProperty: "error"
  })(unknown).pipe(
    Effect.mapError(
      (error) =>
        new FleetValidationError({
          detail: `invalid request: ${String(error)}`
        })
    )
  )
})

const authorizeOriginlessMutation = (request: IncomingMessage) => {
  const origin = header(request, "origin")
  const fetchSite = header(request, "sec-fetch-site")
  return origin === undefined && fetchSite !== "cross-site"
    ? Effect.void
    : Effect.fail(
      new FleetAuthorizationError({ actor: origin ?? fetchSite ?? "browser" })
    )
}

export const recordWorkCheckpointRequest = Effect.fn("ApprovalHttp.recordWorkCheckpointRequest")(
  function*<Authorization, AuthorizationError, AuthorizationRequirements, DecodeError, DecodeRequirements>(
    authorization: Effect.Effect<Authorization, AuthorizationError, AuthorizationRequirements>,
    decode: Effect.Effect<WorkGoalCheckpointType, DecodeError, DecodeRequirements>,
    work: WorkService,
    approvalPage?: (host: string) => Effect.Effect<string, FleetValidationError | FleetOperationError>
  ) {
    yield* authorization
    const checkpoint = yield* decode
    const targets = [
      checkpoint.goal.approvalTarget,
      ...(checkpoint.goal.requests ?? []).map(({ approvalTarget }) => approvalTarget)
    ].filter((target): target is NonNullable<typeof target> => target !== undefined && target !== null)
    if (targets.length > 0) {
      const snapshots = yield* work.snapshots(checkpoint.occurredAt)
      const exactReplay = snapshots.now.goals.some(
        (goal) => goal.id === checkpoint.goal.id && Equal.equals(goal, checkpoint.goal)
      )
      if (exactReplay) return yield* work.record(checkpoint)
    }
    if (approvalPage === undefined) {
      if (targets.length > 0) {
        return yield* new FleetValidationError({
          detail: "approval target origin cannot be validated without an authoritative page resolver"
        })
      }
      return yield* work.record(checkpoint)
    }
    const approvalPageCache = new Map<
      string,
      Effect.Effect<string, FleetValidationError | FleetOperationError>
    >()
    for (const target of targets) {
      const hostKey = target.host.toLowerCase()
      let approvalPageEffect = approvalPageCache.get(hostKey)
      if (approvalPageEffect === undefined) {
        approvalPageEffect = yield* Effect.cached(approvalPage(target.host))
        approvalPageCache.set(hostKey, approvalPageEffect)
      }
      const approvalPageUrl = yield* approvalPageEffect
      const expectedOrigin = yield* Effect.try({
        try: () => new URL(approvalPageUrl).origin,
        catch: (cause) =>
          new FleetValidationError({
            detail: `invalid authoritative approval page: ${String(cause)}`
          })
      })
      const matchesOrigin = yield* Effect.try({
        try: () => approvalTargetMatchesOrigin(target, expectedOrigin),
        catch: (cause) =>
          new FleetValidationError({
            detail: `invalid approval target URL: ${String(cause)}`
          })
      })
      if (!matchesOrigin) {
        return yield* new FleetValidationError({
          detail: `approval target origin does not match configured page for ${target.host}`
        })
      }
    }
    return yield* work.record(checkpoint)
  }
)

const pathOf = (request: IncomingMessage): URL => {
  const url = new URL(request.url ?? "/", "http://hostd.local")
  if (url.pathname === "/fleet") url.pathname = "/"
  if (url.pathname.startsWith("/fleet/")) {
    url.pathname = url.pathname.slice("/fleet".length)
  }
  return url
}

const fleetPeers = Effect.fn("HostHttp.fleetPeers")(function*(
  config: HostConfiguration
) {
  const peers = yield* discoverFleetPeers(config.host, config.machines).pipe(
    Effect.mapError(
      (cause) =>
        new FleetOperationError({
          operation: "tailscale.status",
          detail: String(cause),
          cause
        })
    )
  )
  return peers.map((peer) => {
    const address = peer.ipv4 ?? undefined
    const approvalHub = peer.host.toLowerCase() ===
        config.approvalHub.host.toLowerCase() &&
      config.machines.some(
        (machine) =>
          machine.host.toLowerCase() === peer.host.toLowerCase() &&
          machine.nodeId === config.approvalHub.nodeId
      )
    return {
      host: peer.host,
      online: peer.online,
      approvalUrl: address === undefined
        ? null
        : approvalHub
        ? config.approvalHub.url
        : `http://${address}:${config.approvalPort}/`,
      pendingUrl: address === undefined
        ? null
        : `http://${address}:${config.port}/v1/pending-approvals`,
      connectAgentsUrl: address === undefined
        ? null
        : `http://${address}:${config.port}/v1/connect/agents/local`,
      terminalUrl: address === undefined
        ? null
        : `ws://${address}:${config.port}/v1/connect/terminal`
    } satisfies PeerTarget
  })
})

const pendingApproval = (record: JobRecord): PendingApproval => {
  const sanitized = sanitizeJobRecord(record)
  return {
    id: sanitized.id,
    createdAt: sanitized.createdAt,
    actor: sanitized.actor,
    approvalExpiresAt: sanitized.approvalExpiresAt ?? null,
    status: "pending_approval",
    payload: sanitized.payload
  }
}

const dashboardHistoryMaxBytes = 512 * 1024
export const dashboardSnapshotBytes = (snapshot: DashboardSnapshot): number =>
  new TextEncoder().encode(JSON.stringify(snapshot)).byteLength + 1

export const budgetDashboardSnapshot = Effect.fn(
  "HostHttp.budgetDashboardSnapshot"
)(function*(
  snapshot: DashboardSnapshot
) {
  const originalRecords = snapshot.records
  const records = [...originalRecords]
  while (
    records.length > 0 &&
    dashboardSnapshotBytes({ ...snapshot, records }) > fleetResponseBodyMaxBytes
  ) {
    records.pop()
  }
  const first = originalRecords.at(0)
  if (first !== undefined && records.length === 0) {
    return yield* new DashboardResponseBudgetError({
      encodedBytes: dashboardSnapshotBytes({
        ...snapshot,
        records: [first]
      }),
      maximumBytes: fleetResponseBodyMaxBytes
    })
  }
  const last = records.at(-1)
  const candidate = records.length === originalRecords.length
    ? snapshot
    : {
      ...snapshot,
      records,
      historyNextCursor: last === undefined
        ? snapshot.historyNextCursor
        : { createdAt: last.createdAt, id: last.id }
    }
  const encodedBytes = dashboardSnapshotBytes(candidate)
  if (encodedBytes > fleetResponseBodyMaxBytes) {
    return yield* new DashboardResponseBudgetError({
      encodedBytes,
      maximumBytes: fleetResponseBodyMaxBytes
    })
  }
  return candidate
})

const dashboardHistory = Effect.fn("HostHttp.dashboardHistory")(function*(
  service: FleetService,
  cursor: typeof PendingApprovalCursor.Type | null
) {
  const candidates = yield* service.historyAfter(cursor, 51)
  const records: Array<SanitizedJobRecord> = []
  for (const candidate of candidates.slice(0, 50)) {
    const projected = sanitizeJobRecord(candidate)
    const bytes = new TextEncoder().encode(
      JSON.stringify([...records, projected])
    ).byteLength
    if (bytes > dashboardHistoryMaxBytes) break
    records.push(projected)
  }
  const last = records.at(-1)
  return {
    records,
    nextCursor: records.length < candidates.length && last !== undefined
      ? { createdAt: last.createdAt, id: last.id }
      : null
  } satisfies DashboardHistoryPage
})

const localPendingSummary = Effect.fn("HostHttp.localPendingSummary")(
  function*(
    host: string,
    service: FleetService,
    cursor: typeof PendingApprovalCursor.Type | null
  ) {
    const page = yield* service.pendingApprovalPage(cursor)
    return {
      host,
      approvals: page.records.map(pendingApproval),
      nextCursor: page.nextCursor
    } satisfies PendingApprovalSummary
  }
)

const decodePendingApprovalCursor = Effect.fn(
  "HostHttp.decodePendingApprovalCursor"
)(function*(url: URL) {
  const createdAt = url.searchParams.get("cursorCreatedAt")
  const id = url.searchParams.get("cursorId")
  if (createdAt === null && id === null) return null
  if (createdAt === null || id === null) {
    return yield* new FleetValidationError({
      detail: "pending approval cursor requires cursorCreatedAt and cursorId"
    })
  }
  return yield* Schema.decodeUnknownEffect(PendingApprovalCursor)({
    createdAt: Number(createdAt),
    id
  }).pipe(
    Effect.mapError(
      () => new FleetValidationError({ detail: "invalid pending approval cursor" })
    )
  )
})

const decodePendingApprovalContinuation = Effect.fn(
  "HostHttp.decodePendingApprovalContinuation"
)(function*(url: URL) {
  const host = url.searchParams.get("cursorHost")
  const cursor = yield* decodePendingApprovalCursor(url)
  if (host === null || cursor === null) {
    return yield* new FleetValidationError({
      detail: "dashboard pending continuation requires cursorHost, cursorCreatedAt and cursorId"
    })
  }
  return yield* Schema.decodeUnknownEffect(PendingApprovalContinuation)({
    host,
    cursor
  }).pipe(
    Effect.mapError(
      () => new FleetValidationError({ detail: "invalid dashboard pending continuation" })
    )
  )
})

const decodeConnectAgentCursor = Effect.fn(
  "HostHttp.decodeConnectAgentCursor"
)(function*(url: URL) {
  const host = url.searchParams.get("cursorHost")
  const id = url.searchParams.get("cursorId")
  if (host === null && id === null) return null
  if (host === null || id === null) {
    return yield* new FleetValidationError({
      detail: "Connect agent cursor requires cursorHost and cursorId"
    })
  }
  return yield* Schema.decodeUnknownEffect(ConnectAgentCursor)({ host, id }).pipe(
    Effect.mapError(
      () => new FleetValidationError({ detail: "invalid Connect agent cursor" })
    )
  )
})

const fetchPeerPending = Effect.fn("HostHttp.fetchPeerPending")(
  function*(
    peer: PeerTarget,
    cursor: typeof PendingApprovalCursor.Type | null
  ) {
    const pendingUrl = peer.pendingUrl
    if (pendingUrl === null || peer.approvalUrl === null) {
      return yield* new PeerPendingUnavailableError({
        host: peer.host,
        reason: "unavailable"
      })
    }
    if (!peer.online) {
      return yield* new PeerPendingUnavailableError({
        host: peer.host,
        reason: "offline"
      })
    }
    const client = yield* HttpClient.HttpClient
    const pageUrl = new URL(pendingUrl)
    if (cursor !== null) {
      pageUrl.searchParams.set("cursorCreatedAt", String(cursor.createdAt))
      pageUrl.searchParams.set("cursorId", cursor.id)
    }
    const response = yield* client.get(pageUrl.toString()).pipe(
      Effect.mapError(
        (cause) =>
          new PeerPendingTransportError({
            host: peer.host,
            detail: String(cause),
            cause
          })
      )
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* new PeerPendingStatusError({
        host: peer.host,
        status: response.status
      })
    }
    const summary = yield* decodeBoundedResponseJson(
      response,
      PendingApprovalSummary
    ).pipe(
      Effect.mapError(
        (cause) =>
          new PeerPendingDecodeError({
            host: peer.host,
            detail: String(cause),
            cause
          })
      )
    )
    if (summary.host.toLowerCase() !== peer.host.toLowerCase()) {
      return yield* new PeerPendingHostMismatchError({
        expectedHost: peer.host,
        receivedHost: summary.host
      })
    }
    return summary
  },
  (effect, peer) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: peerPendingTimeoutMs,
        orElse: () =>
          Effect.fail(
            new PeerPendingTimeoutError({
              host: peer.host,
              timeoutMs: peerPendingTimeoutMs
            })
          )
      })
    )
)

const fetchAllPeerPending = Effect.fn("HostHttp.fetchAllPeerPending")(
  function*(peer: PeerTarget) {
    const approvals: Array<PendingApproval> = []
    const seen = new Set<string>()
    let cursor: typeof PendingApprovalCursor.Type | null = null
    do {
      const page: PendingApprovalSummary = yield* fetchPeerPending(peer, cursor)
      for (const approval of page.approvals) approvals.push(approval)
      cursor = page.nextCursor
      if (cursor !== null) {
        const key = `${cursor.createdAt}\u0000${cursor.id}`
        if (seen.has(key)) {
          return yield* new PeerPendingDecodeError({
            cause: key,
            detail: "peer repeated a pending approval cursor",
            host: peer.host
          })
        }
        seen.add(key)
      }
    } while (cursor !== null)
    return { approvals, host: peer.host, nextCursor: null } satisfies PendingApprovalSummary
  }
)

const pendingFailureReason = (
  error: PeerPendingError
): PendingApprovalFailure["reason"] => {
  switch (error._tag) {
    case "PeerPendingUnavailableError":
      return error.reason
    case "PeerPendingTimeoutError":
      return "timeout"
    case "PeerPendingDecodeError":
    case "PeerPendingHostMismatchError":
      return "invalid_response"
    case "PeerPendingStatusError":
    case "PeerPendingTransportError":
      return "request_failed"
  }
}

const aggregatePeerPending = Effect.fn("HostHttp.aggregatePeerPending")(
  function*(
    peers: ReadonlyArray<PeerTarget>,
    pagination: "first" | "all" = "first"
  ) {
    const results = yield* Effect.all(
      peers.map((peer) =>
        Effect.result(
          pagination === "all"
            ? fetchAllPeerPending(peer)
            : fetchPeerPending(peer, null)
        ).pipe(
          Effect.map((result) => ({ peer, result }))
        )
      ),
      { concurrency: 4 }
    )
    const remote: Array<{
      readonly host: string
      readonly approvalUrl: string
      readonly approval: PendingApproval
    }> = []
    const failures: Array<PendingApprovalFailure> = []
    const nextCursors: Array<
      DashboardSnapshot["pendingApprovals"]["nextCursors"][number]
    > = []
    for (const { peer, result } of results) {
      if (Result.isFailure(result)) {
        failures.push({
          host: peer.host,
          reason: pendingFailureReason(result.failure)
        })
        continue
      }
      if (peer.approvalUrl === null) {
        failures.push({ host: peer.host, reason: "unavailable" })
        continue
      }
      for (const approval of result.success.approvals) {
        remote.push({
          host: peer.host,
          approvalUrl: peer.approvalUrl,
          approval
        })
      }
      if (result.success.nextCursor !== null) {
        nextCursors.push({ host: peer.host, cursor: result.success.nextCursor })
      }
    }
    return { remote, failures, nextCursors }
  }
)

const dashboardPendingPage = Effect.fn("HostHttp.dashboardPendingPage")(
  function*(
    config: HostConfiguration,
    service: FleetService,
    continuation: DashboardSnapshot["pendingApprovals"]["nextCursors"][number],
    issueApprovalProofs: ApprovalProofIssuer
  ) {
    if (continuation.host.toLowerCase() === config.host.toLowerCase()) {
      const page = yield* service.pendingApprovalPage(continuation.cursor)
      yield* issueApprovalProofs(page.records)
      return {
        local: page.records.map(sanitizeJobRecord),
        remote: [],
        failures: [],
        nextCursors: page.nextCursor === null
          ? []
          : [{ host: config.host, cursor: page.nextCursor }]
      } satisfies DashboardSnapshot["pendingApprovals"]
    }
    const peers = yield* fleetPeers(config)
    const peer = peers.find(
      ({ host }) => host.toLowerCase() === continuation.host.toLowerCase()
    )
    if (peer === undefined || peer.approvalUrl === null) {
      return yield* new FleetValidationError({
        detail: `unknown pending approval host ${continuation.host}`
      })
    }
    const approvalUrl = peer.approvalUrl
    const page = yield* fetchPeerPending(peer, continuation.cursor).pipe(
      Effect.mapError(
        (cause) =>
          new FleetOperationError({
            cause,
            detail: `could not continue pending approvals on ${peer.host}`,
            operation: "fleet.pending_approvals"
          })
      )
    )
    return {
      local: [],
      remote: page.approvals.map((approval) => ({
        approval,
        approvalUrl,
        host: peer.host
      })),
      failures: [],
      nextCursors: page.nextCursor === null
        ? []
        : [{ host: peer.host, cursor: page.nextCursor }]
    } satisfies DashboardSnapshot["pendingApprovals"]
  }
)

const resolvePendingApprovalTarget = Effect.fn(
  "HostHttp.resolvePendingApprovalTarget"
)(function*(
  config: HostConfiguration,
  service: FleetService,
  target: ApprovalNotificationCandidateType,
  issueApprovalProofs: ApprovalProofIssuer
) {
  if (target.host.toLowerCase() === config.host.toLowerCase()) {
    const record = yield* service.get(target.jobId)
    if (record.status !== "pending_approval") {
      return yield* new FleetJobNotFoundError({ jobId: target.jobId })
    }
    yield* issueApprovalProofs([record])
    return { _tag: "local", record: sanitizeJobRecord(record) } satisfies PendingApprovalTarget
  }
  const peers = yield* fleetPeers(config)
  const peer = peers.find(
    ({ host }) => host.toLowerCase() === target.host.toLowerCase()
  )
  if (peer === undefined || peer.approvalUrl === null) {
    return yield* new FleetJobNotFoundError({ jobId: target.jobId })
  }
  const seen = new Set<string>()
  let cursor: typeof PendingApprovalCursor.Type | null = null
  do {
    const page: PendingApprovalSummary = yield* fetchPeerPending(peer, cursor).pipe(
      Effect.mapError(
        (cause) =>
          new FleetOperationError({
            cause,
            detail: `could not resolve pending approval on ${peer.host}`,
            operation: "fleet.pending_approval_target"
          })
      )
    )
    const approval = page.approvals.find(({ id }) => id === target.jobId)
    if (approval !== undefined) {
      return {
        _tag: "remote",
        remote: { approval, approvalUrl: peer.approvalUrl, host: peer.host }
      } satisfies PendingApprovalTarget
    }
    cursor = page.nextCursor
    if (cursor !== null) {
      const key = `${cursor.createdAt}\u0000${cursor.id}`
      if (seen.has(key)) {
        return yield* new FleetOperationError({
          cause: key,
          detail: `peer ${peer.host} repeated a pending approval cursor`,
          operation: "fleet.pending_approval_target"
        })
      }
      seen.add(key)
    }
  } while (cursor !== null)
  return yield* new FleetJobNotFoundError({ jobId: target.jobId })
})

export const notificationCandidates = Effect.fn(
  "HostHttp.notificationCandidates"
)(function*(config: HostConfiguration, service: FleetService) {
  const local = yield* service.pendingApprovals()
  const localCandidates = local.map(
    (record): ApprovalNotificationCandidate => ({
      host: config.host,
      jobId: record.id
    })
  )
  const peers = yield* Effect.result(fleetPeers(config))
  if (Result.isFailure(peers)) {
    yield* Effect.logWarning(
      "PushWorker.peer_directory_unavailable",
      peers.failure
    )
    return {
      candidates: localCandidates,
      pendingCount: null
    } satisfies ApprovalNotificationBatch
  }
  const aggregated = yield* aggregatePeerPending(peers.success, "all")
  if (aggregated.failures.length > 0) {
    yield* Effect.logWarning(
      "PushWorker.peer_pending_partial_failure",
      aggregated.failures
    )
  }
  const candidates = [
    ...localCandidates,
    ...aggregated.remote.map(
      (remote): ApprovalNotificationCandidate => ({
        host: remote.host,
        jobId: remote.approval.id
      })
    )
  ]
  return {
    candidates,
    pendingCount: aggregated.failures.length === 0 ? candidates.length : null
  } satisfies ApprovalNotificationBatch
})

const dashboardPage = (snapshot: DashboardSnapshot): string => {
  const markup = snapshot.approvalApp.canonical ? "" : renderToStaticMarkup(
    createElement(
      "div",
      { className: "dashboard-gesture" },
      createElement(DashboardView, {
        busyJobId: null,
        chatBusy: false,
        notificationState: "loading",
        onChatSubmit: undefined,
        onDecision: () => undefined,
        onDisableNotifications: undefined,
        onEnableNotifications: undefined,
        onRefresh: () => undefined,
        pull: { distance: 0, ready: false, refreshing: false },
        snapshot
      })
    )
  )
  const data = JSON.stringify(snapshot).replaceAll("<", "\\u003c")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#111418">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Approvals">
<title>${dashboardDocumentTitle(snapshot.host)}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/assets/approval-icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/index.css">
</head>
<body data-rly-root data-rly-theme="dark">
<div id="fleet-dashboard-root">${markup}</div>
<script id="fleet-dashboard-data" type="application/json">${data}</script>
<script src="/assets/approval.js" defer></script>
</body>
</html>`
}

const connectPage = (): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0b0d10">
<title>Fleet connect</title>
<link rel="stylesheet" href="/assets/index.css">
</head>
<body data-rly-root data-rly-theme="dark" class="connect-body">
<div id="fleet-connect-root"></div>
<script src="/assets/connect.js" defer></script>
</body>
</html>`

const lanWorkDocument = (body: string): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#111418">
<title>Fleet Work</title>
<link rel="stylesheet" href="/assets/index.css">
</head>
<body data-rly-root data-rly-theme="dark">
${body}
</body>
</html>`

const lanPairPage = (error: string | undefined): string =>
  lanWorkDocument(renderToStaticMarkup(createElement(LanWorkPairPage, error === undefined ? {} : { error })))

const lanHtmlSecurityHeaders = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY"
}

const lanPairErrorMessage = (error: LanPairError): string => {
  switch (error._tag) {
    case "LanWorkOriginRejectedError":
      return "Open this page from the trusted LAN Work address."
    case "LanWorkPairingMalformedError":
      return "Enter the 64-character pairing code printed by Work."
    case "LanWorkPairingExpiredError":
      return "That pairing code expired. Ask Work for a new code."
    case "LanWorkPairingReplayedError":
      return "That pairing code was already used. Ask Work for a new code."
    case "LanWorkPairingRejectedError":
      return "That pairing code was not accepted. Check it and try again."
    case "LanWorkSessionRejectedError":
    case "LanWorkSessionRequiredError":
      return "Pair this browser before continuing."
    case "LanWorkCryptoError":
    case "LanWorkConfigurationError":
      return "LAN Work pairing is unavailable. Try again later."
  }
}

const lanWorkPage = (
  snapshots: WorkSnapshots,
  selection: { readonly goalId: string | null; readonly window: WorkSnapshotWindow }
): string => lanWorkDocument(renderToStaticMarkup(createElement(LanWorkPage, { ...selection, snapshots })))

const lanWorkSelectionFromUrl = Effect.fn("ApprovalHttp.decodeLanWorkSelection")(
  function*(url: URL) {
    const decoded = Schema.decodeUnknownResult(WorkSnapshotWindow)(url.searchParams.get("window") ?? "now")
    if (Result.isFailure(decoded)) {
      return yield* new LanWorkSelectionMalformedError({ detail: "LAN Work window selection is invalid" })
    }
    return { goalId: url.searchParams.get("goal"), window: decoded.success }
  }
)

const rejectUpgrade = (
  socket: Duplex,
  status: number
): void => {
  socket.end(
    `HTTP/1.1 ${status} ${
      status === 403 ? "Forbidden" : "Bad Request"
    }\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  )
}

const terminalSelectionFromUrl = (url: URL) =>
  Schema.decodeUnknownEffect(TerminalSelection)({
    host: url.searchParams.get("host"),
    agentId: url.searchParams.get("agent"),
    cols: Number(url.searchParams.get("cols")),
    rows: Number(url.searchParams.get("rows"))
  }).pipe(
    Effect.mapError(
      (cause) =>
        new FleetValidationError({
          detail: `invalid terminal selection: ${String(cause)}`
        })
    )
  )

const terminalCloseCode = (
  error:
    | TerminalAgentNotFoundError
    | TerminalBusyError
    | TerminalProtocolError
    | TerminalTransportError
): number => {
  switch (error._tag) {
    case "TerminalAgentNotFoundError":
      return 4404
    case "TerminalBusyError":
      return 4423
    case "TerminalProtocolError":
      return 4400
    case "TerminalTransportError":
      return 4503
  }
}

const readApproval = Effect.fn("ApprovalHttp.readApproval")(function*(
  request: IncomingMessage
) {
  const contentType = header(request, "content-type") ?? ""
  if (contentType.startsWith("application/json")) {
    const body = yield* readBody(request)
    if (body.trim() === "") return null
    const parsed = yield* Effect.try({
      try: () => JSON.parse(body),
      catch: (cause) =>
        new FleetValidationError({
          detail: `invalid approval JSON: ${String(cause)}`
        })
    })
    return yield* Schema.decodeUnknownEffect(Approval)(parsed).pipe(
      Effect.mapError(
        (error) =>
          new FleetValidationError({
            detail: `invalid approval: ${String(error)}`
          })
      )
    )
  }
  const body = yield* readBody(request)
  if (body.trim() === "") return null
  const form = new URLSearchParams(body)
  return yield* Schema.decodeUnknownEffect(Approval)({
    hash: form.get("hash"),
    nonce: form.get("nonce")
  }).pipe(
    Effect.mapError(
      (error) =>
        new FleetValidationError({
          detail: `invalid approval: ${String(error)}`
        })
    )
  )
})

const approvalFromProof = Effect.fn("ApprovalHttp.approvalFromProof")(function*(
  service: FleetService,
  proofs: Map<string, ApprovalProof>,
  request: IncomingMessage,
  jobId: string,
  currentTime: () => number
) {
  const token = cookieValue(request, approvalProofCookieName(jobId))
  if (token === undefined) {
    return yield* new FleetApprovalError({
      detail: "approval proof is required for a bodyless decision",
      jobId
    })
  }
  const proof = proofs.get(token)
  if (proof === undefined || proof.jobId !== jobId || proof.expiresAt <= currentTime()) {
    return yield* new FleetApprovalError({
      detail: "approval proof is invalid or expired",
      jobId
    })
  }
  proofs.delete(token)
  const record = yield* service.get(jobId)
  if (
    record.status !== "pending_approval" ||
    record.approvalNonce === null ||
    record.hash !== proof.hash ||
    record.approvalNonce !== proof.nonce
  ) {
    return yield* new FleetApprovalError({
      detail: "approval proof no longer matches the pending request",
      jobId
    })
  }
  return { hash: proof.hash, nonce: proof.nonce } satisfies Approval
})

export const makeRunner = Effect.fn("HostRunner.make")(function*(
  runJob: (jobId: string) => Effect.Effect<unknown, unknown>
): Effect.fn.Return<Runner> {
  const scope = yield* Scope.make()
  const serial = yield* Semaphore.make(1)
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
  let accepting = true

  const enqueue = (jobId: string): Promise<boolean> => {
    if (!accepting) return Promise.resolve(false)
    const run = serial.withPermits(1)(
      runJob(jobId).pipe(
        Effect.tapError((error) =>
          Effect.logError("HostRunner.job_failed", error).pipe(
            Effect.annotateLogs({ jobId })
          )
        ),
        Effect.ignore
      )
    )
    return runPromise(Effect.forkIn(run, scope)).then(() => true)
  }

  const close = async (): Promise<void> => {
    if (!accepting) return
    accepting = false
    await runPromise(Scope.close(scope, Exit.void))
  }

  return { close, enqueue }
})

export const startHttpServer = async (
  config: HostConfiguration,
  service: FleetService,
  uiAssets: UiAssets,
  options: HttpServerOptions = {}
): Promise<{
  readonly close: () => Promise<void>
  readonly url: string
  readonly tailnetUrl: string | null
  readonly approvalUrl: string | null
  readonly serveUrl: string | null
  readonly workUrl: string | null
  readonly lanWorkUrl: string | null
  readonly lanWorkPairingCode: Redacted.Redacted<string> | null
}> => {
  const isHub = config.crossHost &&
    config.host.toLowerCase() === config.approvalHub.host.toLowerCase()
  const workBindAddress = config.workBindAddress ?? "127.0.0.1"
  const approvalTls = config.approvalTls
  if (isHub && approvalTls === null) {
    throw new FleetValidationError({
      detail: "approval hub requires direct TLS certificate and private key paths"
    })
  }
  const configuredTailscale = tailscaleLayer(config.tailscaleCommand).pipe(
    Layer.provide(NodeServices.layer)
  )
  const httpRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      NodeServices.layer,
      NodeHttpClient.layerNodeHttp,
      configuredTailscale
    )
  )
  const activeServers = new Set<
    ReturnType<typeof createServer> | ReturnType<typeof createSecureServer>
  >()
  const activeHttpSockets = new Set<Duplex>()
  const activeRequestControllers = new Set<AbortController>()
  const terminalControllers = new Set<string>()
  const terminalTasks = new Set<Promise<void>>()
  const webSockets = new Set<WebSocketClient>()
  const finalizers: Array<() => Promise<void>> = [
    () => httpRuntime.dispose()
  ]
  let acceptingRequests = false
  let closed = false
  const runRequest = <A, E>(
    effect: Effect.Effect<A, E, HttpClient.HttpClient | Tailscale | Crypto.Crypto>
  ): Promise<A> => {
    const controller = new AbortController()
    activeRequestControllers.add(controller)
    return httpRuntime.runPromise(effect, { signal: controller.signal }).finally(
      () => activeRequestControllers.delete(controller)
    )
  }
  const shutdown = async (): Promise<void> => {
    if (closed) return
    closed = true
    acceptingRequests = false
    for (const controller of activeRequestControllers) controller.abort()
    for (const socket of webSockets) socket.terminate()
    for (const socket of activeHttpSockets) socket.destroy()
    const failures: Array<unknown> = []
    const serverResults = await Promise.allSettled(
      [...activeServers].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => error === undefined ? resolve() : reject(error))
          })
      )
    )
    for (const result of serverResults) {
      if (result.status === "rejected") failures.push(result.reason)
    }
    for (const socket of webSockets) socket.terminate()
    const terminalResults = await Promise.allSettled(terminalTasks)
    for (const result of terminalResults) {
      if (result.status === "rejected") failures.push(result.reason)
    }
    for (const finalize of finalizers) {
      try {
        await finalize()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "hostd cleanup failed")
    }
  }

  try {
    const tlsCredentials = isHub && approvalTls !== null
      ? await httpRuntime.runPromise(
        Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem
          const read = (path: string, operation: string) =>
            fileSystem.readFileString(path).pipe(
              Effect.mapError(
                (cause) =>
                  new FleetOperationError({
                    cause,
                    detail: `cannot read approval TLS material at ${path}`,
                    operation
                  })
              )
            )
          return {
            certificate: yield* read(
              approvalTls.certificatePath,
              "hostd.approval_tls.read_certificate"
            ),
            privateKey: yield* read(
              approvalTls.privateKeyPath,
              "hostd.approval_tls.read_private_key"
            )
          }
        })
      )
      : null
    const respond = async <A>(
      response: ServerResponse,
      effect: Effect.Effect<
        A,
        ApiError,
        HttpClient.HttpClient | Tailscale
      >,
      status = 200,
      headers: Readonly<Record<string, ResponseHeaderValue>> = {}
    ): Promise<void> => {
      const result = await runRequest(Effect.result(effect))
      if (Result.isSuccess(result)) {
        json(response, status, result.success, headers)
        return
      }
      const mapped = apiError(result.failure)
      json(response, mapped.status, mapped.body, headers)
    }
    const statePath = `${config.stateDirectory}/approval-app.sqlite`
    const approvalStore = await httpRuntime.runPromise(
      ApprovalAppStore.open(statePath)
    )
    finalizers.unshift(() => Promise.resolve().then(() => approvalStore.close()))
    const cryptoService = await httpRuntime.runPromise(Crypto.Crypto)
    const chatStore = await httpRuntime.runPromise(ChatStore.open(statePath))
    finalizers.unshift(() => Promise.resolve().then(() => chatStore.close()))
    const activityStore = await httpRuntime.runPromise(
      AgentActivityStore.open(statePath)
    )
    finalizers.unshift(() => Promise.resolve().then(() => activityStore.close()))
    const relationshipStore = await httpRuntime.runPromise(
      AgentRelationshipStore.open(statePath)
    )
    finalizers.unshift(() => Promise.resolve().then(() => relationshipStore.close()))
    const workStore = await httpRuntime.runPromise(WorkStore.open(statePath))
    finalizers.unshift(() => Promise.resolve().then(() => workStore.close()))
    const work = await httpRuntime.runPromise(makeWorkService(workStore))
    const now = options.now ?? (() => httpRuntime.runSync(Clock.currentTimeMillis))
    const approvalProofs = new Map<string, ApprovalProof>()
    const approvalProofTokensByJob = new Map<string, string>()
    const issueApprovalProofs: ApprovalProofIssuer = Effect.fn("ApprovalHttp.issueApprovalProofs")(
      function*(records: ReadonlyArray<JobRecord>) {
        const expiresAt = now() + approvalProofMaxAgeSeconds * 1_000
        for (const [token, proof] of approvalProofs) {
          if (proof.expiresAt <= now()) approvalProofs.delete(token)
        }
        for (const record of records) {
          if (record.status !== "pending_approval" || record.approvalNonce === null) continue
          const token = yield* cryptoService.randomUUIDv4.pipe(
            Effect.mapError(
              (cause) =>
                new FleetOperationError({
                  cause,
                  detail: "could not issue approval proof",
                  operation: "approval.proof"
                })
            )
          )
          approvalProofs.set(token, {
            expiresAt,
            hash: record.hash,
            jobId: record.id,
            nonce: record.approvalNonce
          })
          approvalProofTokensByJob.set(record.id, token)
        }
      }
    )
    const approvalProofHeaders = (
      records: ReadonlyArray<SanitizedJobRecord>
    ): Readonly<Record<string, ResponseHeaderValue>> => {
      const cookies = records.flatMap((record) => {
        const token = approvalProofTokensByJob.get(record.id)
        return token === undefined || !approvalProofs.has(token)
          ? []
          : [approvalProofCookie(record.id, token)]
      })
      return cookies.length === 0 ? {} : { "set-cookie": cookies }
    }
    if (options.lanWork !== undefined && config.allowedUsers.length === 0) {
      throw new LanWorkConfigurationError({
        detail: "LAN Work requires at least one configured allowed user"
      })
    }
    if (
      options.lanWork !== undefined &&
      (options.lanWork.address === "0.0.0.0" || options.lanWork.address === "::" ||
        options.lanWork.address === "::0") &&
      options.lanWork.host === undefined
    ) {
      throw new LanWorkConfigurationError({
        detail: "LAN Work wildcard listeners require an explicit browser host"
      })
    }
    let lanWorkPairing: LanWorkPairing | null = null
    const chat = await httpRuntime.runPromise(makeCoordinatorChat({
      config,
      fleet: service,
      store: chatStore
    }))
    const runJob = Effect.fn("HostRunner.runJob")(function*(jobId: string) {
      const record = yield* service.get(jobId)
      return yield* record.payload.kind === "agent.delegate" &&
          record.payload.channel === "coordinator_chat"
        ? chat.run(jobId)
        : service.run(jobId)
    })
    const runner = await Effect.runPromise(makeRunner(runJob))
    finalizers.unshift(() => runner.close())
    const enqueueJob = (jobId: string) =>
      Effect.promise(() => runner.enqueue(jobId)).pipe(
        Effect.flatMap((accepted) =>
          accepted
            ? Effect.void
            : Effect.fail(
              new FleetOperationError({
                cause: jobId,
                detail: "job runner is closed",
                operation: "hostd.runner.enqueue"
              })
            )
        )
      )
    const vapidKeys = isHub
      ? await Effect.runPromise(
        approvalStore.getOrCreateVapidKeys(generateVapidKeys)
      )
      : null
    const pushSender = vapidKeys === null
      ? null
      : (options.pushSender ??
        makePushSender(
          vapidKeys,
          config.pushSubject,
          approvalStore,
          config.pushAllowedOrigins
        ))
    const workerScope = await Effect.runPromise(Scope.make())
    finalizers.unshift(() => Effect.runPromise(Scope.close(workerScope, Exit.void)))
    const terminalConnector = options.terminalConnector ??
      (await httpRuntime.runPromise(makeHerdrTerminalConnector(config, service)))
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: terminalCommandMaxPayloadBytes,
      perMessageDeflate: false
    })

    const watchSocket = (socket: WebSocketClient): void => {
      let alive = true
      socket.on("error", () => socket.terminate())
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate()
          return
        }
        alive = false
        socket.ping()
      }, 25_000)
      heartbeat.unref()
      socket.on("pong", () => {
        alive = true
      })
      socket.once("close", () => clearInterval(heartbeat))
    }

    const closeSocket = (
      socket: WebSocketClient,
      code: number,
      reason: string
    ): void => {
      if (socket.readyState === WebSocketClient.OPEN) socket.close(code, reason)
    }

    const attachTerminal = async (
      socket: WebSocketClient,
      selection: typeof TerminalSelection.Type
    ): Promise<void> => {
      if (terminalControllers.size >= 4) {
        closeSocket(socket, 4429, "terminal connection limit reached")
        return
      }
      const key = `${selection.host.toLowerCase()}:${selection.agentId}`
      if (terminalControllers.has(key)) {
        closeSocket(socket, 4423, "agent already controlled")
        return
      }
      terminalControllers.add(key)
      const scope = await Effect.runPromise(Scope.make())
      let finalized = false
      let finalizePromise: Promise<void> | undefined
      let idleTimer: NodeJS.Timeout | undefined
      const finalize = async (): Promise<void> => {
        if (finalizePromise !== undefined) return finalizePromise
        finalized = true
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        finalizePromise = Effect.runPromise(
          Scope.close(scope, Exit.void)
        ).finally(() => terminalControllers.delete(key))
        return finalizePromise
      }
      const finalizeFromSocket = (): void => {
        void finalize().catch((error) =>
          Effect.runPromise(
            Effect.logError("HostHttp.terminal_finalize_failed", error)
          )
        )
      }
      socket.once("close", finalizeFromSocket)
      socket.once("error", finalizeFromSocket)
      const openFiber = await Effect.runPromise(
        Effect.forkIn(
          Effect.result(Scope.provide(scope)(terminalConnector.open(selection))),
          scope
        )
      )
      const openExit = await Effect.runPromise(Fiber.await(openFiber))
      if (Exit.isFailure(openExit)) {
        await finalize()
        if (Cause.hasInterruptsOnly(openExit.cause)) return
        await Effect.runPromise(Effect.failCause(openExit.cause))
        return
      }
      const opened = openExit.value
      if (Result.isFailure(opened)) {
        await finalize()
        closeSocket(
          socket,
          terminalCloseCode(opened.failure),
          opened.failure._tag
        )
        return
      }
      if (finalized || socket.readyState !== WebSocketClient.OPEN) {
        await finalize()
        return
      }
      const session = opened.success
      const inputQueue = await Effect.runPromise(
        Queue.dropping<typeof TerminalClientCommand.Type>(64)
      )
      const inputLoop = Stream.fromQueue(inputQueue).pipe(
        Stream.runForEach(session.send),
        Effect.catch((error) => Effect.sync(() => closeSocket(socket, terminalCloseCode(error), error._tag)))
      )
      await Effect.runPromise(Effect.forkIn(inputLoop, scope))
      const resetIdle = (): void => {
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        idleTimer = setTimeout(
          () => closeSocket(socket, 4408, "terminal idle timeout"),
          30 * 60 * 1_000
        )
        idleTimer.unref()
      }
      resetIdle()
      const readySignal = JSON.stringify(
        Schema.decodeUnknownSync(TerminalServerSignal)({
          type: "terminal.ready"
        })
      )
      setImmediate(() => {
        if (socket.readyState === WebSocketClient.OPEN) socket.send(readySignal)
      })
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          closeSocket(socket, 4400, "binary client frames are forbidden")
          return
        }
        resetIdle()
        try {
          const command = Schema.decodeUnknownSync(TerminalClientCommand)(
            JSON.parse(data.toString())
          )
          if (!Queue.offerUnsafe(inputQueue, command)) {
            closeSocket(socket, 4429, "terminal input queue limit reached")
          }
        } catch {
          closeSocket(socket, 4400, "invalid terminal command")
        }
      })
      const eventLoop = Stream.runForEach(session.events, (event) =>
        Effect.sync(() => {
          if (socket.readyState !== WebSocketClient.OPEN) return
          if (event.type === "terminal.frame") {
            const payload = Buffer.from(event.bytes, "base64")
            if (!terminalBufferCanAccept(socket.bufferedAmount, payload.byteLength)) {
              closeSocket(socket, 4429, "terminal output backpressure limit hit")
              return
            }
            socket.send(payload, { binary: true })
          } else {
            const payload = JSON.stringify(
              Schema.decodeUnknownSync(TerminalServerSignal)({
                type: "terminal.closed",
                reason: "terminal ended"
              })
            )
            if (!terminalBufferCanAccept(socket.bufferedAmount, Buffer.byteLength(payload))) {
              closeSocket(socket, 4429, "terminal output backpressure limit hit")
              return
            }
            socket.send(payload)
            closeSocket(socket, 1000, "terminal closed")
          }
        })).pipe(
          Effect.tap(() => Effect.sync(() => closeSocket(socket, 1000, "terminal ended"))),
          Effect.catch((error) => Effect.sync(() => closeSocket(socket, terminalCloseCode(error), error._tag)))
        )
      const eventFiber = await Effect.runPromise(
        Effect.forkIn(eventLoop, scope)
      )
      await Effect.runPromise(Fiber.await(eventFiber))
      await finalize()
    }

    const proxyTerminal = async (
      socket: WebSocketClient,
      selection: typeof TerminalSelection.Type
    ): Promise<void> => {
      const peers = await httpRuntime.runPromise(fleetPeers(config))
      const peer = peers.find(
        (candidate) => candidate.host.toLowerCase() === selection.host.toLowerCase()
      )
      if (peer?.terminalUrl === null || peer?.terminalUrl === undefined) {
        closeSocket(socket, 4404, "host unavailable")
        return
      }
      const remoteUrl = new URL(peer.terminalUrl)
      remoteUrl.searchParams.set("host", selection.host)
      remoteUrl.searchParams.set("agent", selection.agentId)
      remoteUrl.searchParams.set("cols", String(selection.cols))
      remoteUrl.searchParams.set("rows", String(selection.rows))
      const remote = new WebSocketClient(remoteUrl, {
        headers: { host: remoteUrl.host },
        maxPayload: terminalFrameMaxPayload,
        perMessageDeflate: false
      })
      const closed = new Promise<void>((resolve) => remote.once("close", () => resolve()))
      webSockets.add(remote)
      const connectTimeout = setTimeout(() => {
        remote.terminate()
        closeSocket(socket, 4408, "remote terminal connection timeout")
      }, 5_000)
      connectTimeout.unref()
      remote.once("open", () => {
        clearTimeout(connectTimeout)
        watchSocket(remote)
        socket.on("message", (data, isBinary) => {
          if (isBinary || remote.readyState !== WebSocketClient.OPEN) {
            closeSocket(socket, 4400, "invalid terminal command")
            return
          }
          try {
            const decoded = Schema.decodeUnknownSync(TerminalClientCommand)(
              JSON.parse(data.toString())
            )
            const encoded = JSON.stringify(decoded)
            if (
              !terminalBufferCanAccept(
                remote.bufferedAmount,
                Buffer.byteLength(encoded)
              )
            ) {
              closeSocket(socket, 4429, "remote input backpressure limit hit")
              remote.close(4429, "remote input backpressure limit hit")
              return
            }
            remote.send(encoded)
          } catch {
            closeSocket(socket, 4400, "invalid terminal command")
          }
        })
      })
      remote.on("message", (data, isBinary) => {
        if (socket.readyState === WebSocketClient.OPEN) {
          const payloadBytes = Array.isArray(data)
            ? data.reduce((bytes, part) => bytes + part.byteLength, 0)
            : data.byteLength
          if (!terminalBufferCanAccept(socket.bufferedAmount, payloadBytes)) {
            closeSocket(socket, 4429, "terminal output backpressure limit hit")
            if (remote.readyState === WebSocketClient.OPEN) {
              remote.close(4429, "browser backpressure limit hit")
            }
            return
          }
          socket.send(data, { binary: isBinary })
        }
      })
      remote.once("unexpected-response", (_request, response) => {
        clearTimeout(connectTimeout)
        response.resume()
        closeSocket(socket, 4403, "remote host rejected connection")
        remote.terminate()
      })
      remote.once("error", () => {
        clearTimeout(connectTimeout)
        closeSocket(socket, 4503, "remote host unavailable")
      })
      remote.once("close", (code, reason) => {
        clearTimeout(connectTimeout)
        webSockets.delete(remote)
        const relayedCode = relayTerminalCloseCode(code)
        closeSocket(
          socket,
          relayedCode,
          relayedCode === code
            ? reason.toString()
            : "remote terminal closed abnormally"
        )
      })
      socket.once("close", () => {
        webSockets.delete(remote)
        if (remote.readyState === WebSocketClient.CONNECTING) {
          remote.terminate()
        } else if (remote.readyState === WebSocketClient.OPEN) {
          remote.close(1000, "browser disconnected")
        }
      })
      await closed
    }

    const listen = async (
      address: string,
      port: number,
      mode: ListenerMode,
      tls: TlsCredentials | null = null
    ) => {
      let expectedHost = mode === "serve"
        ? new URL(config.approvalHub.url).host.toLowerCase()
        : mode === "lan" && options.lanWork?.host !== undefined
        ? options.lanWork.host.toLowerCase()
        : ""
      const expectedOrigin = (): string =>
        mode === "serve"
          ? new URL(config.approvalHub.url).origin
          : `http://${expectedHost}`
      const requestHandler = async (
        request: IncomingMessage,
        response: ServerResponse
      ) => {
        try {
          const url = pathOf(request)
          const workRoute = (request.method === "GET" && url.pathname === workSnapshotPath) ||
            (request.method === "POST" && url.pathname === workCheckpointPath)
          if (mode === "work" && !workRoute) {
            json(response, 404, { error: "not_found" })
            return
          }
          if (header(request, "host")?.toLowerCase() !== expectedHost) {
            json(response, 403, {
              error: "FleetAuthorizationError",
              actor: "host"
            })
            return
          }
          if (!acceptingRequests) {
            json(response, 503, { error: "starting" })
            return
          }
          if (request.method === "GET" && url.pathname === "/assets/index.css") {
            response.writeHead(200, {
              "cache-control": "no-cache, must-revalidate",
              "content-type": "text/css; charset=utf-8"
            })
            response.end(uiAssets.stylesheet)
            return
          }
          if (
            mode !== "lan" &&
            request.method === "GET" &&
            url.pathname === "/assets/approval.js"
          ) {
            response.writeHead(200, {
              "cache-control": "no-cache, must-revalidate",
              "content-type": "text/javascript; charset=utf-8"
            })
            response.end(uiAssets.script)
            return
          }
          if (mode !== "lan" && request.method === "GET" && url.pathname === "/assets/connect.js") {
            response.writeHead(200, {
              "cache-control": "no-cache, must-revalidate",
              "content-type": "text/javascript; charset=utf-8"
            })
            response.end(uiAssets.connectScript)
            return
          }
          if (
            mode !== "lan" &&
            request.method === "GET" &&
            url.pathname === "/assets/approval-sw.js"
          ) {
            response.writeHead(200, {
              "cache-control": "no-cache, must-revalidate",
              "content-type": "text/javascript; charset=utf-8",
              "service-worker-allowed": "/"
            })
            response.end(uiAssets.worker)
            return
          }
          if (
            mode !== "lan" &&
            request.method === "GET" &&
            url.pathname === "/manifest.webmanifest"
          ) {
            response.writeHead(200, {
              "cache-control": "no-cache, must-revalidate",
              "content-type": "application/manifest+json; charset=utf-8"
            })
            response.end(approvalManifest)
            return
          }
          if (
            mode !== "lan" &&
            request.method === "GET" &&
            url.pathname === "/assets/approval-icon.svg"
          ) {
            response.writeHead(200, {
              "cache-control": "no-cache, must-revalidate",
              "content-type": "image/svg+xml; charset=utf-8"
            })
            response.end(approvalIcon)
            return
          }
          const fontMatch = /^\/assets\/([^/]+\.woff2)$/.exec(url.pathname)
          const font = fontMatch?.[1] === undefined
            ? undefined
            : uiAssets.fonts.get(fontMatch[1])
          if (request.method === "GET" && font !== undefined) {
            response.writeHead(200, {
              "cache-control": "public, max-age=31536000, immutable",
              "content-type": "font/woff2"
            })
            response.end(font)
            return
          }
          if (mode === "lan" && lanWorkPairing !== null) {
            const pairing = lanWorkPairing
            const origin = header(request, "origin")
            const requireLanOrigin = (required: boolean): Effect.Effect<void, LanWorkOriginRejectedError> =>
              (origin === expectedOrigin() || (!required && origin === undefined))
                ? Effect.void
                : Effect.fail(
                  new LanWorkOriginRejectedError({
                    detail: "LAN Work requires the exact browser origin"
                  })
                )
            const authorizeLanSession = pairing.authorizeSession(
              readLanWorkSessionCookie(header(request, "cookie"))
            )
            const readPairRequest = Effect.fn("ApprovalHttp.readLanPairRequest")(function*() {
              const mediaType = (header(request, "content-type") ?? "")
                .split(";", 1)[0]
                ?.trim()
                .toLowerCase()
              const body = yield* readBody(request).pipe(
                Effect.mapError(
                  (error) => new LanWorkPairingMalformedError({ detail: error.detail })
                )
              )
              if (mediaType === "application/json") {
                const unknown = yield* Effect.try({
                  try: () => JSON.parse(body),
                  catch: (cause) =>
                    new LanWorkPairingMalformedError({
                      detail: `invalid LAN Work pairing JSON: ${String(cause)}`
                    })
                })
                const input = yield* Schema.decodeUnknownEffect(LanWorkPairRequestInput)(unknown).pipe(
                  Effect.mapError(
                    (cause) =>
                      new LanWorkPairingMalformedError({
                        detail: `invalid LAN Work pairing object: ${String(cause)}`
                      })
                  )
                )
                return yield* decodeLanWorkPairRequest(input)
              }
              if (mediaType === "application/x-www-form-urlencoded") {
                const form = new URLSearchParams(body)
                const values = form.getAll("pairingCode")
                if (values.length !== 1) {
                  return yield* new LanWorkPairingMalformedError({
                    detail: "LAN Work pairing request requires one pairingCode"
                  })
                }
                const input = yield* Schema.decodeUnknownEffect(LanWorkPairRequestInput)({ pairingCode: values[0] })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new LanWorkPairingMalformedError({
                          detail: `invalid LAN Work pairing object: ${String(cause)}`
                        })
                    )
                  )
                return yield* decodeLanWorkPairRequest(input)
              }
              return yield* new LanWorkPairingMalformedError({
                detail: "LAN Work pairing content type is unsupported"
              })
            })
            const pairFailure = (error: LanPairError): void => {
              const mapped = apiError(error)
              const acceptsHtml = (header(request, "accept") ?? "").includes("text/html")
              if (acceptsHtml) {
                response.writeHead(mapped.status, {
                  "cache-control": "no-store",
                  "content-type": "text/html; charset=utf-8",
                  ...lanHtmlSecurityHeaders
                })
                response.end(lanPairPage(lanPairErrorMessage(error)))
              } else {
                json(response, mapped.status, mapped.body)
              }
            }
            if (request.method === "GET" && url.pathname === "/pair") {
              if (origin !== undefined && origin !== expectedOrigin()) {
                pairFailure(new LanWorkOriginRejectedError({ detail: "LAN Work requires the exact browser origin" }))
                return
              }
              if (url.search !== "") {
                pairFailure(new LanWorkPairingMalformedError({ detail: "LAN Work pairing URL must be plain /pair" }))
                return
              }
              const session = await runRequest(Effect.result(authorizeLanSession))
              if (Result.isSuccess(session)) {
                response.writeHead(303, { location: "/" })
                response.end()
              } else {
                response.writeHead(200, {
                  "cache-control": "no-store",
                  "content-type": "text/html; charset=utf-8",
                  ...lanHtmlSecurityHeaders
                })
                response.end(lanPairPage(undefined))
              }
              return
            }
            if (request.method === "POST" && url.pathname === "/pair") {
              const result = await runRequest(
                Effect.result(
                  Effect.gen(function*() {
                    yield* requireLanOrigin(true)
                    if (url.search !== "") {
                      return yield* new LanWorkPairingMalformedError({
                        detail: "LAN Work pairing URL must be plain /pair"
                      })
                    }
                    const requestBody = yield* readPairRequest()
                    return yield* pairing.consume(requestBody.pairingCode)
                  })
                )
              )
              if (Result.isFailure(result)) {
                pairFailure(result.failure)
              } else {
                response.writeHead(303, {
                  "cache-control": "no-store",
                  location: "/",
                  "set-cookie": lanWorkSessionCookie(result.success)
                })
                response.end()
              }
              return
            }
            if (request.method === "GET" && url.pathname === "/") {
              const selection = await runRequest(Effect.result(lanWorkSelectionFromUrl(url)))
              if (Result.isFailure(selection)) {
                const mapped = apiError(selection.failure)
                json(response, mapped.status, mapped.body)
                return
              }
              const result = await runRequest(
                Effect.result(
                  requireLanOrigin(false).pipe(
                    Effect.andThen(authorizeLanSession),
                    Effect.andThen(work.snapshots(now()))
                  )
                )
              )
              if (Result.isSuccess(result)) {
                response.writeHead(200, {
                  "cache-control": "no-store",
                  "content-type": "text/html; charset=utf-8",
                  ...lanHtmlSecurityHeaders
                })
                response.end(lanWorkPage(result.success, selection.success))
              } else if (
                result.failure._tag === "LanWorkSessionRequiredError" ||
                result.failure._tag === "LanWorkSessionRejectedError"
              ) {
                response.writeHead(303, { location: "/pair" })
                response.end()
              } else {
                const mapped = apiError(result.failure)
                json(response, mapped.status, mapped.body)
              }
              return
            }
            if (request.method === "GET" && url.pathname === workSnapshotPath) {
              await respond(
                response,
                requireLanOrigin(true).pipe(
                  Effect.andThen(authorizeLanSession),
                  Effect.andThen(work.snapshots(now()))
                ),
                200,
                { "cache-control": "no-store" }
              )
              return
            }
            json(response, 404, { error: "not_found" })
            return
          }
          const authorized = mode === "approval"
            ? tailnetActor(request, config, config.approvalNodes)
            : mode === "tailnet" || mode === "serve"
            ? tailnetActor(request, config, null)
            : actor(request, config, true)
          const loopbackAuthorized = authorizeLoopback({
            login: header(request, "tailscale-user-login"),
            remoteAddress: request.socket.remoteAddress
          })

          const approvalSurface = mode === "approval" || mode === "serve"
          const dashboard = Effect.gen(function*() {
            const observedAt = now()
            const resolvedLocalPage = approvalSurface
              ? yield* service.pendingApprovalPage(null)
              : { records: [], nextCursor: null }
            if (approvalSurface) yield* issueApprovalProofs(resolvedLocalPage.records)
            const state = yield* Effect.all({
              history: dashboardHistory(service, null),
              status: service.status()
            })
            let directory: ApprovalDirectory | null = null
            let pendingApprovals: DashboardSnapshot["pendingApprovals"] = {
              local: approvalSurface
                ? resolvedLocalPage.records.map(sanitizeJobRecord)
                : state.history.records.filter(
                  (record) => record.status === "pending_approval"
                ),
              remote: [],
              failures: [],
              nextCursors: approvalSurface && resolvedLocalPage.nextCursor !== null
                ? [{ host: config.host, cursor: resolvedLocalPage.nextCursor }]
                : []
            }
            if (approvalSurface) {
              const currentUrl = mode === "serve"
                ? config.approvalHub.url
                : `http://${expectedHost}/`
              const peersResult = yield* Effect.result(fleetPeers(config))
              directory = Result.isSuccess(peersResult)
                ? {
                  currentUrl,
                  links: peersResult.success.map((peer) => ({
                    host: peer.host,
                    online: peer.online,
                    url: peer.approvalUrl
                  })),
                  error: null
                }
                : {
                  currentUrl,
                  links: [],
                  error: peersResult.failure.detail
                }
              if (Result.isSuccess(peersResult)) {
                const aggregated = yield* aggregatePeerPending(
                  peersResult.success
                )
                pendingApprovals = {
                  local: resolvedLocalPage.records.map(sanitizeJobRecord),
                  ...aggregated,
                  nextCursors: resolvedLocalPage.nextCursor === null
                    ? aggregated.nextCursors
                    : [
                      { host: config.host, cursor: resolvedLocalPage.nextCursor },
                      ...aggregated.nextCursors
                    ]
                }
              } else {
                pendingApprovals = {
                  local: resolvedLocalPage.records.map(sanitizeJobRecord),
                  remote: [],
                  nextCursors: resolvedLocalPage.nextCursor === null
                    ? []
                    : [{ host: config.host, cursor: resolvedLocalPage.nextCursor }],
                  failures: config.machines
                    .filter(
                      ({ host }) => host.toLowerCase() !== config.host.toLowerCase()
                    )
                    .map(
                      ({ host }): PendingApprovalFailure => ({
                        host,
                        reason: "unavailable"
                      })
                    )
                }
              }
            }
            return yield* budgetDashboardSnapshot(
              {
                host: config.host,
                observedAt,
                approvalsEnabled: approvalSurface,
                approvalApp: {
                  canonical: mode === "serve",
                  canonicalUrl: config.approvalHub.url,
                  chatEnabled: mode === "serve",
                  pushEnabled: mode === "serve"
                },
                chat: null,
                work: null,
                status: state.status,
                records: state.history.records,
                historyNextCursor: state.history.nextCursor,
                directory,
                pendingApprovals
              } satisfies DashboardSnapshot
            )
          })

          if (request.method === "GET" && url.pathname === "/v1/dashboard") {
            const result = await runRequest(Effect.result(Effect.andThen(authorized, dashboard)))
            if (Result.isFailure(result)) {
              const mapped = apiError(result.failure)
              json(response, mapped.status, mapped.body)
            } else {
              json(response, 200, result.success, approvalProofHeaders(result.success.pendingApprovals.local))
            }
            return
          }

          if (
            approvalSurface &&
            request.method === "GET" &&
            url.pathname === "/v1/dashboard-history"
          ) {
            const effect = Effect.gen(function*() {
              yield* authorized
              const cursor = yield* decodePendingApprovalCursor(url)
              return yield* dashboardHistory(service, cursor)
            })
            await respond(response, effect)
            return
          }

          if (
            approvalSurface &&
            request.method === "GET" &&
            url.pathname === "/v1/pending-approval"
          ) {
            const effect = Effect.gen(function*() {
              yield* authorized
              const target = yield* Schema.decodeUnknownEffect(
                ApprovalNotificationCandidate
              )({
                host: url.searchParams.get("host"),
                jobId: url.searchParams.get("jobId")
              }).pipe(
                Effect.mapError(
                  () =>
                    new FleetValidationError({
                      detail: "pending approval target requires valid host and jobId"
                    })
                )
              )
              return yield* resolvePendingApprovalTarget(
                config,
                service,
                target,
                issueApprovalProofs
              )
            })
            const result = await runRequest(Effect.result(effect))
            if (Result.isFailure(result)) {
              const mapped = apiError(result.failure)
              json(response, mapped.status, mapped.body)
            } else {
              const records = result.success._tag === "local" ? [result.success.record] : []
              json(response, 200, result.success, approvalProofHeaders(records))
            }
            return
          }

          const servesWork = mode === "serve" || mode === "work" || (mode === "local" && !config.crossHost)
          if (
            servesWork &&
            request.method === "GET" &&
            url.pathname === workSnapshotPath
          ) {
            const workAuthorization = mode === "work"
              ? Effect.succeed("lan")
              : mode === "local"
              ? loopbackAuthorized
              : authorized
            await respond(response, Effect.andThen(workAuthorization, work.snapshots(now())))
            return
          }

          if (
            servesWork &&
            request.method === "POST" &&
            url.pathname === workCheckpointPath
          ) {
            const workAuthorization = mode === "work"
              ? Effect.succeed("lan")
              : mode === "local"
              ? loopbackAuthorized
              : authorized
            const effect = Effect.gen(function*() {
              const approvalPage = mode === "work"
                ? undefined
                : yield* Effect.map(
                  Tailscale,
                  (tailscale) => (host: string) => resolveApprovalPage(config, tailscale, host)
                )
              return yield* recordWorkCheckpointRequest(
                workAuthorization,
                authorizeOriginlessMutation(request).pipe(
                  Effect.andThen(readJson(request, WorkGoalCheckpoint))
                ),
                work,
                approvalPage
              )
            })
            await respond(response, effect, 201)
            return
          }

          if (
            mode === "serve" &&
            request.method === "GET" &&
            url.pathname === "/v1/push/config"
          ) {
            await respond(
              response,
              Effect.andThen(
                authorized,
                Effect.succeed({
                  canonicalUrl: config.approvalHub.url,
                  enabled: vapidKeys !== null,
                  publicKey: vapidKeys?.publicKey ?? null
                })
              )
            )
            return
          }

          if (
            mode === "serve" &&
            request.method === "GET" &&
            url.pathname === "/v1/push/subscriptions"
          ) {
            const effect = Effect.gen(function*() {
              const who = yield* authorized
              const removal = yield* Schema.decodeUnknownEffect(
                PushSubscriptionRemoval
              )({ endpoint: url.searchParams.get("endpoint") }).pipe(
                Effect.mapError(
                  (cause) =>
                    new FleetValidationError({
                      detail: `invalid subscription endpoint: ${String(cause)}`
                    })
                )
              )
              return {
                subscribed: yield* approvalStore.hasSubscription(
                  removal.endpoint,
                  who
                )
              }
            })
            await respond(response, effect)
            return
          }

          if (
            mode === "serve" &&
            request.method === "POST" &&
            url.pathname === "/v1/push/subscriptions"
          ) {
            const effect = Effect.gen(function*() {
              const who = yield* authorized
              yield* sameOrigin(request, expectedOrigin())
              const subscription = yield* readJson(
                request,
                PushSubscriptionRecord
              )
              yield* validatePushEndpoint(
                subscription.endpoint,
                config.pushAllowedOrigins
              )
              yield* approvalStore.putSubscription(subscription, who)
              return { subscribed: true }
            })
            await respond(response, effect, 201)
            return
          }

          if (
            mode === "serve" &&
            request.method === "DELETE" &&
            url.pathname === "/v1/push/subscriptions"
          ) {
            const effect = Effect.gen(function*() {
              const who = yield* authorized
              yield* sameOrigin(request, expectedOrigin())
              const removal = yield* readJson(request, PushSubscriptionRemoval)
              yield* approvalStore.deleteOwnedSubscription(
                removal.endpoint,
                who
              )
              return { subscribed: false }
            })
            await respond(response, effect)
            return
          }

          if (
            mode === "serve" &&
            request.method === "GET" &&
            url.pathname === "/v1/chat"
          ) {
            await respond(response, Effect.andThen(authorized, chat.history()))
            return
          }

          if (
            mode === "serve" &&
            request.method === "POST" &&
            url.pathname === "/v1/chat"
          ) {
            const effect = Effect.gen(function*() {
              const who = yield* authorized
              yield* sameOrigin(request, expectedOrigin())
              const input = yield* readJson(request, ChatRequest)
              const submitted = yield* chat.submit(input, who)
              if (submitted.queued) yield* enqueueJob(submitted.jobId)
              return submitted.entry
            })
            await respond(response, effect, 202)
            return
          }

          if (
            approvalSurface &&
            request.method === "GET" &&
            url.pathname === "/v1/dashboard-pending"
          ) {
            const effect = Effect.gen(function*() {
              yield* authorized
              const continuation = yield* decodePendingApprovalContinuation(url)
              return yield* dashboardPendingPage(config, service, continuation, issueApprovalProofs)
            })
            const result = await runRequest(Effect.result(effect))
            if (Result.isFailure(result)) {
              const mapped = apiError(result.failure)
              json(response, mapped.status, mapped.body)
            } else {
              json(response, 200, result.success, approvalProofHeaders(result.success.local))
            }
            return
          }

          if (
            mode === "tailnet" &&
            request.method === "GET" &&
            url.pathname === "/v1/pending-approvals"
          ) {
            const effect = Effect.gen(function*() {
              yield* authorized
              const cursor = yield* decodePendingApprovalCursor(url)
              return yield* localPendingSummary(config.host, service, cursor)
            })
            await respond(
              response,
              effect
            )
            return
          }

          if (
            mode === "tailnet" &&
            request.method === "GET" &&
            url.pathname === "/v1/connect/agents/local"
          ) {
            await respond(
              response,
              Effect.andThen(
                tailnetActor(request, config, [config.approvalHub.nodeId]),
                localConnectAgents(
                  config,
                  service,
                  activityStore,
                  relationshipStore,
                  now()
                ).pipe(
                  Effect.provideService(Crypto.Crypto, cryptoService)
                )
              )
            )
            return
          }

          if (
            mode === "serve" &&
            request.method === "GET" &&
            url.pathname === "/v1/connect/agents"
          ) {
            await respond(
              response,
              Effect.andThen(
                authorized,
                Effect.gen(function*() {
                  const cursor = yield* decodeConnectAgentCursor(url)
                  const peers = yield* fleetPeers(config)
                  const directory = yield* fleetConnectAgents(
                    localConnectAgents(
                      config,
                      service,
                      activityStore,
                      relationshipStore,
                      now()
                    ).pipe(
                      Effect.provideService(Crypto.Crypto, cryptoService)
                    ),
                    peers.map((peer) => ({
                      agentsUrl: peer.connectAgentsUrl,
                      host: peer.host,
                      online: peer.online,
                      terminalUrl: peer.terminalUrl
                    }))
                  )
                  return yield* pageFleetConnectAgents(directory, cursor)
                })
              )
            )
            return
          }

          if (
            !approvalSurface &&
            request.method === "GET" &&
            url.pathname === "/v1/status"
          ) {
            await respond(response, Effect.andThen(authorized, service.status()))
            return
          }
          if (
            !approvalSurface &&
            request.method === "GET" &&
            url.pathname === "/v1/history"
          ) {
            const rawLimit = Number(url.searchParams.get("limit") ?? "50")
            const limit = Number.isInteger(rawLimit)
              ? Math.min(Math.max(rawLimit, 1), 500)
              : 50
            const effect = Effect.gen(function*() {
              yield* authorized
              const cursor = yield* decodePendingApprovalCursor(url)
              return yield* service.historyPage(cursor, limit)
            })
            await respond(response, effect)
            return
          }
          const jobMatch = /^\/v1\/jobs\/([^/]+)$/.exec(url.pathname)
          const jobIdSegment = jobMatch?.[1]
          if (
            !approvalSurface &&
            request.method === "GET" &&
            jobIdSegment !== undefined
          ) {
            await respond(
              response,
              Effect.gen(function*() {
                yield* authorized
                const jobId = yield* decodeJobPathSegment(jobIdSegment)
                return yield* service.get(jobId)
              })
            )
            return
          }
          if (
            !approvalSurface &&
            request.method === "POST" &&
            url.pathname === "/v1/jobs"
          ) {
            const effect = Effect.gen(function*() {
              const who = yield* authorized
              yield* authorizeOriginlessMutation(request)
              const input = yield* readJson(request, JobRequest)
              const record = yield* service.submit(input, who)
              if (record.status === "queued") yield* enqueueJob(record.id)
              return record
            })
            await respond(response, effect, 202)
            return
          }
          const approvalMatch = /^\/v1\/jobs\/([^/]+)\/(approve|reject)$/.exec(
            url.pathname
          )
          const approvalJobId = approvalMatch?.[1]
          const decision = approvalMatch?.[2]
          if (
            approvalSurface &&
            request.method === "POST" &&
            approvalJobId !== undefined &&
            (decision === "approve" || decision === "reject")
          ) {
            const effect = Effect.gen(function*() {
              const who = yield* authorized
              yield* sameOrigin(request, expectedOrigin())
              const jobId = yield* decodeJobPathSegment(approvalJobId)
              const approval = (yield* readApproval(request)) ??
                (yield* approvalFromProof(service, approvalProofs, request, jobId, now))
              const record = decision === "approve"
                ? yield* service.approve(jobId, approval, who)
                : yield* service.reject(jobId, approval, who)
              if (record.status === "queued") yield* enqueueJob(record.id)
              return sanitizeJobRecord(record)
            })
            if (
              header(request, "content-type")?.startsWith(
                "application/x-www-form-urlencoded"
              ) === true
            ) {
              const result = await runRequest(Effect.result(effect))
              if (Result.isFailure(result)) {
                const mapped = apiError(result.failure)
                json(response, mapped.status, mapped.body)
              } else {
                response.writeHead(303, { location: "/" })
                response.end()
              }
              return
            }
            await respond(response, effect)
            return
          }
          if (request.method === "GET" && url.pathname === "/") {
            const result = await runRequest(
              Effect.result(Effect.andThen(authorized, dashboard))
            )
            if (Result.isFailure(result)) {
              const mapped = apiError(result.failure)
              json(response, mapped.status, mapped.body)
              return
            }
            response.writeHead(200, {
              "cache-control": "no-cache, must-revalidate",
              "content-security-policy": "frame-ancestors 'none'",
              "content-type": "text/html; charset=utf-8",
              "x-frame-options": "DENY",
              ...approvalProofHeaders(result.success.pendingApprovals.local)
            })
            response.end(dashboardPage(result.success))
            return
          }
          if (
            mode === "serve" &&
            request.method === "GET" &&
            url.pathname === "/connect/"
          ) {
            const result = await runRequest(Effect.result(authorized))
            if (Result.isFailure(result)) {
              const mapped = apiError(result.failure)
              json(response, mapped.status, mapped.body)
              return
            }
            response.writeHead(200, {
              "cache-control": "no-cache, must-revalidate",
              "content-security-policy": "frame-ancestors 'none'",
              "content-type": "text/html; charset=utf-8",
              "x-frame-options": "DENY"
            })
            response.end(connectPage())
            return
          }
          json(response, 404, { error: "not_found" })
        } catch (error) {
          if (closed || response.destroyed) return
          json(response, 500, { error: "internal", detail: String(error) })
        }
      }
      const server = tls === null
        ? createServer(requestHandler)
        : await httpRuntime.runPromise(
          Effect.try({
            try: () =>
              createSecureServer(
                { cert: tls.certificate, key: tls.privateKey },
                requestHandler
              ),
            catch: (cause) =>
              new FleetOperationError({
                cause,
                detail: "approval TLS certificate or private key is invalid",
                operation: "hostd.approval_tls.create_server"
              })
          })
        )

      server.on("connection", (connection) => {
        activeHttpSockets.add(connection)
        connection.once("close", () => activeHttpSockets.delete(connection))
      })

      server.on("upgrade", async (request, socket, head) => {
        const url = pathOf(request)
        const isServeTerminal = mode === "serve" && url.pathname === "/v1/connect/session"
        const isTailnetTerminal = mode === "tailnet" && url.pathname === "/v1/connect/terminal"
        if (!isServeTerminal && !isTailnetTerminal) {
          rejectUpgrade(socket, 404)
          return
        }
        if (header(request, "host")?.toLowerCase() !== expectedHost) {
          rejectUpgrade(socket, 403)
          return
        }
        if (!acceptingRequests) {
          rejectUpgrade(socket, 503)
          return
        }
        const access = Effect.gen(function*() {
          if (isServeTerminal) {
            yield* tailnetActor(request, config, null)
            yield* sameOrigin(request, expectedOrigin())
          } else {
            yield* tailnetActor(request, config, [config.approvalHub.nodeId])
          }
          return yield* terminalSelectionFromUrl(url)
        })
        const result = await httpRuntime.runPromise(Effect.result(access)).catch(
          () => null
        )
        if (result === null) {
          socket.destroy()
          return
        }
        if (Result.isFailure(result)) {
          rejectUpgrade(socket, 403)
          return
        }
        if (closed || !acceptingRequests) {
          rejectUpgrade(socket, 503)
          return
        }
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          watchSocket(webSocket)
          webSockets.add(webSocket)
          webSocket.once("close", () => webSockets.delete(webSocket))
          const task = isTailnetTerminal ||
              result.success.host.toLowerCase() === config.host.toLowerCase()
            ? attachTerminal(webSocket, result.success)
            : proxyTerminal(webSocket, result.success)
          terminalTasks.add(task)
          void task.then(
            () => terminalTasks.delete(task),
            () => {
              terminalTasks.delete(task)
              closeSocket(webSocket, 4503, "terminal unavailable")
            }
          )
        })
      })

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, address, resolve)
      })
      const decodedAddress = Schema.decodeUnknownResult(TcpAddress)(server.address())
      if (Result.isFailure(decodedAddress)) {
        throw new FleetOperationError({
          cause: decodedAddress.failure,
          detail: "hostd did not receive a TCP address",
          operation: "hostd.listen.address"
        })
      }
      const bound = decodedAddress.success
      if (mode !== "serve") {
        expectedHost = listenerAuthority(
          mode === "lan" && options.lanWork?.host !== undefined
            ? options.lanWork.host
            : bound.address,
          bound.port
        )
      }
      activeServers.add(server)
      return {
        server,
        url: `${tls === null ? "http" : "https"}://${
          mode === "lan"
            ? expectedHost
            : `${bound.address}:${bound.port}`
        }`
      }
    }

    const tailscaleIp = config.crossHost
      ? await httpRuntime.runPromise(
        Effect.flatMap(Tailscale, (tailscale) => tailscale.ipv4)
      )
      : null
    if (tailscaleIp === "") {
      throw new FleetOperationError({
        cause: tailscaleIp,
        detail: "tailscale ip -4 returned no address",
        operation: "hostd.tailscale.ipv4"
      })
    }

    const recoveredJobIds = await Effect.runPromise(service.recover())
    const local = await listen("127.0.0.1", config.localPort, "local")
    const lan = options.lanWork === undefined
      ? null
      : await listen(options.lanWork.address, options.lanWork.port, "lan")
    if (tailscaleIp === null) {
      const work = await listen(workBindAddress, config.port, "work")
      for (const jobId of recoveredJobIds) await Effect.runPromise(enqueueJob(jobId))
      lanWorkPairing = options.lanWork === undefined
        ? null
        : await httpRuntime.runPromise(makeLanWorkPairing(now))
      acceptingRequests = true
      return {
        url: local.url,
        tailnetUrl: null,
        approvalUrl: null,
        serveUrl: null,
        workUrl: work.url,
        lanWorkUrl: lan?.url ?? null,
        lanWorkPairingCode: lan === null || lanWorkPairing === null
          ? null
          : lanWorkPairing.pairingCode,
        close: shutdown
      }
    }

    const remote = await listen(tailscaleIp, config.port, "tailnet")
    const approval = isHub
      ? null
      : await listen(tailscaleIp, config.approvalPort, "approval")
    const serve = isHub
      ? await listen(tailscaleIp, config.approvalPort, "serve", tlsCredentials)
      : null
    for (const jobId of recoveredJobIds) await Effect.runPromise(enqueueJob(jobId))
    if (pushSender !== null) {
      await httpRuntime.runPromise(
        Effect.forkIn(
          makePushWorker({
            allowedPushOrigins: config.pushAllowedOrigins,
            allowedUsers: config.allowedUsers,
            loadCandidates: () => notificationCandidates(config, service),
            send: pushSender,
            store: approvalStore
          }),
          workerScope
        )
      )
    }
    lanWorkPairing = options.lanWork === undefined
      ? null
      : await httpRuntime.runPromise(makeLanWorkPairing(now))
    acceptingRequests = true
    return {
      url: local.url,
      tailnetUrl: remote.url,
      approvalUrl: approval?.url ?? serve?.url ?? null,
      serveUrl: serve?.url ?? null,
      workUrl: null,
      lanWorkUrl: lan?.url ?? null,
      lanWorkPairingCode: lan === null || lanWorkPairing === null
        ? null
        : lanWorkPairing.pairingCode,
      close: shutdown
    }
  } catch (error) {
    try {
      await shutdown()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "hostd startup and cleanup both failed",
        { cause: cleanupError }
      )
    }
    throw error
  }
}
