// @vitest-environment happy-dom
import { FleetReadLoadError, type FleetUsage, type FleetLimits, type UsageQuery } from "@knpkv/herdr-connect/usage"
import { Effect } from "effect"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { makeUsageModuleViews, type UsageModuleReads } from "../src/usage-module-view.js"
import { fleetModule, type ModuleViews } from "../src/modules.js"
import { SuperappShell } from "../src/superapp-view.js"

let root: Root | null = null
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true))
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
  window.history.replaceState(null, "", "/")
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const usage: FleetUsage = { hosts: [], failures: [], peersListed: true }
const limits: FleetLimits = { hosts: [], failures: [], peersListed: true }
const emptyUsageHost: FleetUsage["hosts"][number] = {
  host: "ALPHA",
  readAt: 1_000,
  reading: {
    _tag: "Read",
    skipped: 0,
    usage: {
      v: 1,
      machine: "ALPHA",
      observedAt: 1_000,
      range: { preset: "7d", timeZone: "UTC", from: 0, to: 86_400_000, bucket: "day" },
      periods: [{ key: "1970-01-01", start: 0 }],
      tokens: [],
      limits: []
    }
  }
}
const emptyLimitsHost: FleetLimits["hosts"][number] = {
  host: "ALPHA",
  readAt: 1_000,
  reading: { _tag: "Read", skipped: 0, limits: { v: 1, machine: "ALPHA", observedAt: 1_000, latest: [] } }
}
const emptyUsage: FleetUsage = { ...usage, hosts: [emptyUsageHost] }
const emptyLimits: FleetLimits = { ...limits, hosts: [emptyLimitsHost] }
const fleet: ModuleViews<typeof fleetModule> = {
  descriptor: fleetModule,
  pages: { approvals: () => <h1>Approvals</h1>, connect: () => null, work: () => null, usage: () => null }
}
const render = async (reads: UsageModuleReads) => {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  const module = makeUsageModuleViews({ reads, viewerTimeZone: "Europe/Amsterdam", now: 1_000, onHubMachine: false })
  await act(async () =>
    root?.render(
      <SuperappShell
        session={{ access: "tailscale", connection: "connected" }}
        modules={[fleet, module]}
        landing={{ module: "fleet", page: "approvals" }}
        host="hub"
        hostCount={1}
        notifications={null}
      />
    )
  )
}
const click = async (href: string) => {
  const anchor = document.createElement("a")
  anchor.href = href
  document.body.append(anchor)
  await act(async () => anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })))
  anchor.remove()
}

/** Successful empty readings use the designed notice and action, without fabricated zero-value cards. */
it("renders empty Limits with grouped header and a real tokens route, then restores ordinary chrome", async () => {
  window.history.replaceState(null, "", "/?range=7d&timeZone=UTC#usage/limits")
  await render({
    usage: () => Effect.succeed({ fleet: emptyUsage, receivedAt: 1_000 }),
    limits: Effect.succeed({ fleet: emptyLimits, receivedAt: 1_000 })
  })
  expect(document.querySelector('.superapp-shell[data-usage-empty="true"]')).not.toBeNull()
  expect(document.querySelector(".usage-limits-empty")).not.toBeNull()
  expect(document.querySelector(".usage-empty")).toBeNull()
  const sidebar = document.querySelector(".superapp-sidebar")
  expect(sidebar?.getAttribute("data-region")).toBeNull()
  expect(sidebar?.querySelector('[data-region="nav"]')?.textContent).toBe("FleetUsage")
  expect([...document.querySelectorAll("[data-region]")].map((region) => region.getAttribute("data-region"))).toEqual([
    "nav",
    "header",
    "tabs",
    "notice",
    "action",
    "nav"
  ])
  const header = document.querySelector('[data-region="header"]')
  expect(header?.querySelector('[data-region="tabs"]')).not.toBeNull()
  expect(header?.textContent).toContain("Usage details on hub. Account readings stay on this machine.")
  const notice = document.querySelector('[data-region="notice"]')
  expect(notice?.textContent).toContain("No usage readings yet")
  expect(notice?.textContent).toContain("hub hasn’t recorded any limits or token use. Unknown is not zero.")
  const action = document.querySelector<HTMLAnchorElement>('[data-region="action"]')
  expect(action?.textContent).toBe("See fleet token readings")
  expect(action?.getAttribute("href")).toBe("?range=7d&timeZone=UTC#usage/tokens")
  expect(document.querySelector('[data-region="cards"]')).toBeNull()
  expect(document.querySelector('[data-region="detail"]')).toBeNull()
  expect(document.querySelector('[data-region="footer"]')).toBeNull()
  await click("/?range=7d&timeZone=UTC#usage/tokens")
  expect(document.querySelector('.superapp-shell[data-usage-empty="true"]')).toBeNull()
  expect(document.querySelector(".usage-empty-header-region")).toBeNull()
  expect(document.querySelector('.superapp-header[data-region="header"]')).not.toBeNull()
})

