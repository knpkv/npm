/**
 * What the Sandboxes page and its module routes exchange beyond the read model: who is reading, and the
 * jobs the page may ask for. Shared by the browser and the server, so it imports no server code.
 * @module
 */
import { JobStatus } from "@knpkv/herdr-fleet/model"
import { SandboxCard, SandboxesUnavailable, SandboxSignIn } from "@knpkv/sandbox-pool/host"
import { Schema } from "effect"

const AccountId = SandboxCard.fields.accountId

/**
 * Who is reading the page. `owner` is true only for the hub's own tailnet node, the one that may submit jobs.
 * `signIn` is the pool's console and CLI sign-in, for the owner only; null for anyone else or a pool without it.
 * `poolMode` is the mode this host runs the pool in (only live runs jobs); null where no pool is served.
 * `awsSignedIn` tells anyone but the owner only whether the hub holds an AWS sign-in, never what to approve; null
 * for the owner, who reads the whole state from aws-session, and where it is not known.
 */
export const SandboxesCaller = Schema.Struct({
  login: Schema.String,
  owner: Schema.Boolean,
  signIn: Schema.NullOr(SandboxSignIn),
  poolMode: Schema.NullOr(Schema.Literals(["off", "observe", "live"])),
  awsSignedIn: Schema.NullOr(Schema.Boolean)
})
export type SandboxesCaller = typeof SandboxesCaller.Type

/**
 * A job the page may ask for: lease the longest idle account, extend or release the caller's own lease, or
 * ask Fleet to retry a quarantine's reset or lift a budget stop. Retry and BudgetLift always wait for an
 * approval in Fleet; the record they are approved against is bound by the owner host, never sent here.
 */
export const SandboxJobOrder = Schema.TaggedUnion({
  Lease: {},
  Extend: { accountId: AccountId },
  Release: { accountId: AccountId },
  Retry: { accountId: AccountId },
  BudgetLift: { accountId: AccountId }
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

/**
 * The hub's own AWS sign-in, for the owner only: `NotConfigured` when this pool has no AWS sign-in,
 * `SignInPending` with what to approve (its URL and code let whoever holds them finish the sign-in), or
 * `SignInRequired`: `never` signed in, or the sign-in it held `ended`. Or why the pool is not served here.
 */
/** The page a waiting sign-in is approved on. Only an https URL decodes, so the link can never run script. */
const VerificationUri = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter(
    (value) => URL.canParse(value) && new URL(value).protocol === "https:" && new URL(value).hostname.length > 0,
    { expected: "an https URL" }
  )
)

export const SandboxAwsSession = Schema.Union([
  SandboxesUnavailable,
  Schema.TaggedStruct("NotConfigured", {}),
  Schema.TaggedStruct("SignedIn", { expiresAt: Instant }),
  Schema.TaggedStruct("SignInPending", {
    verificationUri: VerificationUri,
    userCode: Schema.String,
    expiresAt: Instant
  }),
  Schema.TaggedStruct("SignInRequired", { reason: Schema.Literals(["never", "ended"]) })
])
export type SandboxAwsSession = typeof SandboxAwsSession.Type
