import type {
  AgentInventory,
  AgentWorkerObservation,
  FleetOperationError,
  FleetStoreError,
  HostConfiguration
} from "@knpkv/herdr-fleet"
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet"
import { Clock, Effect, Option, Result, Schema, type Types } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import type { AgentActivityStore } from "./activity-store.js"
import type { AgentArchiveStore } from "./archive-store.js"
import { ConnectArchiveStoreError, ConnectPeerError, ConnectStoreBusyError } from "./errors.js"
import { buildConnectForest } from "./forest.js"
import type { ConnectHueEnrichment } from "./hue-enrichment.js"
import { connectAgentId } from "./id.js"
import { ConnectInventoryFailure, inventoryRelationshipFailure } from "./internal/inventory-failure.js"
import { connectPeerDirectoryTimeoutMillis, connectPeerReporterTimeoutMillis } from "./internal/peer-deadline.js"
import {
  connectBusyTimeoutMillis,
  ConnectInventoryWriteDeadline,
  connectWriteTimeoutMillis
} from "./internal/sqlite-write.js"
import {
  ConnectAgent,
  type ConnectAgentCursor,
  connectAgentPageMaxRecords,
  type ConnectPeerFailure,
  FleetConnectAgentPage,
  FleetConnectAgents,
  type FleetConnectAgents as FleetConnectAgentsType,
  LocalConnectAgents
} from "./model.js"
import type { AgentPostStore } from "./post-store.js"
import { Unavailable } from "./posts.js"
import type { AgentRelationshipStore, RelationshipObservation } from "./relationship-store.js"

export interface AgentSource {
  readonly agents: () => Effect.Effect<AgentInventory, FleetOperationError>
  readonly workers: () => Effect.Effect<ReadonlyArray<AgentWorkerObservation>, FleetStoreError>
}

export interface ConnectPeerTarget {
  readonly agentsUrl: string | null
  readonly host: string
  readonly online: boolean
  readonly terminalUrl: string | null
}

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const compareConnectAgents = (left: ConnectAgent, right: ConnectAgent): number => {
  const host = compareText(left.host.toLowerCase(), right.host.toLowerCase())
  return host === 0 ? compareText(left.id, right.id) : host
}

export const pageFleetConnectAgents = Effect.fn("HerdrConnect.pageFleetAgents")(function*(
  directory: FleetConnectAgentsType,
  cursor: ConnectAgentCursor | null
) {
  const sorted = directory.agents.toSorted(compareConnectAgents)
  const nextIndex = cursor === null
    ? 0
    : sorted.findIndex(({ host, id }) => {
      const hostOrder = compareText(host.toLowerCase(), cursor.host.toLowerCase())
      return hostOrder > 0 || (hostOrder === 0 && compareText(id, cursor.id) > 0)
    })
  const start = nextIndex === -1 ? sorted.length : nextIndex
  const agents = sorted.slice(start, start + connectAgentPageMaxRecords)
  const last = agents.at(-1)
  const nextCursor = start + agents.length < sorted.length && last !== undefined
    ? { host: last.host, id: last.id }
    : null
  const page: Types.Mutable<typeof FleetConnectAgentPage.Type> = {
    agents,
    failures: cursor === null ? directory.failures : [],
    nextCursor
  }
  if (cursor === null && directory.hosts !== undefined) page.hosts = directory.hosts
  return yield* Schema.decodeUnknownEffect(FleetConnectAgentPage)(page).pipe(
    Effect.mapError(
      (cause) => new ConnectPeerError({ cause, host: "fleet", reason: "invalid_response" })
    )
  )
})

