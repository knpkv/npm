import { Crypto, Effect, Encoding } from "effect"
import { FleetOperationError } from "./errors.js"
import type { JobPayload } from "./model.js"

const text = (value: string): string => JSON.stringify(value)

const canonicalPayload = (payload: JobPayload): string => {
  switch (payload.kind) {
    case "browser.mcp.recover":
      return `{"kind":${text(payload.kind)}}`
    case "nix.check":
      return `{"kind":${text(payload.kind)}}`
    case "nix.apply":
      return `{"kind":${text(payload.kind)},"ref":${text(payload.ref)}}`
    case "agent.delegate":
      return `{"channel":${payload.channel === undefined ? "null" : text(payload.channel)},"kind":${
        text(
          payload.kind
        )
      },"mode":${text(payload.mode)},"prompt":${text(payload.prompt)},"repository":${text(payload.repository)}}`
    case "agent.message":
      return `{"kind":${text(payload.kind)},"message":${text(payload.message)},"session":${text(payload.session)}}`
    case "work.reconcile":
      return JSON.stringify({
        kind: payload.kind,
        repository: payload.repository,
        pullRequest: payload.pullRequest,
        goalId: payload.goalId,
        laneId: payload.laneId,
        operationId: payload.operationId,
        expectedRevision: payload.expectedRevision,
        expectedHead: payload.expectedHead,
        newHead: payload.newHead,
        expectedOwner: { id: payload.expectedOwner.id, name: payload.expectedOwner.name },
        expectedGoalEventId: payload.expectedGoalEventId,
        bindingDispatchRequestId: payload.bindingDispatchRequestId,
        sessionId: payload.sessionId,
        expectedWork: payload.expectedWork,
        worker: {
          host: payload.worker.host,
          agentId: payload.worker.agentId,
          name: payload.worker.name,
          paneId: payload.worker.paneId,
          relationship: payload.worker.relationship === undefined ? null : {
            parentAgentId: payload.worker.relationship.parentAgentId,
            relation: payload.worker.relationship.relation
          }
        },
        worktree: payload.worktree,
        branch: payload.branch
      })
    case "work.admit":
      return JSON.stringify({
        kind: payload.kind,
        repository: payload.repository,
        pullRequest: payload.pullRequest,
        reviewUrl: payload.reviewUrl,
        goalId: payload.goalId,
        laneId: payload.laneId,
        operationId: payload.operationId,
        expectedAbsenceToken: payload.expectedAbsenceToken,
        head: payload.head,
        baseHead: payload.baseHead,
        owner: { id: payload.owner.id, name: payload.owner.name },
        sessionId: payload.sessionId,
        expectedWork: payload.expectedWork,
        worker: {
          host: payload.worker.host,
          agentId: payload.worker.agentId,
          name: payload.worker.name,
          paneId: payload.worker.paneId,
          relationship: payload.worker.relationship === undefined ? null : {
            parentAgentId: payload.worker.relationship.parentAgentId,
            relation: payload.worker.relationship.relation
          }
        },
        worktree: payload.worktree,
        branch: payload.branch,
        title: payload.title,
        summary: payload.summary,
        detail: payload.detail
      })
    case "work.recover":
      return JSON.stringify({
        kind: payload.kind,
        repository: payload.repository,
        pullRequest: payload.pullRequest,
        reviewUrl: payload.reviewUrl,
        goalId: payload.goalId,
        laneId: payload.laneId,
        operationId: payload.operationId,
        expectedGoalEventId: payload.expectedGoalEventId,
        expectedGoalUpdatedAt: payload.expectedGoalUpdatedAt,
        expectedHistoryToken: payload.expectedHistoryToken,
        head: payload.head,
        baseHead: payload.baseHead,
        owner: { id: payload.owner.id, name: payload.owner.name },
        sessionId: payload.sessionId,
        expectedWork: payload.expectedWork,
        worker: {
          host: payload.worker.host,
          agentId: payload.worker.agentId,
          name: payload.worker.name,
          paneId: payload.worker.paneId,
          relationship: payload.worker.relationship === undefined
            ? null
            : {
              parentAgentId: payload.worker.relationship.parentAgentId,
              relation: payload.worker.relationship.relation
            }
        },
        worktree: payload.worktree,
        branch: payload.branch
      })
  }
}

export const jobHash = Effect.fn("Fleet.jobHash")(function*(
  host: string,
  actor: string,
  payload: JobPayload
) {
  const cryptoService = yield* Crypto.Crypto
  const canonical = `{"actor":${text(actor)},"host":${text(host)},"payload":${canonicalPayload(payload)}}`
  const digest = yield* cryptoService.digest("SHA-256", new TextEncoder().encode(canonical)).pipe(
    Effect.mapError(
      (cause) =>
        new FleetOperationError({
          cause,
          detail: "could not hash fleet job payload",
          operation: "fleet.job_hash"
        })
    )
  )
  return Encoding.encodeHex(digest)
})
