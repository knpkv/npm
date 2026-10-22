/**
 * Mount a Sandboxes page as the pool owner, with page-14 and page-15 fixtures and fake reads and writes.
 * Page-15 states and the runs states mount the account or runs page where the design does.
 */
import "../../src/assets.css"
import { PortalProvider } from "@knpkv/rly/foundations"
import { SandboxCard, type SandboxesOverview, SandboxRunLog, SandboxRuns } from "@knpkv/sandbox-pool/host"
import { Effect, Schema } from "effect"
import { createRoot } from "react-dom/client"
import { SandboxesClientError, SandboxesWriteFailed } from "../../src/sandboxes-client.js"
import { SandboxRequests } from "../../src/sandboxes-contract.js"
import { makeSandboxesModuleViews, type SandboxesModuleWrites } from "../../src/sandboxes-module-view.js"

const SandboxesState = Schema.Literals([
  "1a",
  "3a",
  "4a",
  "4b",
  "5b",
  "7a",
  "7b",
  "8a",
  "8e",
  "8e-late",
  "8f",
  "8f-host",
  "8g",
  "8c",
  "8c-viewer",
  "8d",
  "attention-1a",
  "attention-2a",
  "attention-3a",
  "attention-4a",
  "attention-4a-lift",
  "attention-refused",
  "attention-stale",
  "2a-refused"
])
const parameters = new URLSearchParams(location.search)
const state = Schema.decodeUnknownSync(SandboxesState)(parameters.get("state") ?? "1a")
document.body.dataset["rlyTheme"] = Schema.decodeUnknownSync(Schema.Literals(["light", "dark"]))(
  parameters.get("theme") ?? "dark"
)

const card = Schema.decodeUnknownSync(SandboxCard)
const viewer = "agent-a"
const ephemeral01 = (holder: string, endsAt: string) =>
  card({
    accountId: "999999999990",
    name: "ephemeral-01",
    label: null,
    state: { _tag: "Leased", holder, startedAt: "2026-10-17T09:20:00.000Z", endsAt }
  })
const ephemeral02Free = card({
  accountId: "999999999991",
  name: "ephemeral-02",
  label: null,
  state: { _tag: "Available", lastResetAt: "2026-10-17T11:42:00.000Z" }
})
const ephemeral02Leased = card({
  accountId: "999999999991",
  name: "ephemeral-02",
  label: null,
  state: {
    _tag: "Leased",
    holder: "agent-b",
    startedAt: "2026-10-17T13:05:00.000Z",
    endsAt: "2026-10-17T21:05:00.000Z"
  }
})
const ephemeral01Cleaning = card({
  accountId: "999999999990",
  name: "ephemeral-01",
  label: null,
  state: { _tag: "Cleaning", runId: "wipe-7f3a21", step: "nuke" }
})

const ephemeral02Quarantined = card({
  accountId: "999999999991",
  name: "ephemeral-02",
  label: null,
  state: {
    _tag: "Quarantined",
    runId: "retry-1248",
    step: null,
    blocker: { _tag: "NukeFailed", resourceType: "S3Bucket", text: "S3Bucket could not be removed" }
  }
})
const ephemeral01Stopped = card({
  accountId: "999999999990",
  name: "ephemeral-01",
  label: null,
  state: {
    _tag: "Quarantined",
    runId: "release-1210",
    step: null,
    blocker: { _tag: "BudgetHold", text: "Budget hold. Lift it with sandbox.budget.lift" }
  }
})

const sweptAt = Date.parse("2026-10-17T13:03:00.000Z")
const ready = (sandboxes: ReadonlyArray<SandboxCard>, sweep: "ok" | "late" | "none" = "none"): SandboxesOverview => ({
  _tag: "Ready",
  sandboxes,
  badge: {
    quarantined: 0,
    stale: sweep === "late",
    partial: sweep === "late",
    asOf: sweep === "ok" ? sweptAt : sweep === "late" ? Date.parse("2026-10-16T13:51:00.000Z") : null
  }
})