/** The empty mast's portaled tabs stay Usage navigation: focus lands on them and the current tab replaces history. */
it("keeps empty Limits tabs owned by Usage for focus and same-page navigation", async () => {
  await render({
    usage: () => Effect.succeed({ fleet: emptyUsage, receivedAt: 1_000 }),
    limits: Effect.succeed({ fleet: emptyLimits, receivedAt: 1_000 })
  })
  await act(async () => document.querySelector<HTMLAnchorElement>('.superapp-sidebar a[href*="#usage/"]')?.click())
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
  })
  const limitsTab = document.querySelector<HTMLAnchorElement>('.usage-empty-tabs a[data-module-page="limits"]')
  expect(limitsTab).not.toBeNull()
  expect(document.activeElement).toBe(limitsTab)
  const push = vi.spyOn(window.history, "pushState")
  const replace = vi.spyOn(window.history, "replaceState")
  await act(async () => limitsTab?.click())
  expect(push).not.toHaveBeenCalled()
  expect(replace).toHaveBeenCalled()
})

/** Empty arrays with incomplete peer discovery are unknown evidence, not a successful empty state. */
it("keeps ordinary Limits when peer discovery is incomplete", async () => {
  window.history.replaceState(null, "", "/?range=7d&timeZone=UTC#usage/limits")
  await render({
    usage: () => Effect.succeed({ fleet: { ...usage, peersListed: false }, receivedAt: 1_000 }),
    limits: Effect.succeed({ fleet: limits, receivedAt: 1_000 })
  })
  expect(document.querySelector('.superapp-shell[data-usage-empty="true"]')).toBeNull()
  expect(document.querySelector(".usage-empty-notice")).toBeNull()
  expect(document.querySelector('[data-region="cards"]')).not.toBeNull()
})

/** Empty peer reads are legitimate only when both complete reports name the same fleet. */
it("accepts matching empty peer readings independent of host order and case", async () => {
  window.history.replaceState(null, "", "/?range=7d&timeZone=UTC#usage/limits")
  await render({
    usage: () =>
      Effect.succeed({
        fleet: { ...emptyUsage, hosts: [emptyUsageHost, { ...emptyUsageHost, host: "BETA" }] },
        receivedAt: 1_000
      }),
    limits: Effect.succeed({
      fleet: { ...emptyLimits, hosts: [{ ...emptyLimitsHost, host: "beta" }, emptyLimitsHost] },
      receivedAt: 1_000
    })
  })
  expect(document.querySelector(".usage-limits-empty")).not.toBeNull()
})

