/**
 * What the Sandboxes page and its module routes exchange beyond the read model: who is reading, and the
 * jobs the page may ask for. Shared by the browser and the server, so it imports no server code.
 * @module
 */
import { JobStatus } from "@knpkv/herdr-fleet/model"
import { SandboxCard, SandboxesUnavailable } from "@knpkv/sandbox-pool/host"
import { Schema } from "effect"

const AccountId = SandboxCard.fields.accountId

/** Who is reading the page. `owner` is true only for the hub's own tailnet node, the one that may submit jobs. */
export const SandboxesCaller = Schema.Struct({ login: Schema.String, owner: Schema.Boolean })
export type SandboxesCaller = typeof SandboxesCaller.Type

/** A job the page may ask for: lease the longest idle account, or extend or release the caller's own lease. */
export const SandboxJobOrder = Schema.TaggedUnion({
  Lease: {},
  Extend: { accountId: AccountId },
  Release: { accountId: AccountId }
})
export type SandboxJobOrder = typeof SandboxJobOrder.Type

export const SandboxJobSubmitted = Schema.Struct({ jobId: Schema.String, status: JobStatus })
export type SandboxJobSubmitted = typeof SandboxJobSubmitted.Type

const Instant = Schema.DateTimeUtcFromString

/**
 * A reset or budget lift waiting in Fleet / Approvals. `title` is Fleet's own title for the request, so the
 * link names what Fleet shows. `requestedBy` is the requester's login; `expiresAt` is null without a deadline.
 */
export const SandboxRequest = Schema.Struct({
  jobId: Schema.String,
  accountId: AccountId,
  kind: Schema.Literals(["Retry", "Manual", "BudgetLift"]),
  title: Schema.String,
  requestedBy: Schema.String,
  requestedAt: Instant,
  expiresAt: Schema.NullOr(Instant)
})
export interface SandboxRequest extends Schema.Schema.Type<typeof SandboxRequest> {}

/** Pending sandbox requests, oldest first, or why the pool is not served here. */
export const SandboxRequests = Schema.Union([
  SandboxesUnavailable,
  Schema.TaggedStruct("Ready", { requests: Schema.Array(SandboxRequest) })
])
export type SandboxRequests = typeof SandboxRequests.Type
