// @vitest-environment happy-dom
import {
  type SandboxBlocker,
  SandboxCard,
  type SandboxesOverview,
  type SandboxCard as SandboxCardType,
  SandboxRuns
} from "@knpkv/sandbox-pool/host"
import { PortalProvider } from "@knpkv/rly/foundations"
import { DateTime, Effect, Schema } from "effect"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ModulePageMount } from "../src/modules.js"
import { SandboxRequests } from "../src/sandboxes-contract.js"
import {
  makeSandboxesModuleViews,
  SandboxesClientError,
  type SandboxesModuleReads,
  type SandboxesModuleWrites,
  SandboxesWriteFailed
} from "../src/sandboxes-module-view.js"

const card = Schema.decodeUnknownSync(SandboxCard)

const now = "2026-10-17T13:05:00.000Z"

const ready = (sandboxes: ReadonlyArray<SandboxCardType>): SandboxesOverview => ({
  _tag: "Ready",
  sandboxes,
  badge: {
    quarantined: sandboxes.filter((item) => item.state._tag === "Quarantined").length,
    stale: false,
    partial: false,
    asOf: null
  }
})

const leased = (
  name: string,
  accountId: string,
  holder: string,
  startedAt: string,
  endsAt: string,
  label: string | null = null
) => card({ accountId, name, label, state: { _tag: "Leased", holder, startedAt, endsAt } })

const available = (name: string, accountId: string, lastResetAt: string | null) =>
  card({ accountId, name, label: null, state: { _tag: "Available", lastResetAt } })

const runsPage = Schema.decodeUnknownSync(SandboxRuns)
const requestsRead = Schema.decodeUnknownSync(SandboxRequests)

const quarantinedCard = (blocker: SandboxBlocker, runId = "retry-1248") =>
  card({
    accountId: "999999999991",
    name: "ephemeral-02",
    label: null,
    state: { _tag: "Quarantined", runId, step: null, blocker }
  })

const nukeBlocker: SandboxBlocker = {
  _tag: "NukeFailed",
  resourceType: "S3Bucket",
  text: "S3Bucket could not be removed"
}
const budgetBlocker: SandboxBlocker = { _tag: "BudgetHold", text: "Budget hold. Lift it with sandbox.budget.lift" }

const quarantineRuns = runsPage({
  _tag: "Ready",
  accountId: "999999999991",
  next: null,
  runs: [
    {
      runId: "retry-1248",
      step: null,
      blocker: nukeBlocker,
      outcome: "Quarantined",
      reason: "Retry",
      startedAt: "2026-10-17T12:41:00.000Z",
      endedAt: "2026-10-17T12:48:00.000Z",
      failedStep: "nuke"
    },
    {
      runId: "release-1036",
      step: null,
      blocker: null,
      outcome: "Available",
      reason: "Released",
      startedAt: "2026-10-17T10:36:00.000Z",
      endedAt: "2026-10-17T10:42:00.000Z",
      failedStep: null
    }
  ]
})

const noRequests = requestsRead({ _tag: "Ready", requests: [] })

const retryRequest = (requestedBy: string) =>
  requestsRead({
    _tag: "Ready",
    requests: [
      {
        jobId: "job-retry",
        accountId: "999999999991",
        kind: "Retry",
        title: "Retry one quarantined sandbox account",
        requestedBy,
        requestedAt: "2026-10-17T13:05:00.000Z",
        expiresAt: "2026-10-17T14:05:00.000Z"
      }
    ]
  })

const text = (selector: string): string => document.querySelector(selector)?.textContent ?? ""

const buttons = (selector = "button"): Array<string | null> =>
  [...document.querySelectorAll(selector)].map((node) => node.textContent)

