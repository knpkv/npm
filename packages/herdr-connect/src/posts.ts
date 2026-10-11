import { AgentStableId, FleetHostName } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
/** Maximum text lengths, measured with string.length, for reports and their last words. */
export const connectPostTextLimit = Object.freeze({ status: 240, other: 1024 })
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(connectPostTextLimit.other))
const nonBlankPost = Schema.makeFilter((post: { readonly text: string }) =>
  post.text.trim().length > 0 ? undefined : { path: ["text"], issue: "is empty" }
)
export const ConnectPostKind = Schema.Literals(["status", "progress", "skill-feedback", "note", "blocker"])
const statusBound = Schema.makeFilter(
  (post: { readonly kind: typeof ConnectPostKind.Type; readonly text: string }) =>
    post.kind !== "status" || post.text.length <= connectPostTextLimit.status,
  { expected: `status text of at most ${connectPostTextLimit.status} characters` }
)
export const ConnectPostBody = Schema.Struct({
  kind: ConnectPostKind,
  text: Text,
  eventId: Identifier,
  goalStep: Schema.optionalKey(Identifier)
}).check(statusBound, nonBlankPost)
export type ConnectPostBody = typeof ConnectPostBody.Type

/** The host is derived from authenticated node identity, never supplied by the reporter. */
export const ConnectPostRequest = Schema.Struct({ agentId: AgentStableId, ...ConnectPostBody.fields })
  .check(statusBound, nonBlankPost)
/** Stored reports remain readable with whitespace accepted before the write-only blank check. */
export const ConnectPost = Schema.Struct({
  host: FleetHostName,
  agentId: AgentStableId,
  ...ConnectPostBody.fields,
  createdAt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })),
  sequence: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))
}).check(statusBound)
export type ConnectPost = typeof ConnectPost.Type
export const ConnectPostCursor = Schema.Struct({ sequence: ConnectPost.fields.sequence })
export type ConnectPostCursor = typeof ConnectPostCursor.Type
export const connectPostPageMaxRecords = 64
export const ConnectPostPage = Schema.Struct({
  posts: Schema.Array(ConnectPost).check(Schema.isMaxLength(connectPostPageMaxRecords)),
  nextCursor: Schema.NullOr(ConnectPostCursor)
})
export const ConnectLastWords = Schema.Struct({ text: Text, createdAt: ConnectPost.fields.createdAt })

export class InvalidReport extends Schema.TaggedError<InvalidReport>()("InvalidReport", { detail: Schema.String }) {}
export class UnboundAgent extends Schema.TaggedError<UnboundAgent>()("UnboundAgent", { agentId: Schema.String }) {}
export class Denied extends Schema.TaggedError<Denied>()("Denied", {}) {}
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", { eventId: Schema.String }) {}
export class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", { operation: Schema.String }) {}