/** Absence, partial decoding, unavailable hosts and one-sided host discovery cannot prove an empty fleet. */
it.each([
  { name: "no hosts", usage, limits },
  { name: "missing limits host", usage: emptyUsage, limits },
  { name: "duplicate hosts", usage: { ...emptyUsage, hosts: [emptyUsageHost, emptyUsageHost] }, limits: emptyLimits },
  {
    name: "mixed unavailable peer",
    usage: {
      ...emptyUsage,
      hosts: [
        emptyUsageHost,
        { ...emptyUsageHost, host: "BETA", reading: { _tag: "Unavailable", reason: "not_configured", detail: "Off" } }
      ]
    },
    limits: { ...emptyLimits, hosts: [emptyLimitsHost, { ...emptyLimitsHost, host: "BETA" }] }
  },
  { name: "usage discovery incomplete", usage: { ...emptyUsage, peersListed: false }, limits: emptyLimits },
  { name: "limits discovery incomplete", usage: emptyUsage, limits: { ...emptyLimits, peersListed: false } },
  {
    name: "usage peer failed",
    usage: { ...emptyUsage, failures: [{ host: "BETA", reason: "offline" }] },
    limits: emptyLimits
  },
  {
    name: "limits peer failed",
    usage: emptyUsage,
    limits: { ...emptyLimits, failures: [{ host: "BETA", reason: "offline" }] }
  },
  {
    name: "host mismatch",
    usage: emptyUsage,
    limits: { ...emptyLimits, hosts: [{ ...emptyLimitsHost, host: "BETA" }] }
  },
  {
    name: "not configured",
    usage: {
      ...emptyUsage,
      hosts: [{ ...emptyUsageHost, reading: { _tag: "Unavailable", reason: "not_configured", detail: "Off" } }]
    },
    limits: emptyLimits
  },
  {
    name: "limits unavailable",
    usage: emptyUsage,
    limits: {
      ...emptyLimits,
      hosts: [{ ...emptyLimitsHost, reading: { _tag: "Unavailable", reason: "failed", detail: "Offline" } }]
    }
  }
] satisfies ReadonlyArray<{ readonly name: string; readonly usage: FleetUsage; readonly limits: FleetLimits }>)(
  "keeps ordinary Limits for $name",
  async ({ limits, usage }) => {
    window.history.replaceState(null, "", "/?range=7d&timeZone=UTC#usage/limits")
    await render({
      usage: () => Effect.succeed({ fleet: usage, receivedAt: 1_000 }),
      limits: Effect.succeed({ fleet: limits, receivedAt: 1_000 })
    })
    expect(document.querySelector(".usage-limits-empty")).toBeNull()
  }
)

/** Nonzero skipped counts and any real token/limit evidence retain the ordinary reading surface. */
it.each([
  "skipped usage",
  "skipped limits",
  "tokens",
  "historical limits",
  "latest limits",
  "zero tokens",
  "unknown latest",
  "zero latest"
])("keeps ordinary Limits with %s", async (kind) => {
  if (emptyUsageHost.reading._tag !== "Read" || emptyLimitsHost.reading._tag !== "Read") return expect.unreachable()
  const snapshot = {
    agent: "claude",
    machine: "ALPHA",
    source: "claude-oauth-usage",
    label: "five_hour",
    windowMinutes: 300,
    observedAt: 1_000,
    reading:
      kind === "unknown latest"
        ? { _tag: "Unknown", reason: "AuthExpired" }
        : { _tag: "Known", usedPercent: kind === "zero latest" ? 0 : 10, resetsAt: 2_000 }
  } satisfies (typeof emptyLimitsHost.reading.limits.latest)[number]
  const reportedUsage: FleetUsage = {
    ...emptyUsage,
    hosts: [
      {
        ...emptyUsageHost,
        reading: {
          ...emptyUsageHost.reading,
          skipped: kind === "skipped usage" ? 1 : 0,
          usage: {
            ...emptyUsageHost.reading.usage,
            tokens:
              kind === "tokens" || kind === "zero tokens"
                ? [{ period: 0, agent: "claude", model: "model-a", tokens: kind === "zero tokens" ? 0 : 1 }]
                : [],
            limits:
              kind === "historical limits"
                ? [
                    {
                      agent: snapshot.agent,
                      label: snapshot.label,
                      windowMinutes: snapshot.windowMinutes,
                      points: [{ at: snapshot.observedAt, reading: snapshot.reading }]
                    }
                  ]
                : []
          }
        }
      }
    ]
  }
  const reportedLimits: FleetLimits = {
    ...emptyLimits,
    hosts: [
      {
        ...emptyLimitsHost,
        reading: {
          ...emptyLimitsHost.reading,
          skipped: kind === "skipped limits" ? 1 : 0,
          limits: {
            ...emptyLimitsHost.reading.limits,
            latest: kind === "latest limits" || kind === "unknown latest" || kind === "zero latest" ? [snapshot] : []
          }
        }
      }
    ]
  }
  window.history.replaceState(null, "", "/?range=7d&timeZone=UTC#usage/limits")
  await render({
    usage: () => Effect.succeed({ fleet: reportedUsage, receivedAt: 1_000 }),
    limits: Effect.succeed({ fleet: reportedLimits, receivedAt: 1_000 })
  })
  expect(document.querySelector(".usage-limits-empty")).toBeNull()
})

