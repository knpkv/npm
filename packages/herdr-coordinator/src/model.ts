import { AgentConnectTarget, AgentWorkerIdentity } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"

const Identifier = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256))
const utf8 = new TextEncoder()
const utf8MaxBytes = (maximumBytes: number) =>
  Schema.makeFilter(
    (value: string) => utf8.encode(value).byteLength <= maximumBytes,
    { expected: `UTF-8 text no larger than ${maximumBytes} bytes` }
  )

export const ChatMode = Schema.Literals(["ask", "work"])
export type ChatMode = typeof ChatMode.Type

export const ChatMessage = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(2_000),
  utf8MaxBytes(2_000)
)

export const ChatRequest = Schema.Struct({ message: ChatMessage, mode: ChatMode })
export interface ChatRequest extends Schema.Schema.Type<typeof ChatRequest> {}

export const StoredChatTurn = Schema.Struct({
  createdAt: Schema.Number,
  id: Identifier,
  jobId: Identifier,
  message: ChatMessage,
  mode: ChatMode
})
export interface StoredChatTurn extends Schema.Schema.Type<typeof StoredChatTurn> {}

export const ChatState = Schema.Literals(["pending", "running", "failed", "interrupted", "completed"])
export type ChatState = typeof ChatState.Type

export const CoordinatorReply = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(20_000),
  utf8MaxBytes(20_000)
)

export const chatHistoryMaxEntries = 32

export const ChatEntry = Schema.Struct({
  createdAt: Schema.Number,
  id: Identifier,
  message: ChatMessage,
  mode: ChatMode,
  reply: Schema.NullOr(CoordinatorReply),
  state: ChatState,
  updatedAt: Schema.Number,
  worker: Schema.optionalKey(AgentWorkerIdentity),
  connectTarget: Schema.optionalKey(AgentConnectTarget)
}).check(
  Schema.makeFilter(
    (entry) =>
      (entry.worker === undefined && entry.connectTarget === undefined) ||
      (entry.worker !== undefined &&
        entry.connectTarget !== undefined &&
        entry.worker.host === entry.connectTarget.host &&
        entry.worker.agentId === entry.connectTarget.agentId),
    { expected: "exact Connect target for the matching coordinator worker" }
  )
)
export interface ChatEntry extends Schema.Schema.Type<typeof ChatEntry> {}

export const ChatHistory = Schema.Struct({
  entries: Schema.Array(ChatEntry).check(Schema.isMaxLength(chatHistoryMaxEntries))
})
export interface ChatHistory extends Schema.Schema.Type<typeof ChatHistory> {}

export const CoordinatorLifecycleStarted = Schema.Struct({
  protocol: Schema.Literal("herdr.coordinator.child.v1"),
  jobId: Identifier,
  requestId: Identifier,
  type: Schema.Literal("started"),
  worker: AgentWorkerIdentity
})
export type CoordinatorLifecycleStarted = typeof CoordinatorLifecycleStarted.Type

export const CoordinatorLifecycleCompleted = Schema.Struct({
  protocol: Schema.Literal("herdr.coordinator.child.v1"),
  jobId: Identifier,
  reply: CoordinatorReply,
  requestId: Identifier,
  type: Schema.Literal("completed")
})
export type CoordinatorLifecycleCompleted = typeof CoordinatorLifecycleCompleted.Type

export const CoordinatorLifecycleEvent = Schema.Union([
  CoordinatorLifecycleStarted,
  CoordinatorLifecycleCompleted
])
export type CoordinatorLifecycleEvent = typeof CoordinatorLifecycleEvent.Type

export * from "./orchestrator-model.js"
