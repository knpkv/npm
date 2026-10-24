// @vitest-environment happy-dom
import {
  type SandboxBlocker,
  SandboxCard,
  type SandboxesOverview,
  type SandboxCard as SandboxCardType,
  SandboxRunLog,
  SandboxRuns,
  SandboxSignIn
} from "@knpkv/sandbox-pool/host"
import { PortalProvider } from "@knpkv/rly/foundations"
import { DateTime, Effect, Schema } from "effect"
import { act, type ReactNode, useLayoutEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ModulePageMount } from "../src/modules.js"
import { type SandboxAwsSession, SandboxRequests } from "../src/sandboxes-contract.js"
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
  },
  spendLimits: null
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

const retryLog = Schema.decodeUnknownSync(SandboxRunLog)({
  _tag: "Ready",
  accountId: "999999999991",
  runId: "retry-1248",
  raw: "nuke: S3Bucket example-bucket - failed: BucketNotEmpty",
  lines: [
    { at: "2026-10-17T12:47:10.000Z", text: "nuke: S3Bucket example-bucket waiting for objects" },
    { at: "2026-10-17T12:48:02.000Z", text: "run retry-1248 ended, account quarantined" }
  ],
  total: 41
})

const signIn = Schema.decodeUnknownSync(SandboxSignIn)({
  portalUrl: "https://portal.example.test/start",
  ssoSession: "example-session",
  roleName: "ExampleDeveloper",
  region: "eu-central-1"
})