const button = (label: string, scope = "") =>
  [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find((node) => node.textContent === label)

const settle = () => act(async () => await vi.advanceTimersByTimeAsync(0))

describe("Sandboxes overview", { concurrent: false }, () => {
  let root: Root | null = null
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    vi.useFakeTimers({ shouldAdvanceTime: false })
    vi.setSystemTime(new Date(now))
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = null
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const render = async (
    overview: SandboxesOverview,
    options: {
      readonly read?: SandboxesModuleReads["overview"]
      readonly owner?: boolean
      readonly caller?: SandboxesModuleReads["caller"]
      readonly writes?: SandboxesModuleWrites | null
      readonly timeZone?: string
      readonly page?: "overview" | "account" | "runs"
      readonly search?: Record<string, string>
      readonly runs?: SandboxesModuleReads["runs"]
      readonly requests?: SandboxesModuleReads["requests"]
    } = {}
  ) => {
    if (root === null) {
      const host = document.createElement("div")
      document.body.append(host)
      root = createRoot(host)
    }
    const navigate = vi.fn<ModulePageMount["navigate"]>()
    const reads: SandboxesModuleReads = {
      overview: options.read ?? Effect.succeed(overview),
      caller: options.caller ?? Effect.succeed({ login: "agent-a", owner: options.owner ?? true }),
      runs: options.runs ?? (() => Effect.succeed(quarantineRuns)),
      requests: options.requests ?? Effect.succeed(noRequests)
    }
    const module = makeSandboxesModuleViews({
      reads,
      writes: options.writes === undefined ? null : options.writes,
      timeZone: options.timeZone ?? "UTC"
    })
    await act(async () =>
      root?.render(
        <PortalProvider>
          {module.pages[options.page ?? "overview"](new URLSearchParams(options.search), {
            active: true,
            navigate,
            closeSelection: () => undefined
          })}
        </PortalProvider>
      )
    )
    await settle()
    return navigate
  }

  const openDialog = async (trigger: HTMLButtonElement | undefined) => {
    expect(trigger).toBeInstanceOf(HTMLButtonElement)
    await act(async () => trigger?.click())
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
    return document.querySelector('[role="dialog"]')
  }

  it("orders the pool quarantined, then leased by soonest end, then cleaning, then available", async () => {
    await render(
      ready([
        available("ephemeral-02", "999999999991", null),
        card({
          accountId: "999999999993",
          name: "ephemeral-04",
          label: null,
          state: { _tag: "Cleaning", runId: "run-clean", step: null }
        }),
        leased("ephemeral-01", "999999999990", "agent-a", "2026-10-17T10:00:00.000Z", "2026-10-17T18:00:00.000Z"),
        leased("ephemeral-05", "999999999994", "agent-b", "2026-10-16T21:05:00.000Z", "2026-10-17T21:05:00.000Z"),
        card({
          accountId: "999999999992",
          name: "ephemeral-03",
          label: null,
          state: { _tag: "Quarantined", runId: "run-q", step: null, blocker: { _tag: "Unknown", text: "Reset failed" } }
        })
      ])
    )
    expect(text("h1")).toBe("Sandboxes")
    const names = [...document.querySelectorAll("[data-account]")].map((node) => node.getAttribute("data-account"))
    expect(names).toEqual(["ephemeral-03", "ephemeral-01", "ephemeral-05", "ephemeral-04", "ephemeral-02"])
    expect(buttons("[data-account] [data-pool-state]")).toEqual([
      "Quarantined",
      "Leased",
      "Leased",
      "Cleaning",
      "Available"
    ])
  })

  it("counts the pool in the summary and names when it was read", async () => {
    await render(
      ready([
        leased("ephemeral-01", "999999999990", "agent-b", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z"),
        available("ephemeral-02", "999999999991", "2026-10-17T11:42:00.000Z")
      ])
    )
    expect(text("[data-pool-summary]")).toBe("1 leased, 1 available.")
    expect(text("[data-pool-read]")).toBe("Read 13:05 from hostd")
  })

  it("shows holder, time left, lease and cap on a lease card, and idle time on an available card", async () => {
    await render(
      ready([
        leased("ephemeral-01", "999999999990", "agent-a", "2026-10-17T01:20:00.000Z", "2026-10-17T17:20:00.000Z"),
        leased("ephemeral-03", "999999999992", "agent-b", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z"),
        available("ephemeral-02", "999999999991", "2026-10-17T11:42:00.000Z")
      ])
    )
    const row = (name: string, key: string) =>
      [...document.querySelectorAll(`[data-account="${name}"] dt`)].find((node) => node.textContent === key)
        ?.nextElementSibling?.textContent
    expect(row("ephemeral-01", "Holder")).toBe("You (agent-a)")
    expect(row("ephemeral-01", "Time left")).toBe("4 h 15 minEnds 17:20")
    expect(row("ephemeral-01", "Lease")).toBe("Started 01:20, extended once8 h of the 24 h cap left")
    expect(row("ephemeral-03", "Holder")).toBe("agent-b")
    expect(row("ephemeral-03", "Lease")).toBe("Started 09:20, not extended16 h of the 24 h cap left")
    expect(row("ephemeral-02", "Holder")).toBe("No one")
    expect(row("ephemeral-02", "Idle")).toBe("1 h 23 min")
    expect(row("ephemeral-02", "Last reset")).toBe("11:42")
  })

  it("names the date of an end that is not today or tomorrow", async () => {
    await render(
      ready([leased("ephemeral-01", "999999999990", "agent-b", "2026-10-19T09:20:00.000Z", "2026-10-19T17:20:00.000Z")])
    )
    expect(text('[data-account="ephemeral-01"]')).toContain("Ends 17:20 on 2026-10-19")
    expect(text('[data-account="ephemeral-01"]')).not.toContain("tomorrow")
  })

  it("keeps time left and the end in agreement on either side of the clock", async () => {
    const row = (name: string) =>
      [...document.querySelectorAll(`[data-account="${name}"] dt`)].find((node) => node.textContent === "Time left")
        ?.nextElementSibling?.textContent
    await render(
      ready([
        // Ends later today.
        leased("ephemeral-01", "999999999990", "agent-b", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z"),
        // Ends tomorrow.
        leased("ephemeral-02", "999999999991", "agent-b", "2026-10-17T12:00:00.000Z", "2026-10-18T04:00:00.000Z"),
        // Ended an hour ago; the sweep has not expired it yet.
        leased("ephemeral-03", "999999999992", "agent-b", "2026-10-17T04:05:00.000Z", "2026-10-17T12:05:00.000Z"),
        // Ended days ago.
        leased("ephemeral-04", "999999999993", "agent-b", "2026-10-14T09:20:00.000Z", "2026-10-14T17:20:00.000Z"),
        // Ends beyond the 24 h cap (a record written before the cap).
        leased("ephemeral-05", "999999999994", "agent-b", "2026-10-17T09:00:00.000Z", "2026-10-18T12:00:00.000Z")
      ])
    )
    expect(row("ephemeral-01")).toBe("4 h 15 minEnds 17:20")
    expect(row("ephemeral-02")).toBe("14 h 55 minEnds 04:00 tomorrow")
    expect(row("ephemeral-03")).toBe("EndedEnded 12:05")
    expect(row("ephemeral-04")).toBe("EndedEnded 17:20 on 2026-10-14")
    expect(row("ephemeral-05")).toBe("22 h 55 minEnds 12:00 tomorrow")
  })

  it("names one end for a lease stored past the 24 h cap", async () => {
    await render(
      ready([leased("ephemeral-05", "999999999994", "agent-b", "2026-10-17T09:00:00.000Z", "2026-10-18T12:00:00.000Z")])
    )
    const card = text('[data-account="ephemeral-05"]')
    expect(card).toContain("Ends 12:00 tomorrow")
    expect(card).toContain("24 h cap reached, ends 12:00 tomorrow")
    expect(card).not.toContain("09:00 tomorrow")
  })

  it("says the sweep has not run when there is no sweep time", async () => {
    await render({ _tag: "Ready", sandboxes: [], badge: { quarantined: 0, stale: true, partial: true, asOf: null } })
    expect(text(".sandboxes-page")).toContain("Sweep has not run yet")
  })

  it("does not count accounts that left the pool as free or freeing", async () => {
    await render(
      ready([
        card({
          accountId: "999999999998",
          name: "ephemeral-09",
          label: "left the pool",
          state: { _tag: "Available", lastResetAt: null }
        }),
        leased(
          "ephemeral-08",
          "999999999997",
          "agent-b",
          "2026-10-17T09:00:00.000Z",
          "2026-10-17T14:00:00.000Z",
          "left the pool"
        ),
        leased("ephemeral-01", "999999999990", "agent-b", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z")
      ])
    )
    expect(button("Lease an account")?.hasAttribute("disabled")).toBe(true)
    expect(text(".sandboxes-page")).toContain("No account is free until 17:20.")
    expect(text("[data-pool-notice]")).toBe("The only account is leased. The next one frees at 17:20.")
    // The retired cards stay on screen.
    expect(document.querySelectorAll("[data-account]")).toHaveLength(3)
  })

  it("names the next free time from leases that have not ended yet", async () => {
    await render(
      ready([
        leased("ephemeral-01", "999999999990", "agent-b", "2026-10-17T04:05:00.000Z", "2026-10-17T12:05:00.000Z"),
        leased("ephemeral-02", "999999999991", "agent-b", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z")
      ])
    )
    expect(text("[data-pool-notice]")).toBe("Both accounts are leased. The next one frees at 17:20.")
    expect(text(".sandboxes-page")).toContain("No account is free until 17:20.")
  })

  it("does not claim a write failed when it may have been sent", async () => {
    const writes: SandboxesModuleWrites = {
      lease: Effect.die("connection reset"),
      extend: () => Effect.void,
      release: () => Effect.void
    }
    await render(ready([available("ephemeral-02", "999999999991", null)]), { writes })
    await openDialog(button("Lease an account"))
    await act(async () => button("Lease longest idle", '[role="dialog"]')?.click())
    await settle()
    expect(text('[role="dialog"] [role="alert"]')).toBe(
      "The lease may not have been submitted. Check the cards before trying again."
    )
  })

  it("names one next-free time in the header and the notice while the pool is stale", async () => {
    // Read at 13:05; the 13:06 end is still ahead then. Two minutes later the read fails and the pool is stale.
    const overview = ready([
      leased("ephemeral-01", "999999999990", "agent-b", "2026-10-17T05:06:00.000Z", "2026-10-17T13:06:00.000Z"),
      leased("ephemeral-02", "999999999991", "agent-b", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z")
    ])
    let reads = 0
    const read = Effect.suspend(() =>
      reads++ === 0 ? Effect.succeed(overview) : Effect.fail(new SandboxesClientError({ detail: "network" }))
    )
    await render(overview, { read })
    await act(async () => await vi.advanceTimersByTimeAsync(120_000))
    expect(text("[data-pool-notice]")).toBe("Both accounts are leased. The next one frees at 13:06.")
    expect(text(".sandboxes-lease")).toContain("No account is free until 13:06.")
  })

  it("says above the cards when every account is leased and when the next one frees", async () => {
    await render(
      ready([
        leased("ephemeral-01", "999999999990", "agent-b", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z"),
        leased("ephemeral-02", "999999999991", "agent-a", "2026-10-17T13:05:00.000Z", "2026-10-17T21:05:00.000Z")
      ])
    )
    expect(text("[data-pool-notice]")).toBe("Both accounts are leased. The next one frees at 17:20.")
    const notice = document.querySelector("[data-pool-notice]")
    const firstCard = document.querySelector("[data-account]")
    expect(
      notice !== null &&
        firstCard !== null &&
        (notice.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    ).toBe(true)
  })

  it("has no pool notice while an account is free", async () => {
    await render(
      ready([
        leased("ephemeral-01", "999999999990", "agent-b", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z"),
        available("ephemeral-02", "999999999991", null)
      ])
    )
    expect(document.querySelector("[data-pool-notice]")).toBeNull()
  })

  it("moves time left on every 15 s tick", async () => {
    // Ends 4 h 15 min 50 s after 13:05. Rounded: 4 h 16 min at the 15 s tick, 4 h 15 min at the 30 s tick.
    const overview = ready([
      leased("ephemeral-01", "999999999990", "agent-b", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:50.000Z")
    ])
    let reads = 0
    // Only the first read answers, so only the clock moves the times.
    const read = Effect.suspend(() => (reads++ === 0 ? Effect.succeed(overview) : Effect.never))
    await render(overview, { read })
    await act(async () => await vi.advanceTimersByTimeAsync(15_000))
    expect(text('[data-account="ephemeral-01"]')).toContain("4 h 16 min")
    await act(async () => await vi.advanceTimersByTimeAsync(15_000))
    expect(text('[data-account="ephemeral-01"]')).toContain("4 h 15 min")
  })

  it("keeps a retired lease Leased and says it left the pool", async () => {
    await render(
      ready([
        leased(
          "ephemeral-09",
          "999999999998",
          "agent-b",
          "2026-10-17T09:20:00.000Z",
          "2026-10-17T17:20:00.000Z",
          "left the pool"
        )
      ])
    )
    expect(text('[data-account="ephemeral-09"] [data-pool-state]')).toBe("Leased")
    expect(text('[data-account="ephemeral-09"]')).toContain("Left the pool")
  })

  it("shows the quarantine blocker words and a link to the account's runs, never a stored reset line", async () => {
    await render(
      ready([
        card({
          accountId: "999999999992",
          name: "ephemeral-03",
          label: null,
          state: {
            _tag: "Quarantined",
            runId: "release-7f3a",
            step: "verify",
            blocker: { _tag: "ResourcesRemain", count: 3, text: "3 resources still removable" }
          }
        })
      ])
    )
    const quarantined = text('[data-account="ephemeral-03"]')
    expect(quarantined).toContain("3 resources still removable")
    expect(quarantined).not.toContain("verify:")
    const viewRun = [...document.querySelectorAll<HTMLAnchorElement>('[data-account="ephemeral-03"] a')].find(
      (node) => node.textContent === "View run"
    )
    expect(viewRun?.getAttribute("href")).toBe("?id=999999999992#sandboxes/runs")
  })

  it("lists the cleanup steps as done, in progress and waiting from the card's current step", async () => {
    await render(
      ready([
        card({
          accountId: "999999999991",
          name: "ephemeral-02",
          label: null,
          state: { _tag: "Cleaning", runId: "run-clean", step: "nuke" }
        })
      ])
    )
    const steps = [...document.querySelectorAll('[data-account="ephemeral-02"] ol[aria-label="Cleanup steps"] li')].map(
      (node) => [
        node.querySelector("[data-step-name]")?.textContent,
        node.querySelector("[data-step-state]")?.textContent
      ]
    )
    expect(steps).toEqual([
      ["Signing in", "Done"],
      ["Checking baseline", "Done"],
      ["Dry run", "Done"],
      ["Removing", "In progress"],
      ["Verifying empty", "Waiting"],
      ["Re-checking baseline", "Waiting"],
      ["Checking budget hold", "Waiting"]
    ])
    expect(text('[data-account="ephemeral-02"]')).toContain("run-clean")
    expect(
      document.querySelector('[data-account="ephemeral-02"] li[aria-current="step"] [data-step-name]')?.textContent
    ).toBe("Removing")
  })

  it("names the longest-idle account on the lease sheet and leases it through the writes", async () => {
    const lease = vi.fn(() => Effect.void)
    const writes: SandboxesModuleWrites = {
      lease: Effect.suspend(lease),
      extend: () => Effect.void,
      release: () => Effect.void
    }
    await render(
      ready([
        available("ephemeral-01", "999999999990", "2026-10-17T12:30:00.000Z"),
        available("ephemeral-02", "999999999991", "2026-10-17T11:42:00.000Z")
      ]),
      { writes }
    )
    const dialog = await openDialog(button("Lease an account"))
    expect(dialog?.textContent).toContain("Longest idle now: free since 11:42 (1 h 23 min).")
    // The job picks the account when it runs, so the sheet does not promise this one.
    expect(dialog?.textContent).toContain("Fleet leases whichever account is longest idle when the job runs.")
    expect(dialog?.textContent).toContain("ephemeral-02")
    expect(dialog?.textContent).toContain("999999999991")
    expect(dialog?.textContent).toContain("21:05")
    expect(dialog?.textContent).toContain("13:05 tomorrow")
    expect(buttons("[data-account] [data-pool-state]")).toEqual(["Available", "Available"])
    expect(lease).not.toHaveBeenCalled()
    await act(async () => button("Lease longest idle", '[role="dialog"]')?.click())
    await settle()
    expect(lease).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    expect(text("[data-pool-submitted]")).toBe("Submitted to Fleet. The cards update when the job runs.")
  })

  it("keeps the pool's order between accounts that were never reset", async () => {
    for (const order of [
      ["ephemeral-01", "ephemeral-02"],
      ["ephemeral-02", "ephemeral-01"]
    ]) {
      await render(
        ready(order.map((name) => available(name, name === "ephemeral-01" ? "999999999990" : "999999999991", null)))
      )
      const dialog = await openDialog(button("Lease an account"))
      expect(dialog?.querySelector(".sandboxes-sheet-account b")?.textContent).toBe(order[0])
      await act(async () => button("Cancel", '[role="dialog"]')?.click())
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    }
  })

  it("does not submit twice when the sheet is closed and reopened while a write is in flight", async () => {
    const lease = vi.fn(() => Effect.never)
    const writes: SandboxesModuleWrites = {
      lease: Effect.suspend(lease),
      extend: () => Effect.void,
      release: () => Effect.void
    }
    await render(ready([available("ephemeral-02", "999999999991", null)]), { writes })
    await openDialog(button("Lease an account"))
    await act(async () => button("Lease longest idle", '[role="dialog"]')?.click())
    await settle()
    await act(async () => button("Cancel", '[role="dialog"]')?.click())
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    await openDialog(button("Lease an account"))
    const confirm = button("Lease longest idle", '[role="dialog"]')
    expect(confirm?.hasAttribute("disabled")).toBe(true)
    await act(async () => confirm?.click())
    await settle()
    expect(lease).toHaveBeenCalledTimes(1)
  })

  it("keeps the sheet open and says so when the lease is refused", async () => {
    const writes: SandboxesModuleWrites = {
      lease: Effect.fail(new SandboxesWriteFailed({ reason: "rejected" })),
      extend: () => Effect.void,
      release: () => Effect.void
    }
    await render(ready([available("ephemeral-02", "999999999991", null)]), { writes })
    await openDialog(button("Lease an account"))
    await act(async () => button("Lease longest idle", '[role="dialog"]')?.click())
    await settle()
    expect(text('[role="dialog"] [role="alert"]')).toBe("The lease wasn’t submitted. Nothing was leased.")
  })

  it("says when only the owner may submit", async () => {
    const writes: SandboxesModuleWrites = {
      lease: Effect.fail(new SandboxesWriteFailed({ reason: "unauthorized" })),
      extend: () => Effect.void,
      release: () => Effect.void
    }
    await render(ready([available("ephemeral-02", "999999999991", null)]), { writes })
    await openDialog(button("Lease an account"))
    await act(async () => button("Lease longest idle", '[role="dialog"]')?.click())
    await settle()
    expect(text('[role="dialog"] [role="alert"]')).toBe("Only the pool owner can lease here. Nothing was leased.")
  })

  it("leases only from the CLI while the pool on screen is stale", async () => {
    let calls = 0
    const overview = ready([available("ephemeral-02", "999999999991", null)])
    const read = Effect.suspend(() => {
      calls += 1
      return calls === 1 ? Effect.succeed(overview) : Effect.fail(new SandboxesClientError({ detail: "network" }))
    })
    const writes: SandboxesModuleWrites = { lease: Effect.void, extend: () => Effect.void, release: () => Effect.void }
    await render(overview, { read, writes })
    await act(async () => await vi.advanceTimersByTimeAsync(30_000))
    const lease = await openDialog(button("Lease an account"))
    expect(lease?.textContent).toContain("Lease from the CLI for now")
    expect(buttons('[role="dialog"] button')).not.toContain("Lease longest idle")
  })

  it("names times in the viewer's time zone", async () => {
    await render(
      ready([
        leased("ephemeral-01", "999999999990", "agent-b", "2026-10-17T09:20:00.000Z", "2026-10-17T22:30:00.000Z")
      ]),
      { timeZone: "Europe/Amsterdam" }
    )
    // 22:30 UTC is 00:30 the next day in Amsterdam (CEST, +2).
    expect(text('[data-account="ephemeral-01"]')).toContain("Ends 00:30 tomorrow")
    expect(text('[data-account="ephemeral-01"]')).toContain("Started 11:20")
    expect(text("[data-pool-read]")).toBe("Read 15:05 from hostd")
  })

  it("points to the CLI instead of a confirm while the hub can't submit jobs", async () => {
    await render(
      ready([
        available("ephemeral-02", "999999999991", null),
        leased("ephemeral-01", "999999999990", "agent-a", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z")
      ])
    )
    const lease = await openDialog(button("Lease an account"))
    expect(lease?.textContent).toContain("Lease from the CLI for now")
    expect(buttons('[role="dialog"] button')).not.toContain("Lease longest idle")
  })

  it("disables lease when nothing is free and names when the next one ends", async () => {
    await render(
      ready([
        leased("ephemeral-01", "999999999990", "agent-b", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z"),
        leased("ephemeral-02", "999999999991", "agent-a", "2026-10-17T13:05:00.000Z", "2026-10-17T21:05:00.000Z")
      ])
    )
    expect(button("Lease an account")?.hasAttribute("disabled")).toBe(true)
    expect(text(".sandboxes-page")).toContain("No account is free until 17:20.")
  })

  it("extends only the viewer's lease and names the new end", async () => {
    const extend = vi.fn((_accountId: string) => Effect.void)
    await render(
      ready([
        leased("ephemeral-02", "999999999991", "agent-b", "2026-10-16T21:05:00.000Z", "2026-10-17T21:05:00.000Z"),
        leased("ephemeral-01", "999999999990", "agent-a", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z")
      ]),
      { writes: { lease: Effect.void, extend, release: () => Effect.void } }
    )
    expect(buttons('[data-account="ephemeral-01"] button')).toEqual(["Copy", "Extend", "Release"])
    expect(buttons('[data-account="ephemeral-02"] button')).toEqual(["Copy"])
    const dialog = await openDialog(button("Extend", '[data-account="ephemeral-01"]'))
    expect(dialog?.textContent).toContain("Adds 8 h to your lease.")
    expect(dialog?.textContent).toContain("17:20")
    expect(dialog?.textContent).toContain("01:20 tomorrow")
    expect(dialog?.textContent).toContain("8 h, cap at 09:20 tomorrow")
    expect(text('[data-account="ephemeral-01"] [data-pool-state]')).toBe("Leased")
    await act(async () => button("Extend to 01:20", '[role="dialog"]')?.click())
    await settle()
    expect(extend).toHaveBeenCalledWith("999999999990")
  })

  it("keeps extend visible and disabled once the lease is at the 24h cap", async () => {
    await render(
      ready([leased("ephemeral-01", "999999999990", "agent-a", "2026-10-17T09:20:00.000Z", "2026-10-18T09:20:00.000Z")])
    )
    expect(button("Extend", '[data-account="ephemeral-01"]')?.hasAttribute("disabled")).toBe(true)
    expect(text('[data-account="ephemeral-01"]')).toContain("Extend: 24-hour cap reached at 09:20 tomorrow.")
  })

  it("confirms release by naming the wipe and releases through the writes", async () => {
    const release = vi.fn((_accountId: string) => Effect.void)
    await render(
      ready([
        leased("ephemeral-01", "999999999990", "agent-a", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z")
      ]),
      { writes: { lease: Effect.void, extend: () => Effect.void, release } }
    )
    const dialog = await openDialog(button("Release"))
    expect(dialog?.textContent).toContain("Releasing ends your lease now and wipes the account.")
    expect(dialog?.textContent).toContain("Dry run")
    expect(dialog?.textContent).toContain("Nuke")
    expect(dialog?.textContent).toContain("Verify")
    expect(dialog?.textContent).toContain("Everything in ephemeral-01 is deleted. This can’t be undone.")
    expect(text('[data-account="ephemeral-01"] [data-pool-state]')).toBe("Leased")
    expect(release).not.toHaveBeenCalled()
    await act(async () => button("Release and wipe", '[role="dialog"]')?.click())
    await settle()
    expect(release).toHaveBeenCalledWith("999999999990")
  })

  it("keeps two skeleton cards while the first read is pending", async () => {
    await render(ready([]), { read: Effect.never })
    expect(document.querySelectorAll("[data-skeleton]")).toHaveLength(2)
    expect(document.querySelector("[data-account]")).toBeNull()
  })

  it("shows one panel when the read fails and reads again from that panel", async () => {
    let reads = 0
    const read = Effect.suspend(() => {
      reads += 1
      return Effect.fail(new SandboxesClientError({ detail: "network" }))
    })
    await render(ready([]), { read })
    expect(document.querySelector("[data-account]")).toBeNull()
    expect(document.querySelectorAll("[data-skeleton]")).toHaveLength(0)
    expect(text(".sandboxes-page")).toContain("Can’t read the pool from hostd")
    expect(text(".sandboxes-page")).toContain(
      "Accounts and leases aren’t shown until the lease store answers. Nothing was changed."
    )
    expect(reads).toBe(1)
    await act(async () => button("Read again")?.click())
    await settle()
    expect(reads).toBe(2)
    expect(document.querySelector("[data-account]")).toBeNull()
  })

  it("treats a failed store read and a reader that could not start as the same failed panel", async () => {
    for (const overview of [
      { _tag: "Failed", reason: "unavailable" },
      { _tag: "Unavailable", reason: "unavailable", host: "host-a", message: "down" }
    ] satisfies ReadonlyArray<SandboxesOverview>) {
      await render(overview)
      expect(text(".sandboxes-page")).toContain("Can’t read the pool from hostd")
      expect(button("Read again")).toBeInstanceOf(HTMLButtonElement)
      expect(button("Lease an account")).toBeUndefined()
    }
  })

  it("shows one calm panel and no lease when this hub has no pool", async () => {
    await render({ _tag: "Unavailable", reason: "not_configured", host: null, message: "not configured" })
    expect(text(".sandboxes-page")).toContain("Not set up")
    expect(text(".sandboxes-page")).toContain("Sandboxes aren’t set up on this hub.")
    expect(button("Lease an account")).toBeUndefined()
    expect(document.querySelector("[data-pool-summary]")).toBeNull()
  })

  it("names the host whose pool is not configured", async () => {
    await render({ _tag: "Unavailable", reason: "pool_mismatch", host: "host-a", message: "mismatch" })
    expect(text(".sandboxes-page")).toContain("Not configured")
    expect(text(".sandboxes-page")).toContain("The pool isn’t configured on host-a.")
    expect(button("Lease an account")).toBeUndefined()
  })

  it("keeps the last values marked last known when a later read fails", async () => {
    let calls = 0
    const overview = ready([
      leased("ephemeral-01", "999999999990", "agent-b", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z")
    ])
    const read = Effect.suspend(() => {
      calls += 1
      return calls === 1 ? Effect.succeed(overview) : Effect.fail(new SandboxesClientError({ detail: "network" }))
    })
    await render(overview, { read })
    expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? "").toBe("")
    await act(async () => await vi.advanceTimersByTimeAsync(120_000))
    expect(calls).toBeGreaterThan(1)
    expect(text('[role="status"][aria-live="polite"]')).toBe("Stale, updated 2m ago")
    expect(text('[data-account="ephemeral-01"]')).toContain("Last known at 13:05")
    // The card's times stay as they were read, not as the clock moves on.
    expect(text('[data-account="ephemeral-01"]')).toContain("4 h 15 min")
    expect(text('[data-account="ephemeral-01"] [data-pool-state]')).toBe("Leased")
    expect(text("[data-pool-read]")).toBe("Read 13:05 from hostd")
  })

  it("shows no owner actions until the caller read answers, or when it fails", async () => {
    const pool = ready([
      available("ephemeral-02", "999999999991", null),
      leased("ephemeral-01", "999999999990", "agent-a", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z")
    ])
    for (const caller of [Effect.never, Effect.fail(new SandboxesClientError({ detail: "network" }))]) {
      await render(pool, { caller })
      expect(buttons()).not.toContain("Lease an account")
      expect(buttons()).not.toContain("Extend")
      expect(document.querySelector("button[aria-label='Copy account ID 999999999990']")).not.toBeNull()
    }
  })

  it("takes the viewer's own lease from the caller's login", async () => {
    await render(
      ready([
        leased("ephemeral-01", "999999999990", "agent-b", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z")
      ]),
      { caller: Effect.succeed({ login: "agent-b", owner: true }) }
    )
    expect(buttons('[data-account="ephemeral-01"] button')).toEqual(["Copy", "Extend", "Release"])
  })

  it("hides lease, extend and release from a viewer and still copies the account id", async () => {
    const writeText = vi.fn(() => Promise.resolve())
    const prior = Object.getOwnPropertyDescriptor(navigator, "clipboard")
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    try {
      await render(
        ready([
          leased("ephemeral-01", "999999999990", "agent-a", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z")
        ]),
        { owner: false }
      )
      const labels = buttons()
      expect(labels).not.toContain("Lease an account")
      expect(labels).not.toContain("Extend")
      expect(labels).not.toContain("Release")
      expect(text(".sandboxes-page")).toContain(
        "Only the owner can lease or reset sandboxes here. Agents lease through Fleet jobs."
      )
      const copy = document.querySelector<HTMLButtonElement>("button[aria-label='Copy account ID 999999999990']")
      expect(copy).not.toBeNull()
      await act(async () => copy?.click())
      expect(writeText).toHaveBeenCalledWith("999999999990")
    } finally {
      if (prior === undefined) Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
      else Object.defineProperty(navigator, "clipboard", prior)
    }
  })

  it("shows the last sweep time and no sweep button", async () => {
    const asOf = DateTime.makeUnsafe("2026-10-17T13:03:00.000Z").epochMilliseconds
    await render({ _tag: "Ready", sandboxes: [], badge: { quarantined: 0, stale: false, partial: false, asOf } })
    expect(text(".sandboxes-page")).toContain("Sweep last 13:03")
    expect(buttons().some((label) => /sweep/i.test(label ?? ""))).toBe(false)
  })

  it("says the sweep is late when the badge is stale", async () => {
    const asOf = DateTime.makeUnsafe("2026-10-16T13:51:00.000Z").epochMilliseconds
    await render({ _tag: "Ready", sandboxes: [], badge: { quarantined: 0, stale: true, partial: true, asOf } })
    expect(text(".sandboxes-page")).toContain("Sweep late, last ran 13:51 yesterday")
    expect(buttons().some((label) => /sweep/i.test(label ?? ""))).toBe(false)
  })

  it("shows a quarantine on its account page: blocker words, run id, since and the failed step", async () => {
    await render(ready([quarantinedCard(nukeBlocker)]), { page: "account", search: { id: "999999999991" } })
    expect(text(".sandboxes-page h1")).toBe("ephemeral-02")
    expect(text(".sandboxes-page [data-account-state]")).toBe("Quarantined")
    expect(text("[data-account-summary]")).toBe(
      "The reset failed at Nuke. Quarantined since 12:48; no one can lease it until a reset passes."
    )
    expect(text("[data-account-blocker]")).toBe("S3Bucket could not be removed")
    const facts = [...document.querySelectorAll(".sandboxes-account dl > div")].map((row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent
    ])
    expect(facts).toEqual([
      ["Run ID", "retry-1248"],
      ["Since", "12:48"],
      ["Failed step", "Nuke"]
    ])
    const steps = [...document.querySelectorAll('ol[aria-label="Reset steps"] li')].map((node) => [
      node.querySelector("[data-step-name]")?.textContent,
      node.querySelector("[data-step-state]")?.textContent
    ])
    expect(steps.slice(2, 5)).toEqual([
      ["Dry run", "Done"],
      ["Nuke", "Failed"],
      ["Verify", "Not run"]
    ])
    expect(
      document.querySelector('ol[aria-label="Reset steps"] li[aria-current="step"] [data-step-name]')?.textContent
    ).toBe("Nuke")
    expect(document.querySelector<HTMLAnchorElement>("a[data-back]")?.getAttribute("href")).toBe("?#sandboxes/overview")
    expect(text(".sandboxes-page")).not.toContain("nuke:")
  })

  it("shows a pending retry as Approval requested, who asked, that it waits on an approver, and links Fleet", async () => {
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "account",
      search: { id: "999999999991" },
      requests: Effect.succeed(retryRequest("agent-a"))
    })
    const request = document.querySelector("[data-request]")
    expect(request?.getAttribute("role")).toBe("status")
    expect(request?.querySelector("[data-request-state]")?.textContent).toBe("Approval requested")
    expect(request?.querySelector("[data-request-line]")?.textContent).toBe(
      "Retry reset, requested by you at 13:05. Waits on an approver."
    )
    expect(request?.querySelector("[data-request-waits]")?.textContent).toBe(
      "Nothing runs until it’s approved. 1 h left, expires 14:05."
    )
    const link = request?.querySelector<HTMLAnchorElement>("a")
    expect(link?.textContent).toBe("Open “Retry one quarantined sandbox account” in Fleet / Approvals")
    expect(link?.getAttribute("href")).toBe("?#fleet/approvals")
    expect(document.querySelector("[aria-busy='true'], [role='progressbar']")).toBeNull()
  })

  it("names another requester by login", async () => {
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "account",
      search: { id: "999999999991" },
      requests: Effect.succeed(retryRequest("review-runner-02"))
    })
    expect(text("[data-request-line]")).toBe(
      "Retry reset, requested by review-runner-02 at 13:05. Waits on an approver."
    )
  })

  it("shows a budget stop in caution words, not red, with no stored hold line", async () => {
    await render(ready([quarantinedCard(budgetBlocker)]), { page: "account", search: { id: "999999999991" } })
    const label = document.querySelector(".sandboxes-page [data-account-state]")
    expect(label?.textContent).toBe("Stopped by budget")
    expect(label?.getAttribute("data-tone")).toBe("caution")
    expect(text("[data-account-summary]")).toBe(
      "Budget hold: this account passed its monthly spend cap, so it’s locked until an approver lifts the hold. Cleanup still ran."
    )
    expect(text(".sandboxes-page")).not.toContain("sandbox.budget.lift")
    expect(text(".sandboxes-page")).not.toContain("DenyAll")
  })

  it("has no owner actions on the account page for a viewer, and keeps copy account id", async () => {
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "account",
      search: { id: "999999999991" },
      owner: false
    })
    expect(buttons(".sandboxes-page button")).toEqual(["Copy"])
  })

  it("says when the account is not in this pool, and when the id is not an account id", async () => {
    await render(ready([quarantinedCard(nukeBlocker)]), { page: "account", search: { id: "999999999999" } })
    expect(text(".sandboxes-panel h2")).toBe("No account 999999999999 in this pool.")
    await render(ready([quarantinedCard(nukeBlocker)]), { page: "account", search: { id: "nope" } })
    expect(text(".sandboxes-panel h2")).toBe("No account nope in this pool.")
  })

  it("says Fleet requests couldn’t be read instead of showing none", async () => {
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "account",
      search: { id: "999999999991" },
      requests: Effect.fail(new SandboxesClientError({ detail: "status" }))
    })
    expect(text("[data-requests-failed]")).toBe("Fleet requests couldn’t be read.")
  })

  it("lists an account's runs with reason, outcome, duration and start, newest first", async () => {
    await render(ready([quarantinedCard(nukeBlocker)]), { page: "runs", search: { id: "999999999991" } })
    expect(text(".sandboxes-page h1")).toBe("ephemeral-02")
    expect(text(".sandboxes-runs h2")).toBe("Recent runs")
    const rows = [...document.querySelectorAll(".sandboxes-runs tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].slice(0, 5).map((cell) => cell.textContent)
    )
    expect(rows).toEqual([
      ["ephemeral-02", "Retry", "Quarantined", "7 min", "12:41"],
      ["ephemeral-02", "Released", "Available", "6 min", "10:36"]
    ])
    expect(document.querySelector<HTMLAnchorElement>(".sandboxes-runs tbody a")?.getAttribute("href")).toBe(
      "?id=999999999991&run=retry-1248#sandboxes/runs"
    )
  })

  it("says the runs can't be read, and reading, without naming the host service", async () => {
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "runs",
      search: { id: "999999999991" },
      runs: () => Effect.fail(new SandboxesClientError({ detail: "network" }))
    })
    expect(text(".sandboxes-panel")).toBe("Can’t readCan’t read runs.")
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "runs",
      search: { id: "999999999991" },
      runs: () => Effect.never
    })
    expect(text("[data-runs-loading]")).toBe("Reading runs…")
  })

  it("opens one run's detail with the failed step's blocker words and none of the stored lines", async () => {
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "runs",
      search: { id: "999999999991", run: "retry-1248" }
    })
    const dialog = await vi.waitFor(() => {
      const found = document.querySelector('[role="dialog"]')
      expect(found).not.toBeNull()
      return found
    })
    expect(dialog?.textContent).toContain("Cleanup run")
    expect(dialog?.textContent).toContain("retry-1248")
    const steps = [...(dialog?.querySelectorAll('ol[aria-label="Cleanup steps"] li') ?? [])].map((node) => [
      node.querySelector("[data-step-name]")?.textContent,
      node.querySelector("[data-step-state]")?.textContent
    ])
    expect(steps[3]).toEqual(["Removing", "Failed"])
    expect(steps[4]).toEqual(["Verifying empty", "Not run"])
    expect(dialog?.querySelector("[data-step-blocker]")?.textContent).toBe("S3Bucket could not be removed")
    expect(dialog?.textContent).not.toContain("Log")
    expect(dialog?.textContent).not.toContain("arn:")
  })

  it("shows a run that ended available as all done, even when one of its steps failed and was retried", async () => {
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "runs",
      search: { id: "999999999991", run: "resumed-1300" },
      runs: () =>
        Effect.succeed(
          runsPage({
            _tag: "Ready",
            accountId: "999999999991",
            next: null,
            runs: [
              {
                runId: "resumed-1300",
                step: null,
                blocker: null,
                outcome: "Available",
                reason: "Retry",
                startedAt: "2026-10-17T12:50:00.000Z",
                endedAt: "2026-10-17T13:00:00.000Z",
                failedStep: "nuke"
              }
            ]
          })
        )
    })
    const dialog = await vi.waitFor(() => {
      const found = document.querySelector('[role="dialog"]')
      expect(found).not.toBeNull()
      return found
    })
    const states = [...(dialog?.querySelectorAll("[data-step-state]") ?? [])].map((node) => node.textContent)
    expect(new Set(states)).toEqual(new Set(["Done"]))
  })

  it("puts quarantine first as the only red, then a budget stop in caution, with its pending request", async () => {
    await render(
      ready([
        leased("ephemeral-01", "999999999990", "agent-b", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z"),
        quarantinedCard(nukeBlocker),
        card({
          accountId: "999999999992",
          name: "ephemeral-03",
          label: null,
          state: { _tag: "Quarantined", runId: "run-hold", step: null, blocker: budgetBlocker }
        })
      ]),
      {
        requests: Effect.succeed(
          requestsRead({
            _tag: "Ready",
            requests: [
              {
                jobId: "job-lift",
                accountId: "999999999992",
                kind: "BudgetLift",
                title: "Lift one sandbox account's budget stop",
                requestedBy: "review-runner-02",
                requestedAt: "2026-10-17T12:58:00.000Z",
                expiresAt: null
              }
            ]
          })
        )
      }
    )
    const names = [...document.querySelectorAll("[data-account]")].map((node) => node.getAttribute("data-account"))
    expect(names).toEqual(["ephemeral-02", "ephemeral-03", "ephemeral-01"])
    const tones = [...document.querySelectorAll("[data-account] [data-pool-state]")].map((node) => [
      node.textContent,
      node.getAttribute("data-tone")
    ])
    expect(tones).toEqual([
      ["Quarantined", "critical"],
      ["Stopped by budget", "caution"],
      ["Leased", "progress"]
    ])
    expect(text("[data-pool-summary]")).toBe("1 quarantined, 1 stopped by budget, 1 leased.")
    const held = document.querySelector('[data-account="ephemeral-03"]')
    expect(held?.querySelector("[data-request-state]")?.textContent).toBe("Approval requested")
    expect(held?.querySelector("[data-request-line]")?.textContent).toBe(
      "Budget lift requested by review-runner-02 at 12:58. Waits on an approver."
    )
    expect(held?.querySelector("a[href='?#fleet/approvals']")).not.toBeNull()
    const open = [...document.querySelectorAll<HTMLAnchorElement>('[data-account="ephemeral-02"] a')].find(
      (node) => node.textContent === "Open quarantine"
    )
    expect(open?.getAttribute("href")).toBe("?id=999999999991#sandboxes/account")
    expect(button("Lease an account")?.disabled).toBe(true)
  })
})
