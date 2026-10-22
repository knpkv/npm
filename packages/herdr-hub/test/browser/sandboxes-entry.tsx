/**
 * Mount a Sandboxes page as the pool owner, with page-14 and page-15 fixtures and fake reads and writes.
 * Page-15 states and the runs states mount the account or runs page where the design does.
 */
import "../../src/assets.css"
import { PortalProvider } from "@knpkv/rly/foundations"
import { SandboxCard, type SandboxesOverview, SandboxRuns } from "@knpkv/sandbox-pool/host"
import { Effect, Schema } from "effect"
import { createRoot } from "react-dom/client"
import { SandboxesClientError } from "../../src/sandboxes-client.js"
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
  "8d",
  "attention-1a",
  "attention-2a",
  "attention-3a",
  "attention-4a"
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
  "8d": ready([ephemeral01("review-runner-02", "2026-10-17T17:20:00.000Z"), ephemeral02Quarantined], "ok"),
  "attention-1a": ready([ephemeral01Stopped, ephemeral02Quarantined], "ok"),
  "attention-2a": ready([ephemeral01Stopped, ephemeral02Quarantined], "ok"),
  "attention-3a": ready([ephemeral01Stopped, ephemeral02Quarantined], "ok"),
  "attention-4a": ready([ephemeral01Stopped, ephemeral02Quarantined], "ok")
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
    state === "attention-3a"
      ? [requested("Retry"), requested("BudgetLift")]
      : state.startsWith("attention-")
        ? [requested("BudgetLift")]
        : []
})

type Target = { readonly page: "overview" | "account" | "runs"; readonly search: Readonly<Record<string, string>> }
const targetOf = (screen: typeof state): Target => {
  switch (screen) {
    case "attention-2a":
    case "attention-3a":
      return { page: "account", search: { id: "999999999991" } }
    case "attention-4a":
      return { page: "account", search: { id: "999999999990" } }
    case "8d":
      return { page: "runs", search: { id: "999999999991" } }
    case "8c":
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

// The sheets confirm into a write that never settles, so a capture keeps the sheet open.
const writes: SandboxesModuleWrites = { lease: Effect.never, extend: () => Effect.never, release: () => Effect.never }
const caller = Effect.succeed({ login: viewer, owner: state !== "8a" })
const module = makeSandboxesModuleViews({
  reads: {
    overview,
    caller,
    runs: () => Effect.succeed(runs),
    requests: Effect.succeed(requests)
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