const pool = ready([ephemeral01("review-runner-02", "2026-10-17T17:20:00.000Z"), ephemeral02Free])
const overviews = {
  "1a": pool,
  "3a": ready([ephemeral01("review-runner-02", "2026-10-17T17:20:00.000Z"), ephemeral02Leased]),
  "4a": ready([ephemeral01(viewer, "2026-10-17T17:20:00.000Z"), ephemeral02Free]),
  "4b": ready([ephemeral01(viewer, "2026-10-18T09:20:00.000Z"), ephemeral02Free]),
  "5b": ready([ephemeral01Cleaning, ephemeral02Free]),
  "7a": pool,
  "7b": pool,
  "8a": pool,
  "8e": ready([ephemeral01("review-runner-02", "2026-10-17T17:20:00.000Z"), ephemeral02Free], "ok"),
  "8e-late": ready([ephemeral01("review-runner-02", "2026-10-17T17:20:00.000Z"), ephemeral02Free], "late"),
  "8f": { _tag: "Unavailable", reason: "not_configured", host: null, message: "not configured" },
  "8f-host": { _tag: "Unavailable", reason: "pool_mismatch", host: "host-a", message: "pool mismatch" },
  "8g": pool,
  "8c": ready([ephemeral01("review-runner-02", "2026-10-17T17:20:00.000Z"), ephemeral02Quarantined], "ok"),
  "8c-viewer": ready([ephemeral01("review-runner-02", "2026-10-17T17:20:00.000Z"), ephemeral02Quarantined], "ok"),
  "8d": ready([ephemeral01("review-runner-02", "2026-10-17T17:20:00.000Z"), ephemeral02Quarantined], "ok"),
  "attention-1a": ready([ephemeral01Stopped, ephemeral02Quarantined], "ok"),
  "attention-2a": ready([ephemeral01Stopped, ephemeral02Quarantined], "ok"),
  "attention-3a": ready([ephemeral01Stopped, ephemeral02Quarantined], "ok"),
  "attention-4a": ready([ephemeral01Stopped, ephemeral02Quarantined], "ok"),
  "attention-4a-lift": ready([ephemeral01Stopped, ephemeral02Quarantined], "ok"),
  "attention-refused": ready([ephemeral01Stopped, ephemeral02Quarantined], "ok"),
  "attention-stale": ready([ephemeral01Stopped, ephemeral02Quarantined], "ok"),
  "2a-refused": pool
} satisfies Record<typeof state, SandboxesOverview>

const runs = Schema.decodeUnknownSync(SandboxRuns)({
  _tag: "Ready",
  accountId: "999999999991",
  next: null,
  runs: [
    {
      runId: "retry-1248",
      step: null,
      blocker: { _tag: "NukeFailed", resourceType: "S3Bucket", text: "S3Bucket could not be removed" },
      outcome: "Quarantined",
      reason: "Retry",
      startedAt: "2026-10-17T12:41:00.000Z",
      endedAt: "2026-10-17T12:48:00.000Z",
      failedStep: "nuke"
    },
    {
      runId: "retry-8a10",
      step: null,
      blocker: null,
      outcome: "Available",
      reason: "Retry",
      startedAt: "2026-10-17T11:36:00.000Z",
      endedAt: "2026-10-17T11:42:00.000Z",
      failedStep: null
    },
    {
      runId: "release-7f3a",
      step: null,
      blocker: { _tag: "ResourcesRemain", count: 3, text: "3 resources still removable" },
      outcome: "Quarantined",
      reason: "Released",
      startedAt: "2026-10-17T10:58:00.000Z",
      endedAt: "2026-10-17T11:07:00.000Z",
      failedStep: "verify"
    }
  ]
})

const runLog = Schema.decodeUnknownSync(SandboxRunLog)({
  _tag: "Ready",
  accountId: "999999999991",
  runId: "release-7f3a",
  raw: "verify: 3 resources still removable. S3Bucket scratch-uploads-k2, IAMRole ci-temp-runner, LogGroup /sandbox/tmp-build",
  lines: [
    { at: "2026-10-17T10:58:01.000Z", text: "run release-7f3a started, reason released, account ephemeral-02" },
    { at: "2026-10-17T10:58:02.000Z", text: "assume role EphemeralCleanup: ok" },
    { at: "2026-10-17T10:58:04.000Z", text: "baseline: 12 baseline resources, matches" },
    { at: "2026-10-17T10:58:05.000Z", text: "config: 41 resource types, 12 baseline filters" },
    { at: "2026-10-17T10:58:05.000Z", text: "input: account ephemeral-02, region eu-central-1" },
    { at: "2026-10-17T10:58:06.000Z", text: "spawn aws-nuke --dry-run" },
    { at: "2026-10-17T10:58:39.000Z", text: "dry run: scan complete" },
    { at: "2026-10-17T10:58:41.000Z", text: "dry run: 41 to remove" },
    { at: "2026-10-17T10:58:42.000Z", text: "guard: no protected resource listed" },
    { at: "2026-10-17T10:58:43.000Z", text: "spawn aws-nuke --no-dry-run" },
    { at: "2026-10-17T10:59:10.000Z", text: "nuke: EC2Instance build-box-1 removed" },
    { at: "2026-10-17T10:59:12.000Z", text: "nuke: EC2Volume build-box-1-data removed" },
    { at: "2026-10-17T10:59:40.000Z", text: "nuke: LambdaFunction thumb-resize removed" },
    { at: "2026-10-17T11:00:05.000Z", text: "nuke: DynamoDBTable scratch-sessions removed" },
    { at: "2026-10-17T11:00:31.000Z", text: "nuke: SQSQueue render-jobs removed" },
    { at: "2026-10-17T11:01:02.000Z", text: "nuke: 20 of 41 removed" },
    { at: "2026-10-17T11:02:47.000Z", text: "nuke: S3Bucket scratch-uploads-k2 waiting for objects" },
    { at: "2026-10-17T11:03:30.000Z", text: "nuke: IAMRole ci-temp-runner in use, retrying" },
    { at: "2026-10-17T11:04:15.000Z", text: "nuke: 31 of 41 removed" },
    { at: "2026-10-17T11:05:20.000Z", text: "nuke: LogGroup /sandbox/tmp-build retrying" },
    { at: "2026-10-17T11:06:02.000Z", text: "nuke: 38 of 41 removed" },
    { at: "2026-10-17T11:06:03.000Z", text: "nuke: finished, removed 38" },
    { at: "2026-10-17T11:06:05.000Z", text: "verify: scanning" },
    { at: "2026-10-17T11:06:40.000Z", text: "verify: S3Bucket scratch-uploads-k2 still present" },
    { at: "2026-10-17T11:06:40.000Z", text: "verify: IAMRole ci-temp-runner still present" },
    { at: "2026-10-17T11:06:40.000Z", text: "verify: LogGroup /sandbox/tmp-build still present" },
    { at: "2026-10-17T11:06:41.000Z", text: "verify: 3 resources still removable" },
    { at: "2026-10-17T11:06:42.000Z", text: "baseline re-check: not run" },
    { at: "2026-10-17T11:06:42.000Z", text: "budget hold: not checked" },
    { at: "2026-10-17T11:07:00.000Z", text: "run release-7f3a ended, account quarantined" }
  ],
  total: 30
})