export const localConnectAgents = Effect.fn("HerdrConnect.localAgents")(
  function*(
    config: HostConfiguration,
    source: AgentSource,
    store: AgentActivityStore,
    relationshipStore: AgentRelationshipStore,
    observedAt: number,
    hueEnrichment?: ConnectHueEnrichment
  ) {
    const durableWorkers = yield* source.workers().pipe(
      Effect.mapError((cause) => new ConnectPeerError({ cause, host: config.host, reason: "unavailable" }))
    )
    const inventory = yield* source.agents().pipe(
      Effect.mapError((cause) => new ConnectPeerError({ cause, host: config.host, reason: "unavailable" }))
    )
    if (!inventory.available) {
      return yield* new ConnectPeerError({
        cause: inventory.error,
        host: config.host,
        reason: "unavailable"
      })
    }
    const identified = yield* Effect.forEach(inventory.agents, (agent) =>
      Effect.gen(function*() {
        const id = agent.agentId === null
          ? yield* connectAgentId(config.host, agent.paneId).pipe(
            Effect.mapError((cause) => new ConnectPeerError({ cause, host: config.host, reason: "unavailable" }))
          )
          : agent.agentId
        return { agent, id }
      }))
    const durableObservations: ReadonlyArray<RelationshipObservation> = durableWorkers.map((worker) => ({
      metadata: worker.relationship === undefined
        ? {
          agentId: worker.agentId,
          host: worker.host,
          observedAt: worker.terminalObservedAt ?? 0,
          paneId: worker.paneId
        }
        : {
          agentId: worker.agentId,
          host: worker.host,
          observedAt: worker.terminalObservedAt ?? 0,
          paneId: worker.paneId,
          relationship: worker.relationship
        },
      source: "durable_worker"
    }))
    const liveObservations: ReadonlyArray<RelationshipObservation> = identified.map(({ agent, id }) => ({
      metadata: agent.parentAgentId === null || agent.relation === null
        ? {
          agentId: id,
          host: config.host,
          observedAt,
          paneId: agent.paneId
        }
        : {
          agentId: id,
          host: config.host,
          observedAt,
          paneId: agent.paneId,
          relationship: {
            parentAgentId: agent.parentAgentId,
            relation: agent.relation
          }
        },
      source: "trusted_live_inventory"
    }))
    const writeDeadline = (yield* Clock.currentTimeMillis) + connectWriteTimeoutMillis
    const persisted = yield* relationshipStore.persistAll([
      ...durableObservations,
      ...liveObservations
    ]).pipe(
      Effect.provideService(ConnectInventoryWriteDeadline, writeDeadline),
      Effect.mapError((cause) =>
        new ConnectPeerError({
          cause: cause._tag === "ConnectStoreBusyError"
            ? cause
            : inventoryRelationshipFailure("persist_relationships", cause),
          host: config.host,
          reason: "invalid_response"
        })
      )
    )
    const persistedByAgent = new Map(
      persisted.map((metadata) => [
        `${metadata.host.toLowerCase()}\u0000${metadata.agentId}`,
        metadata
      ])
    )
    const counts = new Map<string, number>()
    const agents = yield* Effect.forEach(identified, ({ agent, id }) =>
      Effect.gen(function*() {
        const next = (counts.get(agent.kind) ?? 0) + 1
        counts.set(agent.kind, next)
        const relationship = persistedByAgent.get(`${config.host.toLowerCase()}\u0000${id}`)
        if (relationship === undefined) {
          return yield* new ConnectPeerError({
            cause: new ConnectInventoryFailure({
              step: "lookup_relationship",
              agentId: id,
              reason: "MissingPersistedRelationship"
            }),
            host: config.host,
            reason: "invalid_response"
          })
        }
        const lastActivityAt = yield* store
          .observe(config.host, id, agent.activityRevision, observedAt)
          .pipe(
            Effect.provideService(ConnectInventoryWriteDeadline, writeDeadline),
            Effect.mapError((cause) => new ConnectPeerError({ cause, host: config.host, reason: "unavailable" }))
          )
        const connectAgent = {
          host: config.host,
          id,
          kind: agent.kind,
          lastActivityAt,
          name: agent.name.includes(agent.paneId) ? `${agent.kind} agent ${next}` : agent.name,
          state: agent.status,
          work: agent.work
        }
        const projected = relationship.relationship === undefined
          ? connectAgent satisfies ConnectAgent
          : {
            ...connectAgent,
            relationship: relationship.relationship
          } satisfies ConnectAgent
        return yield* Schema.decodeUnknownEffect(ConnectAgent)(projected).pipe(
          Effect.mapError((cause) =>
            new ConnectPeerError({
              cause: new ConnectInventoryFailure({ step: "decode_inventory", agentId: id, reason: cause._tag }),
              host: config.host,
              reason: "invalid_response"
            })
          )
        )
      }))
    const local = yield* Schema.decodeUnknownEffect(LocalConnectAgents)({
      agents,
      host: config.host,
      complete: inventory.error === null
    }).pipe(
      Effect.mapError((cause) =>
        new ConnectPeerError({
          cause: new ConnectInventoryFailure({ step: "decode_inventory", agentId: null, reason: cause._tag }),
          host: config.host,
          reason: "invalid_response"
        })
      )
    )
    yield* buildConnectForest(local.agents).pipe(
      Effect.mapError((cause) =>
        new ConnectPeerError({
          cause: inventoryRelationshipFailure("validate_forest", cause),
          host: config.host,
          reason: "invalid_response"
        })
      )
    )
    if (hueEnrichment !== undefined) {
      const assigned = yield* hueEnrichment.assign(local.host, local.agents, observedAt, local.complete === true)
      return Option.isSome(assigned) ? { ...local, agents: assigned.value } : local
    }
    return yield* store.assignHues(local.host, local.agents, observedAt, local.complete === true).pipe(
      Effect.map((agents) => ({ ...local, agents })),
      Effect.catch((cause) =>
        Effect.logWarning("ConnectHueAssignmentFailed", { host: local.host, cause: cause._tag }).pipe(Effect.as(local))
      )
    )
  },
  Effect.tapError((error) => {
    if (error.reason !== "invalid_response") return Effect.void
    const diagnostic = Schema.is(ConnectStoreBusyError)(error.cause)
      ? inventoryRelationshipFailure("persist_relationships", error.cause)
      : error.cause
    if (!Schema.is(ConnectInventoryFailure)(diagnostic)) return Effect.void
    const { agentId, reason, step } = diagnostic
    return Effect.logWarning("Connect.local_inventory_failed", { step, agentId, reason })
  })
)

