import type { WorkGoalId, WorkSnapshots } from "@knpkv/herdr-work/model"
import { workNavigationHref } from "@knpkv/herdr-work/navigation"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import type { ConnectAgent } from "./model.js"

export type ConnectWorkGoalResolution =
  | {
    readonly _tag: "available"
    readonly goalId: WorkGoalId
    readonly href: string
    readonly title: string
  }
  | { readonly _tag: "missing" }
  | { readonly _tag: "ambiguous"; readonly goalIds: ReadonlyArray<WorkGoalId> }
  | { readonly _tag: "unavailable"; readonly reason: "snapshot_unavailable" }

/** Keeps the last valid Work projection available for association during refresh failures. */
export const workSnapshotForAssociation = <E>(
  result: AsyncResult.AsyncResult<WorkSnapshots, E>
): WorkSnapshots | null => {
  if (AsyncResult.isSuccess(result)) return result.value
  if (result._tag !== "Failure" || result.previousSuccess._tag !== "Some") return null
  return result.previousSuccess.value.value
}

const sameAgent = (
  agent: Pick<ConnectAgent, "host" | "id">,
  candidate: WorkSnapshots["now"]["goals"][number]
): boolean => {
  const identity = candidate.agentHierarchy?.agent
  const target = candidate.connectTarget
  return (identity?.agentId === agent.id && identity.host.toLowerCase() === agent.host.toLowerCase()) ||
    (target?.agentId === agent.id && target.host.toLowerCase() === agent.host.toLowerCase())
}

/** Resolves only the live Work projection; duplicate owners remain unavailable. */
export const resolveConnectWorkGoal = (
  agent: Pick<ConnectAgent, "host" | "id">,
  snapshots: WorkSnapshots
): Exclude<ConnectWorkGoalResolution, { readonly _tag: "unavailable" }> => {
  const goals = snapshots.now.goals.filter((goal) => sameAgent(agent, goal))
  if (goals.length === 0) return { _tag: "missing" }
  if (goals.length > 1) return { _tag: "ambiguous", goalIds: goals.map(({ id }) => id) }
  const goal = goals[0]
  if (goal === undefined) return { _tag: "missing" }
  return {
    _tag: "available",
    goalId: goal.id,
    href: workNavigationHref({ goalId: goal.id, window: "now" }),
    title: goal.title
  }
}