/** Page 14 8c: the release run that stopped at verify, with each step's time and the scans' counts. */
const steppedRuns = runsPage({
  _tag: "Ready",
  accountId: "999999999991",
  next: null,
  runs: [
    {
      runId: "release-7f3a",
      step: null,
      blocker: { _tag: "ResourcesRemain", count: 3, text: "3 resources still removable" },
      outcome: "Quarantined",
      reason: "Released",
      startedAt: "2026-10-17T10:58:00.000Z",
      endedAt: "2026-10-17T11:07:00.000Z",
      failedStep: "verify",
      steps: [
        { step: "sign in", status: "done", at: "2026-10-17T10:58:02.000Z", count: null },
        { step: "baseline", status: "done", at: "2026-10-17T10:58:04.000Z", count: null },
        { step: "dry run", status: "done", at: "2026-10-17T10:58:41.000Z", count: 41 },
        { step: "nuke", status: "done", at: "2026-10-17T11:06:03.000Z", count: null },
        { step: "verify", status: "failed", at: "2026-10-17T11:06:41.000Z", count: 3 },
        { step: "baseline re-check", status: "notRun", at: null, count: null },
        { step: "budget hold", status: "notRun", at: null, count: null }
      ]
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

/** Retry, lift and AWS sign-in writes for tests that only lease, extend or release. */
const noRequestWrites: Pick<SandboxesModuleWrites, "retry" | "liftBudget" | "startAwsSignIn"> = {
  retry: () => Effect.void,
  liftBudget: () => Effect.void,
  startAwsSignIn: Effect.succeed({ _tag: "NotConfigured" })
}

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
      readonly signIn?: SandboxSignIn
      readonly caller?: SandboxesModuleReads["caller"]
      readonly writes?: SandboxesModuleWrites | null
      readonly timeZone?: string
      readonly page?: "overview" | "account" | "runs"
      readonly search?: Record<string, string>
      readonly runs?: SandboxesModuleReads["runs"]
      readonly runLog?: SandboxesModuleReads["runLog"]
      readonly requests?: SandboxesModuleReads["requests"]
      readonly awsSession?: SandboxesModuleReads["awsSession"]
      readonly poolMode?: "off" | "observe" | "live" | null
      readonly awsSignedIn?: boolean | null
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
      caller:
        options.caller ??
        Effect.succeed({
          login: "agent-a",
          owner: options.owner ?? true,
          signIn: options.signIn ?? null,
          poolMode: options.poolMode === undefined ? "live" : options.poolMode,
          awsSignedIn: options.awsSignedIn ?? null
        }),
      runs: options.runs ?? (() => Effect.succeed(quarantineRuns)),
      runLog: options.runLog ?? (() => Effect.succeed(retryLog)),
      requests: options.requests ?? Effect.succeed(noRequests),
      awsSession: options.awsSession ?? Effect.succeed({ _tag: "NotConfigured" })
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
    await render({
      _tag: "Ready",
      sandboxes: [],
      badge: { quarantined: 0, stale: true, partial: true, asOf: null },
      spendLimits: null
    })
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
      release: () => Effect.void,
      ...noRequestWrites
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
      release: () => Effect.void,
      ...noRequestWrites
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
      release: () => Effect.void,
      ...noRequestWrites
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
      release: () => Effect.void,
      ...noRequestWrites
    }
    await render(ready([available("ephemeral-02", "999999999991", null)]), { writes })
    await openDialog(button("Lease an account"))
    await act(async () => button("Lease longest idle", '[role="dialog"]')?.click())
    await settle()
    expect(text('[role="dialog"] [role="alert"]')).toBe("The lease wasn’t submitted. Nothing was leased.")
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.className).toBe("sandboxes-refusal")
  })

  it("says when only the owner may submit", async () => {
    const writes: SandboxesModuleWrites = {
      lease: Effect.fail(new SandboxesWriteFailed({ reason: "unauthorized" })),
      extend: () => Effect.void,
      release: () => Effect.void,
      ...noRequestWrites
    }
    await render(ready([available("ephemeral-02", "999999999991", null)]), { writes })
    await openDialog(button("Lease an account"))
    await act(async () => button("Lease longest idle", '[role="dialog"]')?.click())
    await settle()
    expect(text('[role="dialog"] [role="alert"]')).toBe("Only the pool owner can lease here. Nothing was leased.")
  })

  it("says when the pool is in observe mode and runs no jobs", async () => {
    const writes: SandboxesModuleWrites = {
      lease: Effect.fail(new SandboxesWriteFailed({ reason: "observe_mode" })),
      extend: () => Effect.void,
      release: () => Effect.void,
      ...noRequestWrites
    }
    await render(ready([available("ephemeral-02", "999999999991", null)]), { writes })
    await openDialog(button("Lease an account"))
    await act(async () => button("Lease longest idle", '[role="dialog"]')?.click())
    await settle()
    expect(text('[role="dialog"] [role="alert"]')).toBe(
      "The pool is in observe mode: it reads spend and runs no jobs. Nothing was leased."
    )
  })

  it("leases only from the CLI while the pool on screen is stale", async () => {
    let calls = 0
    const overview = ready([available("ephemeral-02", "999999999991", null)])
    const read = Effect.suspend(() => {
      calls += 1
      return calls === 1 ? Effect.succeed(overview) : Effect.fail(new SandboxesClientError({ detail: "network" }))
    })
    const writes: SandboxesModuleWrites = {
      lease: Effect.void,
      extend: () => Effect.void,
      release: () => Effect.void,
      ...noRequestWrites
    }
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
      { writes: { lease: Effect.void, extend, release: () => Effect.void, ...noRequestWrites } }
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
      { writes: { lease: Effect.void, extend: () => Effect.void, release, ...noRequestWrites } }
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
      {
        caller: Effect.succeed({ login: "agent-b", owner: true, signIn: null, poolMode: "live", awsSignedIn: null })
      }
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
    await render({
      _tag: "Ready",
      sandboxes: [],
      badge: { quarantined: 0, stale: false, partial: false, asOf },
      spendLimits: null
    })
    expect(text(".sandboxes-page")).toContain("Sweep last 13:03")
    expect(buttons().some((label) => /sweep/i.test(label ?? ""))).toBe(false)
  })

  it("says the sweep is late when the badge is stale", async () => {
    const asOf = DateTime.makeUnsafe("2026-10-16T13:51:00.000Z").epochMilliseconds
    await render({
      _tag: "Ready",
      sandboxes: [],
      badge: { quarantined: 0, stale: true, partial: true, asOf },
      spendLimits: null
    })
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

  it("opens one run's detail for a viewer with the failed step's blocker words and none of the stored lines", async () => {
    const asked: Array<string> = []
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "runs",
      owner: false,
      search: { id: "999999999991", run: "retry-1248" },
      runLog: (_accountId, runId) =>
        Effect.sync(() => {
          asked.push(runId)
          return retryLog
        })
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
    expect(dialog?.querySelector("[data-step-raw]")).toBeNull()
    expect(asked).toEqual([])
  })

  it("shows the owner the run's last log lines in their time zone, and the failed step's stored line", async () => {
    const asked: Array<[string, string]> = []
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "runs",
      timeZone: "Europe/Berlin",
      search: { id: "999999999991", run: "retry-1248" },
      runLog: (accountId, runId) =>
        Effect.sync(() => {
          asked.push([accountId, runId])
          return retryLog
        })
    })
    const dialog = await vi.waitFor(() => {
      const found = document.querySelector('[role="dialog"]')
      expect(found?.querySelector("[data-run-log]")).not.toBeNull()
      return found
    })
    expect(asked).toEqual([["999999999991", "retry-1248"]])
    const log = dialog?.querySelector("details[data-run-log]")
    expect(log?.hasAttribute("open")).toBe(true)
    expect(log?.querySelector("summary")?.textContent).toBe("▼LogLast 2 lines")
    expect(log?.querySelector("pre")?.textContent).toBe(
      "14:47:10 nuke: S3Bucket example-bucket waiting for objects\n14:48:02 run retry-1248 ended, account quarantined"
    )
    expect(dialog?.querySelector("[data-step-blocker]")?.textContent).toBe("S3Bucket could not be removed")
    expect(dialog?.querySelector("[data-step-raw]")?.textContent).toBe(
      "nuke: S3Bucket example-bucket - failed: BucketNotEmpty"
    )
  })

  it("never paints the last run's log or stored line on another run while its own log is read", async () => {
    const reads: SandboxesModuleReads = {
      overview: Effect.succeed(ready([quarantinedCard(nukeBlocker)])),
      caller: Effect.succeed({ login: "agent-a", owner: true, signIn: null, poolMode: "live", awsSignedIn: null }),
      runs: () => Effect.succeed(quarantineRuns),
      runLog: (_accountId, runId) => (runId === "retry-1248" ? Effect.succeed(retryLog) : Effect.never),
      requests: Effect.succeed(noRequests),
      awsSession: Effect.succeed({ _tag: "NotConfigured" })
    }
    const module = makeSandboxesModuleViews({ reads, writes: null, timeZone: "UTC" })
    const mount: ModulePageMount = { active: true, navigate: () => undefined, closeSelection: () => undefined }
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    // Checks every commit before effects run: the open run's sheet must not carry the other run's log.
    const painted: Array<string> = []
    const Probe = ({ children }: { readonly children: ReactNode }) => {
      useLayoutEffect(() => {
        const sheet = document.querySelector('[role="dialog"]')
        if (sheet?.textContent?.includes("release-1036") !== true) return
        if (sheet.querySelector("[data-step-raw]") !== null) painted.push("raw")
        if (sheet.querySelector("[data-run-log]") !== null) painted.push("log")
      })
      return children
    }
    const show = (run: string) =>
      act(async () =>
        root?.render(
          <PortalProvider>
            <Probe>{module.pages.runs(new URLSearchParams({ id: "999999999991", run }), mount)}</Probe>
          </PortalProvider>
        )
      )
    await show("retry-1248")
    await settle()
    await vi.waitFor(() => expect(document.querySelector("[data-step-raw]")).not.toBeNull())
    await show("release-1036")
    await settle()
    await vi.waitFor(() => expect(text("[data-run-log-state]")).toBe("Reading the log…"))
    expect(painted).toEqual([])
  })

  it("says the owner's log is being read, or can't be read, and keeps the steps", async () => {
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "runs",
      search: { id: "999999999991", run: "retry-1248" },
      runLog: () => Effect.never
    })
    await vi.waitFor(() => expect(document.querySelector("[data-run-log-state]")).not.toBeNull())
    expect(text("[data-run-log-state]")).toBe("Reading the log…")
    await act(async () => root?.unmount())
    root = null
    document.body.replaceChildren()
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "runs",
      search: { id: "999999999991", run: "retry-1248" },
      runLog: () => Effect.fail(new SandboxesClientError({ detail: "status" }))
    })
    await vi.waitFor(() => expect(text("[data-run-log-state]")).toBe("Can’t read the log."))
    expect(document.querySelector("[data-step-blocker]")?.textContent).toBe("S3Bucket could not be removed")
    expect(document.querySelector("[data-step-raw]")).toBeNull()
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

  it("reads Fleet requests and the account's runs again on the pool's 30 s poll", async () => {
    let requestReads = 0
    let runReads = 0
    const requests = Effect.sync(() => (requestReads++ === 0 ? noRequests : retryRequest("agent-a")))
    const runs = () =>
      Effect.sync(() => {
        runReads += 1
        return quarantineRuns
      })
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "account",
      search: { id: "999999999991" },
      requests,
      runs
    })
    expect(document.querySelector("[data-request]")).toBeNull()
    await act(async () => await vi.advanceTimersByTimeAsync(30_000))
    expect(text("[data-request-state]")).toBe("Approval requested")
    expect([requestReads, runReads]).toEqual([2, 2])
  })

  it("asks Fleet to retry a quarantine's reset from its account page, then reads the requests again", async () => {
    const retry = vi.fn((_accountId: string) => Effect.void)
    let requestReads = 0
    const requests = Effect.sync(() => (requestReads++ === 0 ? noRequests : retryRequest("agent-a")))
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "account",
      search: { id: "999999999991" },
      requests,
      writes: {
        lease: Effect.void,
        extend: () => Effect.void,
        release: () => Effect.void,
        retry,
        liftBudget: () => Effect.void,
        startAwsSignIn: noRequestWrites.startAwsSignIn
      }
    })
    expect(text("[data-request-note]")).toBe("Starts a fresh run. Goes to Fleet / Approvals first.")
    await act(async () => button("Retry reset")?.click())
    await settle()
    expect(retry).toHaveBeenCalledWith("999999999991")
    expect(requestReads).toBe(2)
    expect(button("Retry reset")).toBeUndefined()
    expect(text("[data-request-state]")).toBe("Approval requested")
  })

  it("keeps Retry reset disabled while the request is on its way", async () => {
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "account",
      search: { id: "999999999991" },
      writes: {
        ...noRequestWrites,
        lease: Effect.void,
        extend: () => Effect.void,
        release: () => Effect.void,
        retry: () => Effect.never
      }
    })
    await act(async () => button("Retry reset")?.click())
    expect(button("Retry reset")?.disabled).toBe(true)
  })

  it("offers no Retry reset while a reset waits in Fleet, to a viewer, or where the hub can't submit", async () => {
    const writes: SandboxesModuleWrites = {
      lease: Effect.void,
      extend: () => Effect.void,
      release: () => Effect.void,
      ...noRequestWrites
    }
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "account",
      search: { id: "999999999991" },
      requests: Effect.succeed(retryRequest("review-runner-02")),
      writes
    })
    expect(button("Retry reset")).toBeUndefined()
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "account",
      search: { id: "999999999991" },
      owner: false,
      writes
    })
    expect(button("Retry reset")).toBeUndefined()
    await render(ready([quarantinedCard(nukeBlocker)]), { page: "account", search: { id: "999999999991" } })
    expect(button("Retry reset")).toBeUndefined()
  })

  it("asks Fleet to lift a budget stop from its account page and from its pool card, never to retry it", async () => {
    const liftBudget = vi.fn((_accountId: string) => Effect.void)
    const writes: SandboxesModuleWrites = {
      lease: Effect.void,
      extend: () => Effect.void,
      release: () => Effect.void,
      retry: () => Effect.void,
      liftBudget,
      startAwsSignIn: noRequestWrites.startAwsSignIn
    }
    await render(ready([quarantinedCard(budgetBlocker)]), { page: "account", search: { id: "999999999991" }, writes })
    expect(button("Retry reset")).toBeUndefined()
    expect(text("[data-request-note]")).toBe("Goes to Fleet / Approvals. The stop stays until it’s approved.")
    await act(async () => button("Request to lift the stop")?.click())
    await settle()
    expect(liftBudget).toHaveBeenCalledWith("999999999991")
    await render(ready([quarantinedCard(budgetBlocker), quarantinedCard(nukeBlocker, "run-2")]), { writes })
    expect(button("Request to lift the stop", '[data-account="ephemeral-02"]')).toBeDefined()
    expect(button("Retry reset")).toBeUndefined()
  })

  it("says why a retry or lift was not sent, and what did not change", async () => {
    const refusals: ReadonlyArray<readonly [SandboxesWriteFailed["reason"], string]> = [
      ["already_requested", "Retry already requested. Nothing new was sent."],
      ["not_quarantined", "This account isn’t quarantined any more. Nothing was sent."],
      ["unauthorized", "Only the pool owner can ask for this here. Nothing was sent."],
      ["observe_mode", "The pool is in observe mode: it reads spend and runs no jobs. Nothing was sent."],
      ["network", "The request may not have reached Fleet. Check Fleet / Approvals before asking again."]
    ]
    for (const [reason, copy] of refusals) {
      await render(ready([quarantinedCard(nukeBlocker)]), {
        page: "account",
        search: { id: "999999999991" },
        writes: {
          ...noRequestWrites,
          lease: Effect.void,
          extend: () => Effect.void,
          release: () => Effect.void,
          retry: () => Effect.fail(new SandboxesWriteFailed({ reason }))
        }
      })
      await act(async () => button("Retry reset")?.click())
      await settle()
      expect(text('[role="alert"]'), reason).toBe(copy)
      expect(document.querySelector('[role="alert"]')?.className, reason).toBe("sandboxes-refusal")
    }
    await render(ready([quarantinedCard(budgetBlocker)]), {
      page: "account",
      search: { id: "999999999991" },
      writes: {
        ...noRequestWrites,
        lease: Effect.void,
        extend: () => Effect.void,
        release: () => Effect.void,
        liftBudget: () => Effect.fail(new SandboxesWriteFailed({ reason: "not_budget_held" }))
      }
    })
    await act(async () => button("Request to lift the stop")?.click())
    await settle()
    expect(text('[role="alert"]')).toBe("This account isn’t stopped by budget. Nothing was sent.")
  })

  it("keeps the last good requests and runs, marked last known, when a later poll fails", async () => {
    let requestReads = 0
    let runReads = 0
    const requests = Effect.suspend(() =>
      requestReads++ === 1
        ? Effect.fail(new SandboxesClientError({ detail: "network" }))
        : Effect.succeed(retryRequest("agent-a"))
    )
    const runs = () =>
      Effect.suspend(() =>
        runReads++ === 1 ? Effect.fail(new SandboxesClientError({ detail: "network" })) : Effect.succeed(quarantineRuns)
      )
    await render(ready([quarantinedCard(nukeBlocker)]), {
      page: "account",
      search: { id: "999999999991" },
      requests,
      runs,
      writes: { lease: Effect.void, extend: () => Effect.void, release: () => Effect.void, ...noRequestWrites }
    })
    await act(async () => await vi.advanceTimersByTimeAsync(30_000))
    expect(text("[data-request-state]")).toBe("Approval requested")
    expect(text("[data-requests-stale]")).toBe("Last known at 13:05")
    expect(document.querySelector("[data-requests-failed]")).toBeNull()
    expect(text("[data-account-summary]")).toContain("Quarantined since 12:48")
    await act(async () => await vi.advanceTimersByTimeAsync(30_000))
    expect(document.querySelector("[data-requests-stale]")).toBeNull()
  })

  it("keeps a lift off while the requests on screen are last known", async () => {
    let requestReads = 0
    const requests = Effect.suspend(() =>
      requestReads++ === 0 ? Effect.succeed(noRequests) : Effect.fail(new SandboxesClientError({ detail: "network" }))
    )
    await render(ready([quarantinedCard(budgetBlocker)]), {
      page: "account",
      search: { id: "999999999991" },
      requests,
      writes: { lease: Effect.void, extend: () => Effect.void, release: () => Effect.void, ...noRequestWrites }
    })
    expect(button("Request to lift the stop")?.disabled).toBe(false)
    await act(async () => await vi.advanceTimersByTimeAsync(30_000))
    expect(button("Request to lift the stop")?.disabled).toBe(true)
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

  describe("console and CLI profile", () => {
    const cleaning = () =>
      card({
        accountId: "999999999993",
        name: "ephemeral-04",
        label: null,
        state: { _tag: "Cleaning", runId: "run-clean", step: "nuke" }
      })
    const pool = () =>
      ready([
        leased("ephemeral-01", "999999999990", "agent-b", "2026-10-17T09:20:00.000Z", "2026-10-17T17:20:00.000Z"),
        available("ephemeral-02", "999999999991", "2026-10-17T11:42:00.000Z"),
        leased("ephemeral-03", "999999999992", "agent-a", "2026-10-17T10:00:00.000Z", "2026-10-17T18:00:00.000Z"),
        cleaning()
      ])
    const consoleOf = (name: string) => button("Open console", `[data-account="${name}"]`)
    const consoleLink = (scope: string) =>
      [...document.querySelectorAll<HTMLAnchorElement>(`${scope} a`)].find(
        (node) => node.textContent === "Open console"
      )
    const reasons = (name: string) =>
      [...document.querySelectorAll(`[data-account="${name}"] [data-console-reason]`)].map((node) => node.textContent)

    it("links to the portal's console in a new tab where the owner can sign in, and says why not elsewhere", async () => {
      await render(pool(), {
        signIn,
        writes: { ...noRequestWrites, lease: Effect.void, extend: () => Effect.void, release: () => Effect.void }
      })
      const open = consoleLink('[data-account="ephemeral-02"]')
      expect(open?.getAttribute("href")).toBe(
        "https://portal.example.test/start/#/console?account_id=999999999991&role_name=ExampleDeveloper"
      )
      expect(open?.getAttribute("target")).toBe("_blank")
      expect(open?.getAttribute("rel")).toBe("noopener noreferrer")
      expect(consoleOf("ephemeral-02")).toBeUndefined()
      expect(consoleLink('[data-account="ephemeral-03"]')).toBeDefined()
      expect(consoleLink('[data-account="ephemeral-01"]')).toBeUndefined()
      expect(consoleOf("ephemeral-01")?.disabled).toBe(true)
      expect(reasons("ephemeral-01")).toEqual([
        "Open console: only the lease holder can sign in. agent-b holds this lease."
      ])
      expect(consoleOf("ephemeral-04")?.disabled).toBe(true)
      expect(reasons("ephemeral-04")).toEqual(["Open console is unavailable while the account is wiped."])
      expect(open?.getAttribute("aria-label")).toBe(
        "Open console for ephemeral-02, AWS access portal as ExampleDeveloper, opens in a new tab"
      )
      expect(buttons('[data-account="ephemeral-03"] .sandboxes-card-buttons :is(a, button)')).toEqual([
        "Open console",
        "Copy CLI profile",
        "Extend",
        "Release"
      ])
    })

    it("shows and copies one account's CLI profile, with the note that Nix writes it already", async () => {
      const writeText = vi.fn((_text: string) => Promise.resolve())
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
      await render(pool(), { signIn })
      const toggle = button("Copy CLI profile", '[data-account="ephemeral-02"]')
      expect(toggle?.getAttribute("aria-expanded")).toBe("false")
      expect(document.querySelector('[data-account="ephemeral-02"] [data-cli-profile]')).toBeNull()
      await act(async () => toggle?.click())
      expect(toggle?.getAttribute("aria-expanded")).toBe("true")
      const block = document.querySelector('[data-account="ephemeral-02"] [data-cli-profile]')
      expect(block?.querySelector("[data-cli-path]")?.textContent).toBe("~/.aws/config")
      const profile = [
        "[profile ephemeral-02]",
        "sso_session = example-session",
        "sso_account_id = 999999999991",
        "sso_role_name = ExampleDeveloper",
        "region = eu-central-1"
      ].join("\n")
      expect(block?.querySelector("pre")?.textContent).toBe(profile)
      expect(text('[data-account="ephemeral-02"] [data-cli-note]')).toBe(
        "Nix already writes these profiles on managed machines."
      )
      const copy = [...(block?.querySelectorAll("button") ?? [])].find(
        (node) => node.getAttribute("aria-label") === "Copy CLI profile for ephemeral-02"
      )
      await act(async () => copy?.click())
      expect(writeText).toHaveBeenCalledWith(profile)
    })

    it("offers no CLI profile for an account whose name would break the profile, and keeps the console", async () => {
      await render(ready([available("old]name", "999999999991", null)]), { signIn })
      expect(consoleLink('[data-account="old]name"]')).toBeDefined()
      expect(button("Copy CLI profile", '[data-account="old]name"]')).toBeUndefined()
    })

    it("offers neither to a viewer, nor to the owner of a pool without sign-in", async () => {
      await render(pool(), { owner: false })
      expect(buttons("a, button").filter((label) => label === "Open console" || label === "Copy CLI profile")).toEqual(
        []
      )
      await act(async () => root?.unmount())
      root = null
      document.body.replaceChildren()
      await render(pool())
      expect(buttons("a, button").filter((label) => label === "Open console" || label === "Copy CLI profile")).toEqual(
        []
      )
    })

    it("puts Open console beside Retry reset on a quarantine, with the note to clear the blocker by hand", async () => {
      await render(ready([quarantinedCard(nukeBlocker)]), {
        page: "account",
        search: { id: "999999999991" },
        signIn,
        writes: { ...noRequestWrites, lease: Effect.void, extend: () => Effect.void, release: () => Effect.void }
      })
      expect(buttons(".sandboxes-account-actions :is(a, button)")).toEqual(["Retry reset", "Open console"])
      expect(consoleLink(".sandboxes-account-actions")?.getAttribute("target")).toBe("_blank")
      expect(text("[data-console-note]")).toBe("Clear the blocker by hand in the console, then retry the reset.")
    })

    it("keeps Open console after a retry is requested, under the request", async () => {
      await render(ready([quarantinedCard(nukeBlocker)]), {
        page: "account",
        search: { id: "999999999991" },
        signIn,
        requests: Effect.succeed(retryRequest("agent-a")),
        writes: { ...noRequestWrites, lease: Effect.void, extend: () => Effect.void, release: () => Effect.void }
      })
      expect(buttons(".sandboxes-account-actions :is(a, button)")).toEqual(["Open console"])
      expect(text("[data-console-note]")).toBe("Clear the blocker by hand in the console, then retry the reset.")
    })

    it("names the role a lease signs in as", async () => {
      await render(pool(), {
        signIn,
        writes: { ...noRequestWrites, lease: Effect.void, extend: () => Effect.void, release: () => Effect.void }
      })
      const dialog = await openDialog(button("Lease an account"))
      expect(dialog?.textContent).toContain("Signs in as")
      expect(dialog?.textContent).toContain("ExampleDeveloper")
    })
  })

  describe("spend bar", () => {
    const limited = (sandboxes: ReadonlyArray<SandboxCardType>): SandboxesOverview => ({
      _tag: "Ready",
      sandboxes,
      badge: { quarantined: 0, stale: false, partial: false, asOf: null },
      spendLimits: { alarm: 20, stop: 50 }
    })
    const spent = (usd: number) => ({ usd, asOf: DateTime.makeUnsafe(now).epochMilliseconds })

    it("shows this month's spend against the alarm and the hard stop", async () => {
      const item = { ...available("ephemeral-02", "999999999991", null), spend: spent(7.4) }
      await render(limited([item]))
      const bar = document.querySelector('[data-account="ephemeral-02"] [data-spend]')
      expect(bar?.querySelector("[data-spend-head]")?.textContent).toBe("Spend this month$7.40")
      const meter = bar?.querySelector('[role="meter"]')
      expect(meter?.getAttribute("aria-label")).toBe("Spend this month $7.40. Alarm at $20, hard stop at $50.")
      expect(meter?.getAttribute("aria-valuenow")).toBe("7.4")
      expect(meter?.getAttribute("aria-valuemax")).toBe("50")
      expect(bar?.querySelector<HTMLElement>("[data-spend-fill]")?.style.inlineSize).toBe("12.33%")
      expect([...(bar?.querySelectorAll("[data-spend-mark]") ?? [])].map((node) => node.textContent)).toEqual([
        "$0",
        "$20 alarm",
        "$50 hard stop"
      ])
    })

    it("draws no bar without a reading, or without the pool's limits", async () => {
      await render(limited([available("ephemeral-02", "999999999991", null)]))
      expect(document.querySelector("[data-spend]")).toBeNull()
      await act(async () => root?.unmount())
      root = null
      document.body.replaceChildren()
      await render(ready([{ ...available("ephemeral-02", "999999999991", null), spend: spent(7.4) }]))
      expect(document.querySelector("[data-spend]")).toBeNull()
    })

    it("says a budget stop is past the hard stop, on its card and its page", async () => {
      const stopped = { ...quarantinedCard(budgetBlocker), spend: spent(50.2) }
      await render(limited([stopped]))
      expect(text('[data-account="ephemeral-02"] [data-spend-head]')).toBe("Spend this month$50.20")
      expect(
        document.querySelector<HTMLElement>('[data-account="ephemeral-02"] [data-spend-fill]')?.style.inlineSize
      ).toBe("83.67%")
      await act(async () => root?.unmount())
      root = null
      document.body.replaceChildren()
      await render(limited([stopped]), { page: "account", search: { id: "999999999991" } })
      expect(text("[data-spend-over]")).toBe("$50.20 is past the $50 hard stop.")
    })
  })

  describe("run steps", () => {
    const rowsOf = (scope: Element | null) =>
      [...(scope?.querySelectorAll("li") ?? [])].map((node) => [
        node.querySelector("[data-step-name]")?.textContent ?? "",
        node.querySelector("[data-step-outcome]")?.textContent ?? "",
        node.querySelector("[data-step-state]")?.textContent ?? ""
      ])

    it("gives each step its second line, the failure in plain words, and a dash before Not run", async () => {
      await render(ready([quarantinedCard(nukeBlocker, "release-7f3a")]), {
        page: "runs",
        owner: false,
        runs: () => Effect.succeed(steppedRuns),
        search: { id: "999999999991", run: "release-7f3a" }
      })
      const steps = await vi.waitFor(() => {
        const found = document.querySelector('[role="dialog"] ol[aria-label="Cleanup steps"]')
        expect(found).not.toBeNull()
        return found
      })
      expect(rowsOf(steps)).toEqual([
        ["Signing in", "signed in", "Done"],
        ["Checking baseline", "matches", "Done"],
        ["Dry run", "41 to remove, scan complete", "Done"],
        ["Removing", "", "Done"],
        ["Verifying empty", "3 still removable", "Failed"],
        ["Re-checking baseline", "not run", "Not run"],
        ["Checking budget hold", "not checked", "Not run"]
      ])
      expect(steps?.querySelector("[data-step-words]")?.textContent).toBe(
        "Verify: some resources are still there after cleanup."
      )
      // The plain words replace the blocker's own words there: the count line already says how many remain.
      expect(steps?.querySelector("[data-step-blocker]")).toBeNull()
      const notRun = [...(steps?.querySelectorAll("li") ?? [])].filter(
        (node) => node.querySelector("[data-step-state]")?.textContent === "Not run"
      )
      expect(notRun.map((node) => node.querySelector("[data-step-state] svg") !== null)).toEqual([true, true])
    })

    it("says only what the blocker establishes: a scan that didn't finish, or a hold that couldn't be read", async () => {
      const failedAt = (step: "verify" | "budget hold", blocker: SandboxBlocker) =>
        runsPage({
          _tag: "Ready",
          accountId: "999999999991",
          next: null,
          runs: [
            {
              runId: "run-x",
              step: null,
              blocker,
              outcome: "Quarantined",
              reason: "Released",
              startedAt: "2026-10-17T10:58:00.000Z",
              endedAt: "2026-10-17T11:07:00.000Z",
              failedStep: step,
              steps: [{ step, status: "failed", at: "2026-10-17T11:06:41.000Z", count: 0 }]
            }
          ]
        })
      const shown = async (runs: ReturnType<typeof failedAt>) => {
        await render(ready([quarantinedCard(nukeBlocker, "run-x")]), {
          page: "runs",
          owner: false,
          runs: () => Effect.succeed(runs),
          search: { id: "999999999991", run: "run-x" }
        })
        const row = await vi.waitFor(() => {
          const found = document.querySelector('[role="dialog"] ol[aria-label="Cleanup steps"] li')
          expect(found).not.toBeNull()
          return found
        })
        const seen = [
          row?.querySelector("[data-step-outcome]")?.textContent ?? "",
          row?.querySelector("[data-step-words]")?.textContent ?? "",
          row?.querySelector("[data-step-blocker]")?.textContent ?? ""
        ]
        await act(async () => root?.unmount())
        root = null
        document.body.replaceChildren()
        return seen
      }
      expect(await shown(failedAt("verify", { _tag: "ScanIncomplete", text: "The scan did not finish" }))).toEqual([
        "",
        "",
        "The scan did not finish"
      ])
      expect(await shown(failedAt("budget hold", { _tag: "Unknown", text: "Reset failed" }))).toEqual([
        "",
        "",
        "Reset failed"
      ])
    })

    it("times the reset's steps on the account page, in the viewer's time zone", async () => {
      await render(ready([quarantinedCard(nukeBlocker, "release-7f3a")]), {
        page: "account",
        timeZone: "Europe/Berlin",
        runs: () => Effect.succeed(steppedRuns),
        search: { id: "999999999991" }
      })
      const steps = await vi.waitFor(() => {
        const found = document.querySelector('ol[aria-label="Reset steps"]')
        expect(found).not.toBeNull()
        return found
      })
      expect(
        [...(steps?.querySelectorAll("li") ?? [])].map((node) => [
          node.querySelector("[data-step-name]")?.textContent,
          node.querySelector("[data-step-at]")?.textContent ?? "",
          node.querySelector("[data-step-state]")?.textContent
        ])
      ).toEqual([
        ["Sign in", "12:58", "Done"],
        ["Baseline", "12:58", "Done"],
        ["Dry run", "12:58", "Done"],
        ["Nuke", "13:06", "Done"],
        ["Verify", "13:06", "Failed"],
        ["Baseline re-check", "", "Not run"],
        ["Budget hold", "", "Not run"]
      ])
      // The blocker has its own section on this page; the failed step does not repeat it.
      expect(steps?.querySelector("[data-step-blocker]")).toBeNull()
    })
  })

  describe("AWS sign-in", () => {
    const pendingSession: SandboxAwsSession = {
      _tag: "SignInPending",
      verificationUri: "https://portal.example.test/start/#/device?user_code=ABCD-EFGH",
      userCode: "ABCD-EFGH",
      expiresAt: DateTime.makeUnsafe("2026-10-17T13:15:00.000Z")
    }
    const signedIn: SandboxAwsSession = {
      _tag: "SignedIn",
      expiresAt: DateTime.makeUnsafe("2026-10-17T18:05:00.000Z")
    }
    const verificationUri = "https://portal.example.test/start/#/device?user_code=ABCD-EFGH"
    const spent = (usd: number) => ({ usd, asOf: DateTime.makeUnsafe("2026-10-17T12:50:00.000Z").epochMilliseconds })
    const own = leased(
      "ephemeral-01",
      "999999999990",
      "agent-a",
      "2026-10-17T09:20:00.000Z",
      "2026-10-17T17:20:00.000Z"
    )
    const quarantined = quarantinedCard(nukeBlocker)
    const stopped = card({
      accountId: "999999999992",
      name: "ephemeral-03",
      label: null,
      state: { _tag: "Quarantined", runId: "run-stop", step: null, blocker: budgetBlocker }
    })
    const pool = (sandboxes: ReadonlyArray<SandboxCardType>) => ({
      ...ready(sandboxes),
      spendLimits: { alarm: 20, stop: 50 }
    })
    const allWrites = (startAwsSignIn: SandboxesModuleWrites["startAwsSignIn"]): SandboxesModuleWrites => ({
      lease: Effect.void,
      extend: () => Effect.void,
      release: () => Effect.void,
      retry: () => Effect.void,
      liftBudget: () => Effect.void,
      startAwsSignIn
    })
    const card$ = () => document.querySelector('[role="status"][aria-label="AWS sign-in"]')
    const describedBy = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .filter((node) => node.textContent === label)
        .map((node) => [node.disabled, node.getAttribute("aria-describedby")])

    it("asks the owner to sign in, shows no spend, and holds back what needs AWS in live mode", async () => {
      await render(pool([own, quarantined, stopped, available("ephemeral-04", "999999999993", null)]), {
        awsSession: Effect.succeed({ _tag: "SignInRequired", reason: "never" }),
        writes: allWrites(Effect.succeed(pendingSession))
      })
      expect(card$()?.querySelector(".stacks-state-eyebrow")?.textContent).toBe("Not signed in")
      expect(card$()?.querySelector("h2")?.textContent).toBe("Sign in to AWS to read spend.")
      expect(card$()?.querySelector("p:not(.stacks-state-eyebrow)")?.textContent).toBe(
        "The hub signs in to the management account itself; nothing on this computer is used."
      )
      expect(button("Sign in to AWS")?.disabled).toBe(false)
      const why = document.querySelector("[data-aws-first]")
      expect(why?.textContent).toBe("Sign in to AWS first: Release, Retry reset and Request to lift the stop need it.")
      const id = why?.id ?? ""
      expect(id).not.toBe("")
      expect(describedBy("Release")).toEqual([[true, id]])
      expect(describedBy("Request to lift the stop")).toEqual([[true, id]])
      expect(describedBy("Extend")).toEqual([[false, null]])
      expect(describedBy("Lease an account")).toEqual([[false, null]])
    })

    it("holds back Retry reset on the account page the same way, live and signed out or in observe mode", async () => {
      const cases: ReadonlyArray<readonly ["live" | "observe", SandboxAwsSession, string]> = [
        ["live", { _tag: "SignInRequired", reason: "never" }, "[data-aws-first]"],
        ["observe", signedIn, "[data-observe-mode]"]
      ]
      for (const [poolMode, session, marker] of cases) {
        await render(pool([quarantined]), {
          page: "account",
          search: { id: "999999999991" },
          poolMode,
          awsSession: Effect.succeed(session),
          writes: allWrites(Effect.succeed(pendingSession))
        })
        const id = document.querySelector(marker)?.id ?? ""
        expect(id, poolMode).not.toBe("")
        expect(describedBy("Retry reset"), poolMode).toEqual([[true, id]])
        await act(async () => root?.unmount())
        root = null
        document.body.replaceChildren()
      }
    })

    it("starts a sign-in on the owner’s press, shows the code and a link, and polls every 5 s until signed in", async () => {
      let session: SandboxAwsSession = { _tag: "SignInRequired", reason: "never" }
      const reads = vi.fn(() => session)
      const start = vi.fn(() => {
        session = pendingSession
        return pendingSession
      })
      await render(pool([own]), {
        awsSession: Effect.sync(reads),
        writes: allWrites(Effect.sync(start))
      })
      await act(async () => button("Sign in to AWS")?.click())
      await settle()
      expect(start).toHaveBeenCalledTimes(1)
      expect(card$()?.querySelector(".stacks-state-eyebrow")?.textContent).toBe("Waiting for you")
      expect(card$()?.querySelector("h2")?.textContent).toBe("Finish signing in to AWS.")
      expect(card$()?.textContent).toContain(
        "Open the sign-in page, check the code matches and approve. It expires at 13:15."
      )
      expect(card$()?.querySelector("[data-aws-code]")?.textContent).toBe("ABCD-EFGH")
      const link = [...(card$()?.querySelectorAll<HTMLAnchorElement>("a") ?? [])].find(
        (node) => node.textContent === "Open sign-in page"
      )
      expect(link?.getAttribute("href")).toBe(verificationUri)
      expect(link?.getAttribute("target")).toBe("_blank")
      expect(link?.getAttribute("rel")).toBe("noopener noreferrer")
      expect(button("Sign in to AWS")).toBeUndefined()
      const before = reads.mock.calls.length
      await act(async () => await vi.advanceTimersByTimeAsync(5_000))
      expect(reads.mock.calls.length).toBe(before + 1)
      session = signedIn
      await act(async () => await vi.advanceTimersByTimeAsync(5_000))
      expect(card$()).toBeNull()
      expect(text("[data-aws-signed-in]")).toBe("Signed in to AWS until 18:05")
      expect(document.querySelector("[data-aws-first]")).toBeNull()
      expect(describedBy("Release")).toEqual([[false, null]])
      // Signed in: back to the page’s own 30 s cadence.
      const settled = reads.mock.calls.length
      await act(async () => await vi.advanceTimersByTimeAsync(25_000))
      expect(reads.mock.calls.length).toBe(settled)
    })

    it("stops polling every 5 s after 10 minutes of waiting", async () => {
      const reads = vi.fn(() => pendingSession)
      await render(pool([own]), { awsSession: Effect.sync(reads), writes: allWrites(Effect.succeed(pendingSession)) })
      await act(async () => await vi.advanceTimersByTimeAsync(600_000))
      const after = reads.mock.calls.length
      expect(after).toBeGreaterThanOrEqual(120)
      await act(async () => await vi.advanceTimersByTimeAsync(25_000))
      expect(reads.mock.calls.length).toBe(after)
    })

    it("says an ended sign-in ended, and marks the spend it read last as last known", async () => {
      await render(pool([{ ...available("ephemeral-02", "999999999991", null), spend: spent(7.4) }]), {
        awsSession: Effect.succeed({ _tag: "SignInRequired", reason: "ended" }),
        writes: allWrites(Effect.succeed(pendingSession))
      })
      expect(card$()?.querySelector(".stacks-state-eyebrow")?.textContent).toBe("Signed out")
      expect(card$()?.querySelector("h2")?.textContent).toBe("The AWS sign-in ended.")
      expect(card$()?.textContent).toContain("Sign in again to read spend.")
      expect(button("Sign in to AWS")?.disabled).toBe(false)
      expect(text("[data-spend-old]")).toBe("Last known at 12:50")
    })

    it("tells a viewer who signs in, with no button and no read of the sign-in", async () => {
      const reads = vi.fn(() => pendingSession)
      await render(pool([available("ephemeral-02", "999999999991", null)]), {
        owner: false,
        awsSignedIn: false,
        awsSession: Effect.sync(reads)
      })
      expect(card$()?.querySelector("h2")?.textContent).toBe("Sign in to AWS to read spend.")
      expect(card$()?.textContent).toContain("The owner signs the hub in to AWS.")
      expect(button("Sign in to AWS")).toBeUndefined()
      expect(reads).not.toHaveBeenCalled()
    })

    it("in observe mode says so once and disables every job up front, pointing each at that line", async () => {
      await render(pool([available("ephemeral-01", "999999999990", null), quarantined, stopped]), {
        poolMode: "observe",
        awsSession: Effect.succeed(signedIn),
        signIn,
        writes: allWrites(Effect.succeed(pendingSession))
      })
      expect(text("[data-aws-signed-in]")).toBe("Signed in to AWS until 18:05")
      const why = document.querySelector("[data-observe-mode]")
      expect(why?.textContent).toBe("The pool is in observe mode: it reads spend and runs no jobs.")
      const id = why?.id ?? ""
      expect(id).not.toBe("")
      expect(describedBy("Lease an account")).toEqual([[true, id]])
      expect(describedBy("Request to lift the stop")).toEqual([[true, id]])
      expect(
        [...document.querySelectorAll("a")].filter((node) => node.textContent === "Open console").length
      ).toBeGreaterThan(0)
    })
  })
})
