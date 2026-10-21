/**
 * What the Sandboxes page and its module routes exchange beyond the read model: who is reading, and the
 * jobs the page may ask for. Shared by the browser and the server, so it imports no server code.
 * @module
 */
import { JobStatus } from "@knpkv/herdr-fleet/model"
import { SandboxCard } from "@knpkv/sandbox-pool/host"
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