const requested = (kind: "Retry" | "BudgetLift") =>
  kind === "Retry"
    ? {
        jobId: "job-retry",
        accountId: "999999999991",
        kind,
        title: "Retry one quarantined sandbox account",
        requestedBy: viewer,
        requestedAt: "2026-10-17T13:05:00.000Z",
        expiresAt: "2026-10-17T14:05:00.000Z"
      }
    : {
        jobId: "job-lift",
        accountId: "999999999990",
        kind,
        title: "Lift one sandbox account's budget stop",
        requestedBy: "review-runner-02",
        requestedAt: "2026-10-17T12:58:00.000Z",
        expiresAt: null
      }
const requests = Schema.decodeUnknownSync(SandboxRequests)({
  _tag: "Ready",
  requests:
    state === "attention-3a" || state === "attention-stale"
      ? [requested("Retry"), requested("BudgetLift")]
      : state === "attention-4a-lift" || state === "attention-refused"
        ? []
        : state.startsWith("attention-")
          ? [requested("BudgetLift")]
          : []
})

type Target = { readonly page: "overview" | "account" | "runs"; readonly search: Readonly<Record<string, string>> }
const targetOf = (screen: typeof state): Target => {
  switch (screen) {
    case "attention-2a":
    case "attention-3a":
    case "attention-refused":
    case "attention-stale":
      return { page: "account", search: { id: "999999999991" } }
    case "attention-4a":
    case "attention-4a-lift":
      return { page: "account", search: { id: "999999999990" } }
    case "8d":
      return { page: "runs", search: { id: "999999999991" } }
    case "8c":
    case "8c-viewer":
      return { page: "runs", search: { id: "999999999991", run: "release-7f3a" } }
    default:
      return { page: "overview", search: {} }
  }
}

let reads = 0
const overview = Effect.suspend(() => {
  reads += 1
  if (state === "7a") return Effect.never
  if (state === "7b" || (state === "8g" && reads > 1)) {
    return Effect.fail(new SandboxesClientError({ detail: "network" }))
  }
  return Effect.succeed(overviews[state])
})

// The sheets confirm into a write that never settles, so a capture keeps the sheet open. The refused
// states answer with a refusal instead: a lease Fleet refused, and a retry that is already pending.
const writes: SandboxesModuleWrites = {
  lease: state === "2a-refused" ? Effect.fail(new SandboxesWriteFailed({ reason: "rejected" })) : Effect.never,
  extend: () => Effect.never,
  release: () => Effect.never,
  retry: () =>
    state === "attention-refused"
      ? Effect.fail(new SandboxesWriteFailed({ reason: "already_requested" }))
      : Effect.never,
  liftBudget: () => Effect.never
}

// The stale state answers the first requests read, then fails every poll after it.
let requestReads = 0
const requestsRead = Effect.suspend(() => {
  requestReads += 1
  return state === "attention-stale" && requestReads > 1
    ? Effect.fail(new SandboxesClientError({ detail: "network" }))
    : Effect.succeed(requests)
})
const caller = Effect.succeed({ login: viewer, owner: state !== "8a" && state !== "8c-viewer" })
const module = makeSandboxesModuleViews({
  reads: {
    overview,
    caller,
    runs: () => Effect.succeed(runs),
    runLog: () => Effect.succeed(runLog),
    requests: requestsRead
  },
  timeZone: "UTC",
  writes
})
const target = targetOf(state)
const root = document.querySelector("#root")
if (root !== null) {
  createRoot(root).render(
    <PortalProvider>
      {module.pages[target.page](new URLSearchParams(target.search), {
        active: true,
        navigate: () => undefined,
        closeSelection: () => undefined
      })}
    </PortalProvider>
  )
}