/** A retained Limits error must not expose a Retry on a page that never reads Limits. */
it("keeps Limits Retry on Limits after switching to healthy By tool", async () => {
  const reads: UsageModuleReads = {
    usage: () => Effect.succeed({ fleet: usage, receivedAt: 1_000 }),
    limits: Effect.fail(new FleetReadLoadError({ path: "/v1/connect/limits", reason: "network", cause: "offline" }))
  }
  window.history.replaceState(null, "", "/?range=7d&timeZone=UTC#usage/limits")
  await render(reads)
  const retries = () =>
    [...document.querySelectorAll(".usage-details button")].filter((button) => button.textContent === "Retry")
  expect(retries()).toHaveLength(1)
  await click("?range=7d&timeZone=UTC#usage/by-tool")
  expect(retries()).toHaveLength(0)
  await click("?range=7d&timeZone=UTC#usage/limits")
  expect(retries()).toHaveLength(1)
})

/** A fresh Limits failure has no cards to show, so it must not claim the cards region the design omits. */
it("tags no cards region for a fresh Limits failure while loading keeps it", async () => {
  window.history.replaceState(null, "", "/?range=7d&timeZone=UTC#usage/limits")
  await render({
    usage: () => Effect.succeed({ fleet: usage, receivedAt: 1_000 }),
    limits: Effect.fail(new FleetReadLoadError({ path: "/v1/connect/limits", reason: "network", cause: "offline" }))
  })
  expect(document.querySelector('[data-region="notice"]')).not.toBeNull()
  expect(document.querySelector('[data-region="cards"]')).toBeNull()
  await act(async () => root?.unmount())
  document.body.replaceChildren()
  await render({ usage: () => Effect.never, limits: Effect.never })
  expect(document.querySelector('[data-region="cards"]')).not.toBeNull()
})

