import { Schema } from "effect"
import { isTerminalWorkState, WorkGoalCheckpoint } from "../model.js"
import type {
  WorkActivity,
  WorkGoal,
  WorkGoalCheckpoint as WorkGoalCheckpointType,
  WorkObservedFact,
  WorkPullRequestObservation
} from "../model.js"
import { goalPullRequestSubject } from "../observed.js"

/** A goal whose pull request is observed merged or closed, and the head checkpoint it was planned from. */
export interface TerminalCandidate {
  readonly head: WorkGoalCheckpointType
  readonly fact: WorkObservedFact
  readonly pullRequest: WorkPullRequestObservation
}

const latestPerGoal = (events: ReadonlyArray<WorkGoalCheckpointType>): ReadonlyArray<WorkGoalCheckpointType> => {
  const latest = new Map<string, WorkGoalCheckpointType>()
  for (const event of events) {
    const current = latest.get(event.goal.id)
    if (
      current === undefined || event.occurredAt > current.occurredAt ||
      (event.occurredAt === current.occurredAt && event.eventId > current.eventId)
    ) latest.set(event.goal.id, event)
  }
  return [...latest.values()]
}

/**
 * Goals not yet terminal whose pull request's latest observed fact is merged
 * or closed. Goals with no pull request, or already finished, are left alone.
 */
export const terminalCandidates = (
  events: ReadonlyArray<WorkGoalCheckpointType>,
  facts: ReadonlyArray<WorkObservedFact>
): ReadonlyArray<TerminalCandidate> => {
  const factBySubject = new Map(facts.map((fact) => [fact.subject, fact]))
  return latestPerGoal(events).flatMap((head) => {
    if (isTerminalWorkState(head.goal.state)) return []
    const subject = goalPullRequestSubject(head.goal)
    const fact = subject === null ? undefined : factBySubject.get(subject)
    if (fact === undefined || fact.observation._tag !== "pull_request") return []
    const pullRequest = fact.observation
    return pullRequest.state === "open" ? [] : [{ fact, head, pullRequest }]
  })
}

const goalActivityLimit = 128

/**
 * The terminal checkpoint for one candidate. It is stamped with the pull
 * request's own close time, or one millisecond after the goal's head when an
 * owner wrote after the close, so it is the head of history and the same
 * candidate always yields the same checkpoint. A blocker cannot outlive a
 * finished goal, so it is cleared; the activity names the observation.
 */
export const terminalCheckpoint = (candidate: TerminalCandidate, eventId: string): WorkGoalCheckpointType => {
  const { head, pullRequest } = candidate
  const merged = pullRequest.state === "merged"
  const occurredAt = Math.max(pullRequest.closedAt ?? 0, head.goal.updatedAt + 1)
  const url = `https://github.com/${pullRequest.repository}/pull/${pullRequest.pullRequest}`
  const observed: WorkActivity = {
    id: eventId,
    kind: merged ? "shipment" : "status",
    summary: merged
      ? `Observed by the reconciler: ${url} merged`
      : `Observed by the reconciler: ${url} closed without merging`,
    occurredAt
  }
  const activity = [...(head.goal.activity ?? []), observed].slice(-goalActivityLimit)
  const goal: WorkGoal = {
    ...head.goal,
    state: merged ? "completed" : "abandoned",
    delivery: merged ? "merged" : head.goal.delivery,
    blocker: null,
    activity,
    updatedAt: occurredAt
  }
  return Schema.decodeUnknownSync(WorkGoalCheckpoint)({
    version: "herdr.work.event.v1",
    eventId,
    occurredAt,
    goal: head.goal.blockers === undefined ? goal : { ...goal, blockers: [] }
  })
}