// The host endpoint is unpaged: it validates the entire inventory and rejects lists over 256.
// Preserve older peers' rows, but require their explicit full-list assertion for closure evidence.
const PeerConnectAgents = Schema.Struct({
  ...LocalConnectAgents.fields,
  nextCursor: Schema.optionalKey(Schema.Unknown),
  truncated: Schema.optionalKey(Schema.Boolean)
})

const PeerInventoryBusy = Schema.Struct({
  error: Schema.Literal("ConnectStoreBusyError"),
  operation: Schema.Literals(["persist.transaction", "activity.observe"]),
  timeoutMillis: Schema.Literal(connectWriteTimeoutMillis)
})

/** Reporter reads wait for the write budget plus a transport margin; directory reads keep their shorter deadline. */
export const fetchPeerConnectAgents = Effect.fn("HerdrConnect.fetchPeerAgents")(
  function*(
    peer: ConnectPeerTarget,
    _options: { readonly timeout?: "directory" | "reporter" } = {}
  ): Effect.fn.Return<LocalConnectAgents, ConnectPeerError, HttpClient.HttpClient> {
    if (!peer.online) {
      return yield* new ConnectPeerError({ cause: peer.host, host: peer.host, reason: "offline" })
    }
    if (peer.agentsUrl === null) {
      return yield* new ConnectPeerError({ cause: peer.host, host: peer.host, reason: "unavailable" })
    }
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(peer.agentsUrl).pipe(
      Effect.mapError((cause) => new ConnectPeerError({ cause, host: peer.host, reason: "request_failed" }))
    )
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 503) {
        const busy = yield* Effect.result(decodeBoundedResponseJson(response, PeerInventoryBusy, 1_024))
        if (Result.isSuccess(busy)) {
          return yield* new ConnectPeerError({
            cause: new ConnectStoreBusyError({
              operation: busy.success.operation,
              timeoutMillis: busy.success.timeoutMillis,
              cause: response.status
            }),
            host: peer.host,
            reason: "unavailable"
          })
        }
      }
      return yield* new ConnectPeerError({
        cause: response.status,
        host: peer.host,
        reason: "request_failed"
      })
    }
    const summary = yield* decodeBoundedResponseJson(response, PeerConnectAgents).pipe(
      Effect.mapError((cause) => new ConnectPeerError({ cause, host: peer.host, reason: "invalid_response" }))
    )
    if (summary.host.toLowerCase() !== peer.host.toLowerCase()) {
      return yield* new ConnectPeerError({
        cause: summary.host,
        host: peer.host,
        reason: "invalid_response"
      })
    }
    const foreignAgent = summary.agents.find(
      (agent) => agent.host.toLowerCase() !== peer.host.toLowerCase()
    )
    if (foreignAgent !== undefined) {
      return yield* new ConnectPeerError({
        cause: foreignAgent.host,
        host: peer.host,
        reason: "invalid_response"
      })
    }
    yield* buildConnectForest(summary.agents).pipe(
      Effect.mapError((cause) => new ConnectPeerError({ cause, host: peer.host, reason: "invalid_response" }))
    )
    const agents = { host: summary.host, agents: summary.agents }
    if (summary.complete === undefined) return agents
    return {
      ...agents,
      complete: summary.complete === true &&
        (summary.nextCursor === undefined || summary.nextCursor === null) && summary.truncated !== true
    }
  },
  (effect, peer, options?: { readonly timeout?: "directory" | "reporter" }) => {
    const timeoutMillis = options?.timeout === "reporter"
      ? connectPeerReporterTimeoutMillis
      : connectPeerDirectoryTimeoutMillis
    return effect.pipe(
      Effect.timeoutOrElse({
        duration: timeoutMillis,
        orElse: () =>
          Effect.fail(
            new ConnectPeerError({ cause: timeoutMillis, host: peer.host, reason: "timeout" })
          )
      })
    )
  }
)

