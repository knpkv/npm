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
import { type ConnectAgent, type ConnectPeerFailure, FleetConnectAgents, LocalConnectAgents } from "./model.js"
import type { AgentRelationshipStore } from "./relationship-store.js"

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
  yield* Effect.forEach(
    durableWorkers,
    (worker) =>
      relationshipStore.persist(
        worker.relationship === undefined
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
        "durable_worker"
      ),
    { discard: true }
  ).pipe(
    Effect.mapError((cause) => new ConnectPeerError({ cause, host: config.host, reason: "invalid_response" }))
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
  const counts = new Map<string, number>()
  const agents = yield* Effect.forEach(inventory.agents, (agent) =>
    Effect.gen(function*() {
      const next = (counts.get(agent.kind) ?? 0) + 1
      counts.set(agent.kind, next)
      const id = agent.agentId === null
        ? yield* connectAgentId(config.host, agent.paneId).pipe(
          Effect.mapError((cause) => new ConnectPeerError({ cause, host: config.host, reason: "unavailable" }))
        )
        : agent.agentId
      const persisted = yield* relationshipStore.persist(
        agent.parentAgentId === null || agent.relation === null
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
        "trusted_live_inventory"
      ).pipe(
        Effect.mapError((cause) => new ConnectPeerError({ cause, host: config.host, reason: "invalid_response" }))
      )
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
      return persisted.relationship === undefined
        ? connectAgent satisfies ConnectAgent
        : {
          ...connectAgent,
          relationship: persisted.relationship
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
