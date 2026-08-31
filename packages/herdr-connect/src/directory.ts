import type {
  AgentInventory,
  AgentWorkerObservation,
  FleetOperationError,
  FleetStoreError,
  HostConfiguration
} from "@knpkv/herdr-fleet"
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet"
import { Effect, Result, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type { AgentActivityStore } from "./activity-store.js"
import { ConnectPeerError } from "./errors.js"
import { buildConnectForest } from "./forest.js"
import { connectAgentId } from "./id.js"
import {
  type ConnectAgent,
  type ConnectAgentCursor,
  connectAgentPageMaxRecords,
  type ConnectPeerFailure,
  FleetConnectAgentPage,
  FleetConnectAgents,
  type FleetConnectAgents as FleetConnectAgentsType,
  LocalConnectAgents
} from "./model.js"
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
  const cursorIndex = cursor === null
    ? -1
    : sorted.findIndex(
      ({ host, id }) => host.toLowerCase() === cursor.host.toLowerCase() && id === cursor.id
    )
  if (cursor !== null && cursorIndex === -1) {
    return yield* new ConnectPeerError({
      cause: cursor,
      host: "fleet",
      reason: "invalid_response"
    })
  }
  const start = cursorIndex + 1
  const agents = sorted.slice(start, start + connectAgentPageMaxRecords)
  const last = agents.at(-1)
  const nextCursor = start + agents.length < sorted.length && last !== undefined
    ? { host: last.host, id: last.id }
    : null
  return yield* Schema.decodeUnknownEffect(FleetConnectAgentPage)({
    agents,
    failures: cursor === null ? directory.failures : [],
    nextCursor
  }).pipe(
    Effect.mapError(
      (cause) => new ConnectPeerError({ cause, host: "fleet", reason: "invalid_response" })
    )
  )
})

export const localConnectAgents = Effect.fn("HerdrConnect.localAgents")(function*(
  config: HostConfiguration,
  source: AgentSource,
  store: AgentActivityStore,
  relationshipStore: AgentRelationshipStore,
  observedAt: number
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
  const storedRelationships = yield* relationshipStore.list().pipe(
    Effect.mapError((cause) => new ConnectPeerError({ cause, host: config.host, reason: "invalid_response" }))
  )
  const storedByAgent = new Map(
    storedRelationships.map((metadata) => [
      `${metadata.host.toLowerCase()}\u0000${metadata.agentId}`,
      metadata
    ])
  )
  const currentDurableObservations = durableObservations.filter(({ metadata }) => {
    const stored = storedByAgent.get(`${metadata.host.toLowerCase()}\u0000${metadata.agentId}`)
    return stored === undefined ||
      stored.paneId !== metadata.paneId ||
      stored.observedAt <= metadata.observedAt ||
      (
        stored.relationship?.parentAgentId === metadata.relationship?.parentAgentId &&
        stored.relationship?.relation === metadata.relationship?.relation
      )
  })
  const persisted = yield* relationshipStore.persistAll([
    ...currentDurableObservations,
    ...liveObservations
  ]).pipe(
    Effect.mapError((cause) => new ConnectPeerError({ cause, host: config.host, reason: "invalid_response" }))
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
        return yield* new ConnectPeerError({ cause: id, host: config.host, reason: "invalid_response" })
      }
      const lastActivityAt = yield* store
        .observe(config.host, id, agent.activityRevision, observedAt)
        .pipe(
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
      return relationship.relationship === undefined
        ? connectAgent satisfies ConnectAgent
        : {
          ...connectAgent,
          relationship: relationship.relationship
        } satisfies ConnectAgent
    }))
  const local = yield* Schema.decodeUnknownEffect(LocalConnectAgents)({ agents, host: config.host }).pipe(
    Effect.mapError((cause) => new ConnectPeerError({ cause, host: config.host, reason: "invalid_response" }))
  )
  yield* buildConnectForest(local.agents).pipe(
    Effect.mapError((cause) => new ConnectPeerError({ cause, host: config.host, reason: "invalid_response" }))
  )
  return local
})

export const fetchPeerConnectAgents = Effect.fn("HerdrConnect.fetchPeerAgents")(
  function*(peer: ConnectPeerTarget) {
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
      return yield* new ConnectPeerError({
        cause: response.status,
        host: peer.host,
        reason: "request_failed"
      })
    }
    const summary = yield* decodeBoundedResponseJson(response, LocalConnectAgents).pipe(
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
    return summary
  },
  (effect, peer) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: "1500 millis",
        orElse: () =>
          Effect.fail(
            new ConnectPeerError({ cause: 1_500, host: peer.host, reason: "timeout" })
          )
      })
    )
)

export const fleetConnectAgents = Effect.fn("HerdrConnect.fleetAgents")(function*(
  local: Effect.Effect<LocalConnectAgents, ConnectPeerError>,
  peers: ReadonlyArray<ConnectPeerTarget>
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
  const fleet = yield* Schema.decodeUnknownEffect(FleetConnectAgents)({ agents, failures }).pipe(
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
  return fleet
})
