import { AgentConnectTarget } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"

const Identifier = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256))
const Text = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096), Schema.isPattern(/^[^\p{Cc}]+$/u))
const Timestamp = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })
)

export const workHistoryMaxEvents = 16_384
export const workSnapshotMaxGoals = 1_024

export const WorkGoalId = Identifier
export type WorkGoalId = typeof WorkGoalId.Type

export const WorkState = Schema.Literals(["planned", "working", "blocked", "review", "deployed", "completed"])
export type WorkState = typeof WorkState.Type

export const DeliveryStage = Schema.Literals(["local", "review", "pull_request", "merged", "deployed"])
export type DeliveryStage = typeof DeliveryStage.Type

export const WorkOwner = Schema.Struct({ id: Identifier, name: Text })
export interface WorkOwner extends Schema.Schema.Type<typeof WorkOwner> {}

export const WorkRepository = Schema.Struct({
  repository: Text,
  branch: Text
})
export interface WorkRepository extends Schema.Schema.Type<typeof WorkRepository> {}

export const WorkSpend = Schema.Struct({
  currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)),
  minorUnits: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
})
export interface WorkSpend extends Schema.Schema.Type<typeof WorkSpend> {}

export const WorkBlocker = Schema.Struct({
  summary: Text,
  since: Timestamp
})
export interface WorkBlocker extends Schema.Schema.Type<typeof WorkBlocker> {}

export const WorkGoal = Schema.Struct({
  id: WorkGoalId,
  title: Text,
  summary: Text,
  detail: Text,
  state: WorkState,
  owner: WorkOwner,
  repository: WorkRepository,
  spend: Schema.NullOr(WorkSpend),
  delivery: DeliveryStage,
  blocker: Schema.NullOr(WorkBlocker),
  connectTarget: Schema.NullOr(AgentConnectTarget),
  createdAt: Timestamp,
  updatedAt: Timestamp
}).check(
  Schema.makeFilter(
    (goal) => goal.updatedAt >= goal.createdAt && ((goal.state === "blocked") === (goal.blocker !== null)),
    { expected: "ordered goal timestamps and blocker present exactly for blocked state" }
  )
)
export interface WorkGoal extends Schema.Schema.Type<typeof WorkGoal> {}

export const WorkGoalCheckpoint = Schema.Struct({
  version: Schema.Literal("herdr.work.event.v1"),
  eventId: Identifier,
  occurredAt: Timestamp,
  goal: WorkGoal
}).check(
  Schema.makeFilter(
    (event) => event.occurredAt === event.goal.updatedAt,
    { expected: "checkpoint occurrence equal to the durable goal update timestamp" }
  )
)
export interface WorkGoalCheckpoint extends Schema.Schema.Type<typeof WorkGoalCheckpoint> {}

export const WorkSnapshotWindow = Schema.Literals(["now", "day", "week", "month"])
export type WorkSnapshotWindow = typeof WorkSnapshotWindow.Type

export const WorkSnapshot = Schema.Struct({
  window: WorkSnapshotWindow,
  observedAt: Timestamp,
  asOf: Timestamp,
  goals: Schema.Array(WorkGoal).check(Schema.isMaxLength(workSnapshotMaxGoals))
})
export interface WorkSnapshot extends Schema.Schema.Type<typeof WorkSnapshot> {}

export const WorkSnapshots = Schema.Struct({
  observedAt: Timestamp,
  now: WorkSnapshot,
  day: WorkSnapshot,
  week: WorkSnapshot,
  month: WorkSnapshot
})
export interface WorkSnapshots extends Schema.Schema.Type<typeof WorkSnapshots> {}