it("repairs selectors only on active Usage and keeps Fleet approval deep links after visiting Usage", async () => {
  const calls: Array<UsageQuery> = []
  const reads: UsageModuleReads = {
    usage: (query) =>
      Effect.sync(() => {
        calls.push(query)
        return { fleet: usage, receivedAt: 1_000 }
      }),
    limits: Effect.succeed({ fleet: limits, receivedAt: 1_000 })
  }
  window.history.replaceState(null, "", "/?approvalHost=ALPHA&approvalJob=job-1#fleet/approvals")
  const replace = vi.spyOn(window.history, "replaceState")
  await render(reads)
  expect(window.location.search).toBe("?approvalHost=ALPHA&approvalJob=job-1")
  expect(calls).toEqual([])
  await click("?range=30d&timeZone=Europe%2FAmsterdam&approvalHost=ALPHA#usage/tokens")
  expect(window.location.search).toBe("?range=30d&timeZone=Europe%2FAmsterdam")
  expect(calls).toEqual([{ range: "30d", timeZone: "Europe/Amsterdam" }])
  expect(document.querySelector(".usage-details-intro")?.textContent).toContain("Some URL selectors were reset")
  const range = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Range"] button')].find(
    (button) => button.textContent === "7 days"
  )
  await act(async () => range?.click())
  expect(document.querySelector(".usage-details-intro")?.textContent).not.toContain("Some URL selectors were reset")
  const count = replace.mock.calls.length
  await act(async () =>
    root?.render(
      <SuperappShell
        session={{ access: "tailscale", connection: "connected" }}
        modules={[
          fleet,
          makeUsageModuleViews({ reads, viewerTimeZone: "Europe/Amsterdam", now: 2_000, onHubMachine: false })
        ]}
        landing={{ module: "fleet", page: "approvals" }}
        host="hub"
        hostCount={1}
        notifications={null}
      />
    )
  )
  expect(replace.mock.calls.length).toBe(count)
  await click("?approvalHost=ALPHA&approvalJob=job-2#fleet/approvals")
  expect(window.location.search).toBe("?approvalHost=ALPHA&approvalJob=job-2")
  expect(calls).toHaveLength(2)
})

it("reads limits only on its page, filters locally, repairs unknown hosts and keeps unknowns out of totals", async () => {
  let limitsReads = 0
  const queries: Array<UsageQuery> = []
  const report: FleetUsage = {
    hosts: [
      {
        host: "ALPHA",
        readAt: 1_000,
        reading: {
          _tag: "Read",
          skipped: 0,
          usage: {
            v: 1,
            machine: "ALPHA",
            observedAt: 0,
            range: { preset: "7d", timeZone: "UTC", from: 0, to: 86_400_000, bucket: "day" },
            periods: [{ key: "1970-01-01", start: 0 }],
            tokens: [{ period: 0, agent: "claude", model: "model-a", tokens: 1200 }],
            limits: []
          }
        }
      }
    ],
    failures: [{ host: "cedar", reason: "offline" }],
    peersListed: true
  }
  const first = report.hosts[0]
  if (first === undefined || first.reading._tag !== "Read") return expect.unreachable()
  const withPeer: FleetUsage = {
    ...report,
    hosts: [
      ...report.hosts,
      {
        ...first,
        host: "BETA",
        reading: {
          ...first.reading,
          usage: {
            ...first.reading.usage,
            machine: "BETA",
            tokens: [{ period: 0, agent: "claude", model: "model-a", tokens: 3600 }]
          }
        }
      }
    ]
  }
  const reads: UsageModuleReads = {
    usage: (query) =>
      Effect.sync(() => {
        queries.push(query)
        return { fleet: withPeer, receivedAt: 1_000 }
      }),
    limits: Effect.sync(() => {
      limitsReads += 1
      return { fleet: limits, receivedAt: 1_000 }
    })
  }
  window.history.replaceState(null, "", "/?range=7d&timeZone=UTC#usage/tokens")
  await render(reads)
  expect(limitsReads).toBe(0)
  const rows = [...document.querySelectorAll('[aria-label="By host"] li')]
  expect(rows.map((row) => row.textContent)).toEqual([
    "ALPHARead 00:00 in UTC1.2K",
    "BETARead 00:00 in UTC3.6K",
    "cedarOfflineUnknown"
  ])
  expect(document.querySelector('[aria-label="By host"]')?.textContent).toContain("4.8K reported tokens")
  expect(document.querySelector('[aria-label="By agent and model"]')?.textContent).toContain("1.2K")
  expect(document.querySelector('[aria-label="By agent and model"]')?.textContent).not.toContain("4.8K")
  expect(document.querySelector('[aria-label="By provider"]')?.textContent).toContain("1.2K")
  await click("?range=7d&timeZone=UTC&host=BETA#usage/tokens")
  expect(document.querySelector('[aria-label="By agent and model"]')?.textContent).toContain("3.6K")
  expect(document.querySelector('[aria-label="By provider"]')?.textContent).toContain("3.6K")
  await click("?range=7d&timeZone=UTC&host=cedar#usage/tokens")
  expect(document.querySelector('[aria-label="By host"]')?.textContent).not.toContain("ALPHA")
  expect(window.location.search).toContain("host=cedar")
  expect(queries).toHaveLength(1)
  await click("?range=7d&timeZone=UTC&host=unknown#usage/tokens")
  expect(window.location.search).toBe("?range=7d&timeZone=UTC")
  expect(queries).toHaveLength(1)
  await click("?range=7d&timeZone=UTC#usage/limits")
  expect(limitsReads).toBe(1)
  expect(queries).toHaveLength(1)
  await click("?range=7d&timeZone=UTC#usage/tokens")
  expect(limitsReads).toBe(1)
})