export const fleetConnectAgents = Effect.fn("HerdrConnect.fleetAgents")(function*(
  local: Effect.Effect<LocalConnectAgents, ConnectPeerError>,
  peers: ReadonlyArray<ConnectPeerTarget>,
  archive?: { readonly store: AgentArchiveStore; readonly observedAt: number; readonly posts?: AgentPostStore }
) {
  const localResult = yield* Effect.result(local)
  const agents = Result.isSuccess(localResult) ? [...localResult.success.agents] : []
  const failures: Array<ConnectPeerFailure> = Result.isFailure(localResult)
    ? [{ host: localResult.failure.host, reason: localResult.failure.reason }]
    : []
  const results = yield* Effect.all(
    peers.map((peer) => Effect.result(fetchPeerConnectAgents(peer)).pipe(Effect.map((result) => ({ peer, result })))),
    { concurrency: 4 }
  )
  for (const { peer, result } of results) {
    if (Result.isSuccess(result)) {
      for (const agent of result.success.agents) agents.push(agent)
    } else failures.push({ host: peer.host, reason: result.failure.reason })
  }
  let fleet = yield* Schema.decodeUnknownEffect(FleetConnectAgents)({ agents, failures }).pipe(
    Effect.mapError(
      (cause) =>
        new ConnectPeerError({
          cause,
          host: "fleet",
          reason: "invalid_response"
        })
    )
  )
  yield* buildConnectForest(fleet.agents).pipe(
    Effect.mapError(
      (cause) => new ConnectPeerError({ cause, host: "fleet", reason: "invalid_response" })
    )
  )
  if (archive !== undefined) {
    const observations = [
      Result.isSuccess(localResult)
        ? { ...localResult.success, complete: localResult.success.complete === true }
        : { host: localResult.failure.host, agents: [], complete: false },
      ...results.map(({ peer, result }) =>
        Result.isSuccess(result)
          ? { ...result.success, complete: result.success.complete === true }
          : { host: peer.host, agents: [], complete: false }
      )
    ]
    yield* archive.store.observeAvailable(observations.map((observation) => ({
      ...observation,
      observedAt: archive.observedAt
    }))).pipe(
      Effect.catchIf(
        Schema.is(Schema.Union([ConnectArchiveStoreError, ConnectStoreBusyError])),
        (cause) => Effect.logWarning("Connect archive observation failed", { cause })
      )
    )
    const liveKeys = new Set(fleet.agents.map(({ host, id }) => `${host.toLowerCase()}\u0000${id}`))
    const missingParents = fleet.agents.flatMap(({ host, relationship }) =>
      relationship === undefined || liveKeys.has(`${host.toLowerCase()}\u0000${relationship.parentAgentId}`)
        ? []
        : [{ host, id: relationship.parentAgentId }]
    )
    const remembered = yield* archive.store.namesFor(missingParents).pipe(
      // A primary writer can hold the local permit during retries; this lookup is optional too.
      Effect.timeoutOrElse({
        duration: connectBusyTimeoutMillis,
        orElse: () =>
          new ConnectArchiveStoreError({
            operation: "names.deadline",
            cause: "archive name lookup exceeded its optional read budget"
          })
      }),
      Effect.catchTag(
        "ConnectArchiveStoreError",
        (cause) => Effect.logWarning("Connect archive name lookup failed", { cause }).pipe(Effect.as([]))
      )
    )
    const names = new Map(remembered.map(({ host, id, name }) => [`${host.toLowerCase()}\u0000${id}`, name]))
    fleet = {
      ...fleet,
      agents: fleet.agents.map((agent) => {
        if (agent.relationship === undefined) return agent
        const parentName = names.get(`${agent.host.toLowerCase()}\u0000${agent.relationship.parentAgentId}`)
        return parentName === undefined ? agent : { ...agent, relationship: { ...agent.relationship, parentName } }
      })
    }
  }
  if (archive?.posts === undefined) return fleet
  const postStore = archive.posts
  return yield* Effect.gen(function*() {
    const posts = yield* postStore.latestMany(
      fleet.agents.map(({ host, id }) => ({ host, agentId: id })),
      archive.observedAt
    )
    const selfStates = yield* postStore.selfLatestMany(fleet.agents.map(({ host, id }) => ({ host, agentId: id })))
    const bySelf = new Map(selfStates.map((entry) => [`${entry.host.toLowerCase()}\u0000${entry.agentId}`, entry.self]))
    const byAgent = new Map(posts.map((post) => [`${post.host.toLowerCase()}\u0000${post.agentId}`, post]))
    return {
      ...fleet,
      agents: fleet.agents.map((agent) => {
        const latest = byAgent.get(`${agent.host.toLowerCase()}\u0000${agent.id}`)
        const self = bySelf.get(`${agent.host.toLowerCase()}\u0000${agent.id}`) ?? null
        return latest === undefined
          ? { ...agent, self }
          : { ...agent, self, voice: { text: latest.text, createdAt: latest.createdAt } }
      })
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: connectBusyTimeoutMillis,
      orElse: () => new Unavailable({ operation: "directory.enrichment.deadline" })
    }),
    Effect.catchTag(
      "Unavailable",
      (cause) => Effect.logWarning("Connect voice enrichment failed", { cause }).pipe(Effect.as(fleet))
    )
  )
})
