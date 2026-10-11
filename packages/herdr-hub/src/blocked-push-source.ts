import {
  type AgentPostStore,
  type ConnectPeerError,
  type ConnectPeerTarget,
  fetchPeerConnectAgents,
  type LocalConnectAgents
} from "@knpkv/herdr-connect"
import { Effect, Result } from "effect"
import { type BlockedObservation, blockedPromptFirstLine } from "./blocked-push-model.js"

/** Reuse the archive's full-inventory assertion. Failed reads preserve episode state. */
export const loadBlockedPushObservations = Effect.fn("BlockedPushSource.load")(function*(
  local: Effect.Effect<LocalConnectAgents, ConnectPeerError>,
  localHost: string,
  peers: ReadonlyArray<ConnectPeerTarget>,
  posts: AgentPostStore,
  observedAt: number
) {
  const localResult = yield* Effect.result(local)
  const remote = yield* Effect.forEach(peers, (peer) =>
    Effect.result(fetchPeerConnectAgents(peer)).pipe(
      Effect.map((result) => ({ host: peer.host, result }))
    ), { concurrency: 4 })
  const reads = [{ host: localHost, result: localResult }, ...remote].map(({ host, result }) =>
    Result.isSuccess(result)
      ? { ...result.success, observedAt, complete: result.success.complete === true }
      : { host, agents: [], observedAt, complete: false }
  )
  const latest = yield* posts.latestMany(
    reads.filter((read) => read.complete).flatMap((read) =>
      read.agents.map((agent) => ({ host: read.host, agentId: agent.id }))
    ),
    observedAt
  )
  const blockers = new Map(
    latest.filter((post) => post.kind === "blocker").map((post) => [
      `${post.host.toLowerCase()}\u0000${post.agentId}`,
      post
    ])
  )
  return reads.map((read): BlockedObservation => ({
    ...read,
    agents: read.agents.map((agent) => {
      const post = blockers.get(`${read.host.toLowerCase()}\u0000${agent.id}`)
      return post === undefined ? agent : { ...agent, blocker: true, firstLine: blockedPromptFirstLine(post.text) }
    })
  }))
})
