import { Effect, Schema } from "effect"
import { ConnectRelationshipError } from "./errors.js"
import { ConnectAgent, ConnectAgentRelation } from "./model.js"

export const ConnectForestEdge = Schema.Struct({
  host: ConnectAgent.fields.host,
  agentId: ConnectAgent.fields.id,
  parentHost: ConnectAgent.fields.host,
  parentAgentId: ConnectAgent.fields.id,
  relation: ConnectAgentRelation
})
export type ConnectForestEdge = typeof ConnectForestEdge.Type

export const ConnectForest = Schema.Struct({
  edges: Schema.Array(ConnectForestEdge),
  roots: Schema.Array(Schema.Struct({
    host: ConnectAgent.fields.host,
    agentId: ConnectAgent.fields.id
  }))
})
export type ConnectForest = typeof ConnectForest.Type

const relationshipError = (
  reason: ConnectRelationshipError["reason"],
  detail: string
) => new ConnectRelationshipError({ detail, reason })

export const buildConnectForest = Effect.fn("HerdrConnect.buildForest")(
  function*(input: ReadonlyArray<ConnectAgent>) {
    const agents = yield* Schema.decodeUnknownEffect(
      Schema.Array(ConnectAgent).check(Schema.isMaxLength(1_024))
    )(input).pipe(
      Effect.mapError(() => relationshipError("malformed", "agent relationship input is malformed"))
    )
    const keyOf = (agent: Pick<ConnectAgent, "host" | "id">): string => `${agent.host.toLowerCase()}\u0000${agent.id}`
    const byKey = new Map<string, ConnectAgent>()
    for (const agent of agents) {
      const key = keyOf(agent)
      if (byKey.has(key)) {
        return yield* relationshipError(
          "ambiguous_ownership",
          `agent ${agent.id} has more than one owner on ${agent.host}`
        )
      }
      byKey.set(key, agent)
    }
    const roots: Array<{ readonly host: string; readonly agentId: string }> = []
    const edges: Array<ConnectForestEdge> = []
    for (const agent of agents) {
      if (agent.relationship === undefined) {
        roots.push({ agentId: agent.id, host: agent.host })
        continue
      }
      const parent = byKey.get(
        `${agent.host.toLowerCase()}\u0000${agent.relationship.parentAgentId}`
      )
      if (parent === undefined) {
        const foreignParent = agents.find(
          (candidate) => candidate.id === agent.relationship?.parentAgentId
        )
        if (foreignParent !== undefined) {
          return yield* relationshipError(
            "cross_host",
            `agent ${agent.id} and its parent belong to different hosts`
          )
        }
        roots.push({ agentId: agent.id, host: agent.host })
        continue
      }
      edges.push({
        host: agent.host,
        agentId: agent.id,
        parentHost: parent.host,
        parentAgentId: agent.relationship.parentAgentId,
        relation: agent.relationship.relation
      })
    }
    for (const agent of agents) {
      const path = new Set<string>()
      let current: ConnectAgent | undefined = agent
      while (current !== undefined) {
        const key = keyOf(current)
        if (path.has(key)) {
          return yield* relationshipError(
            "cyclic",
            `agent ${current.id} closes a relationship cycle`
          )
        }
        path.add(key)
        current = current.relationship === undefined
          ? undefined
          : byKey.get(
            `${current.host.toLowerCase()}\u0000${current.relationship.parentAgentId}`
          )
      }
    }
    return yield* Schema.decodeUnknownEffect(ConnectForest)({ edges, roots }).pipe(
      Effect.mapError(() => relationshipError("malformed", "validated forest could not be encoded"))
    )
  }
)