it("owns range changes in the URL, sends the selected zone and interrupts reads on inactive or hidden pages", async () => {
  const calls: Array<UsageQuery> = []
  let interruptions = 0
  const reads: UsageModuleReads = {
    usage: (query) =>
      Effect.callback((resume) => {
        calls.push(query)
        if (query.range === "7d") resume(Effect.succeed({ fleet: usage, receivedAt: 1_000 }))
        return Effect.sync(() => {
          interruptions += 1
        })
      }),
    limits: Effect.succeed({ fleet: limits, receivedAt: 1_000 })
  }
  window.history.replaceState(null, "", "/?range=7d&timeZone=UTC#usage/tokens")
  await render(reads)
  const push = vi.spyOn(window.history, "pushState")
  const rangeButton = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Range"] button')].find(
    (button) => button.textContent === "30 days"
  )
  await act(async () => rangeButton?.click())
  expect(window.location.search).toBe("?range=30d&timeZone=UTC")
  expect(push).not.toHaveBeenCalled()
  expect(calls).toEqual([
    { range: "7d", timeZone: "UTC" },
    { range: "30d", timeZone: "UTC" }
  ])
  await click("?#fleet/approvals")
  await vi.waitFor(() => expect(interruptions).toBe(1))
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
  await act(async () => document.dispatchEvent(new Event("visibilitychange")))
  await click("?range=30d&timeZone=UTC#usage/tokens")
  expect(calls).toHaveLength(2)
  visibility.mockReturnValue("visible")
  await act(async () => document.dispatchEvent(new Event("visibilitychange")))
  expect(calls).toHaveLength(3)
  visibility.mockReturnValue("hidden")
  await act(async () => document.dispatchEvent(new Event("visibilitychange")))
  await vi.waitFor(() => expect(interruptions).toBe(2))
})

