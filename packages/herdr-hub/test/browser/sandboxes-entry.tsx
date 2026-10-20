/** Mount the Sandboxes overview as the pool owner, with page-14 fixtures and fake reads and writes. */
import "../../src/assets.css"
import { PortalProvider } from "@knpkv/rly/foundations"
import { SandboxCard, type SandboxesOverview } from "@knpkv/sandbox-pool/host"
import { Effect, Schema } from "effect"
import { createRoot } from "react-dom/client"
import { SandboxesClientError } from "../../src/sandboxes-client.js"
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
  "8g"
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
  "8g": pool
} satisfies Record<typeof state, SandboxesOverview>

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
const module = makeSandboxesModuleViews({ owner: state !== "8a", reads: { overview }, timeZone: "UTC", viewer, writes })
const root = document.querySelector("#root")
if (root !== null) {
  createRoot(root).render(
    <PortalProvider>
      {module.pages.overview(new URLSearchParams(), {
        active: true,
        navigate: () => undefined,
        closeSelection: () => undefined
      })}
    </PortalProvider>
  )
}