it("shows By tool for one reported host, with no limits fan-out or zero for an unavailable host", async () => {
  let limitCalls = 0
  const queries: Array<UsageQuery> = []
  const reading: FleetUsage["hosts"][number]["reading"] = {
    _tag: "Read",
    skipped: 0,
    usage: {
      v: 1,
      machine: "ALPHA",
      observedAt: 0,
      range: { preset: "7d", timeZone: "UTC", from: 0, to: 86_400_000, bucket: "day" },
      periods: [{ key: "1970-01-01", start: 0 }],
      tokens: [
        { period: 0, agent: "claude", model: "Opus", tokens: 1200 },
        { period: 0, agent: "codex", model: "GPT-5", tokens: 400 }
      ],
      limits: []
    }
  }
  const report: FleetUsage = {
    hosts: [
      { host: "ALPHA", readAt: 1000, reading },
      { host: "BETA", readAt: 1000, reading: { ...reading, usage: { ...reading.usage, machine: "BETA", tokens: [] } } }
    ],
    failures: [{ host: "cedar", reason: "offline" }],
    peersListed: true
  }
  const reads: UsageModuleReads = {
    usage: (query) =>
      Effect.sync(() => {
        queries.push(query)
        return { fleet: report, receivedAt: 1000 }
      }),
    limits: Effect.sync(() => {
      limitCalls += 1
      return { fleet: limits, receivedAt: 1000 }
    })
  }
  window.history.replaceState(null, "", "?range=7d&timeZone=UTC#usage/by-tool")
  await render(reads)
  expect(document.querySelector<HTMLSelectElement>('[name="usage-host"]')?.value).toBe("ALPHA")
  expect(document.querySelector(".usage-by-tool-total")?.textContent).toBe("1.6K tokens")
  expect([...document.querySelectorAll(".usage-by-tool tbody tr")].map((row) => row.textContent)).toEqual([
    "Claude Code, Opus1.2K75%",
    "Codex, GPT-540025%"
  ])
  expect(document.querySelector(".usage-by-tool time")?.textContent).toBe("00:00")
  expect(document.querySelector(".usage-details-controls")?.textContent).toContain("Periods in UTC")
  await click("?range=7d&timeZone=UTC&host=cedar#usage/by-tool")
  expect(document.querySelector(".usage-by-tool-total")?.textContent).toBe("Unknown")
  expect(document.querySelector(".usage-by-tool")?.textContent).toContain("cedar: Offline")
  expect(document.querySelectorAll(".usage-by-tool tbody tr")).toHaveLength(0)
  await click("?range=7d&timeZone=UTC&host=BETA#usage/by-tool")
  expect(document.querySelector(".usage-by-tool-total")?.textContent).toBe("0 tokens")
  expect(queries).toEqual([{ range: "7d", timeZone: "UTC" }])
  expect(limitCalls).toBe(0)
})

/** A retained report names its range and failure state while the next request is controlled by the test. */
it.each(["pending", "failed"])("frames retained By-tool rows while the new range is %s", async (state) => {
  const report: FleetUsage = {
    hosts: [
      {
        host: "ALPHA",
        readAt: 1000,
        reading: {
          _tag: "Read",
          skipped: 0,
          usage: {
            v: 1,
            machine: "ALPHA",
            observedAt: 0,
            range: { preset: "7d", timeZone: "UTC", from: 0, to: 86400000, bucket: "day" },
            periods: [{ key: "1970-01-01", start: 0 }],
            tokens: [{ period: 0, agent: "claude", model: "Opus", tokens: 1200 }],
            limits: []
          }
        }
      }
    ],
    failures: [],
    peersListed: true
  }
  const reads: UsageModuleReads = {
    usage: (query) =>
      query.range === "7d"
        ? Effect.succeed({ fleet: report, receivedAt: 1000 })
        : state === "failed"
          ? Effect.fail(
              new FleetReadLoadError({
                path: "/v1/connect/usage",
                reason: "network",
                cause: "private transport detail"
              })
            )
          : Effect.never,
    limits: Effect.succeed({ fleet: limits, receivedAt: 1000 })
  }
  window.history.replaceState(null, "", "?range=7d&timeZone=UTC#usage/by-tool")
  await render(reads)
  expect(document.querySelector(".usage-by-tool-total")?.textContent).toBe("1.2K tokens")
  const button = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Range"] button')].find(
    (button) => button.textContent === "30 days"
  )
  await act(async () => button?.click())
  expect(window.location.search).toBe("?range=30d&timeZone=UTC")
  expect(document.querySelector(".usage-by-tool-reading")?.textContent).toContain("last 7 days")
  expect(document.querySelector(".usage-by-tool-total")?.textContent).toBe("1.2K tokens")
  if (state === "pending")
    expect(document.querySelector(".usage-details")?.textContent).toContain(
      "Updating to 30 days… showing the last 7 days"
    )
  else {
    expect(document.querySelector(".usage-details")?.textContent).toContain("Couldn’t refresh")
    expect(document.querySelector(".usage-details")?.textContent).toContain(
      "Previous reading 00:00. Retrying every 5 minutes."
    )
    expect(document.querySelector(".usage-details")?.textContent).not.toContain("private transport detail")
  }
})
