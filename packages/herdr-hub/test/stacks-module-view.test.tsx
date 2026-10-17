// @vitest-environment happy-dom
import type {
  PlanState,
  StackDetailResult,
  StackPlanResult,
  StacksOverviewResult,
  StackSummary
} from "@knpkv/alchemy-console/host"
import { PortalProvider } from "@knpkv/rly/foundations"
import { Effect } from "effect"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ModulePageMount } from "../src/modules.js"
import { type StacksModuleReads, StacksReadFailed } from "../src/stacks-client.js"
import { makeStacksModuleViews } from "../src/stacks-module-view.js"

describe("Stacks module pages", { concurrent: false }, () => {
  let root: Root | null = null
  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true))
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = null
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })
  const org = "00000000-0000-4000-8000-000000000001"
  const site = "00000000-0000-4000-8000-000000000002"
  const summary = (id: string, app: string, stage: string, resourceCount: number | null): StackSummary => ({
    id,
    app,
    stage,
    backend: "s3",
    alchemyVersion: "2.0.0-beta.81",
    lastDeploy: null,
    resourceCount
  })
  const overview: StacksOverviewResult = {
    _tag: "Ready",
    list: { stacks: [summary(site, "site", "prod", null), summary(org, "infra", "org", 8)], issues: [] }
  }
  const published: PlanState = {
    _tag: "Ready",
    plan: {
      source: {
        pr: null,
        head: "a1b2c3d",
        base: null,
        publishedAt: "2026-10-17T12:15:00Z",
        ageDays: 0,
        runHref: "https://github.com/knpkv/infra/actions/runs/101"
      },
      digest: "ab12…cd34",
      rows: [],
      stale: null
    }
  }
  const detail: StackDetailResult = {
    _tag: "Ready",
    detail: {
      id: org,
      state: {
        app: "infra",
        stage: "org",
        backend: "s3",
        alchemyVersion: "2.0.0-beta.81",
        lastDeploy: null,
        outputs: [],
        resources: [
          {
            fqn: "root",
            logicalId: "root",
            resourceType: "AWS::Organizations::Organization",
            status: "created",
            parent: null,
            providerId: "o-ex12ab34cd",
            account: null,
            region: null,
            consoleUrl: null,
            updatedAt: null,
            downstream: null
          }
        ]
      }
    }
  }
  const reads = (over: Partial<StacksModuleReads> = {}): StacksModuleReads => ({
    overview: Effect.succeed(overview),
    stack: () => Effect.succeed(detail),
    plan: (id) => Effect.succeed({ _tag: "Ready", plan: id === org ? published : { _tag: "NotPublishing" } }),
    ...over
  })
  const render = async (r: StacksModuleReads, page: "overview" | "stack", search = "") => {
    if (root === null) {
      const host = document.createElement("div")
      document.body.append(host)
      root = createRoot(host)
    }
    const navigate = vi.fn<ModulePageMount["navigate"]>()
    const module = makeStacksModuleViews({ reads: r })
    await act(async () =>
      root?.render(
        <PortalProvider>
          {module.pages[page](new URLSearchParams(search), { active: true, navigate, closeSelection: () => undefined })}
        </PortalProvider>
      )
    )
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
    return navigate
  }
  const text = () => document.body.textContent ?? ""
  const row = (name: string) =>
    [...document.querySelectorAll("tbody tr")].find((tr) => tr.querySelector("th")?.textContent?.includes(name))

  it("heads the page and counts the stacks", async () => {
    await render(reads(), "overview")
    expect(document.querySelector("h1")?.textContent).toBe("Stacks")
    expect(text()).toContain("Infrastructure state, read-only")
    expect(text()).toContain("2 stacks in 2 apps, 1 needs attention.")
  })

  it("lists each stack with its resources and last plan, and phase-2 facts as not checked yet", async () => {
    await render(reads(), "overview")
    const headers = [...document.querySelectorAll("thead th")].map(({ textContent }) => textContent)
    expect(headers).toEqual(["Stack", "Resources", "Last plan", "Last apply", "Drift", "Gate"])
    const groups = [...document.querySelectorAll("tbody tr[data-app] th")].map(({ textContent }) => textContent)
    expect(groups).toEqual(["infra, 1 stack", "site, 1 stack"])
    const orgRow = row("org")
    expect(orgRow?.querySelector("th")?.textContent).toBe("org")
    expect(orgRow?.textContent).toContain("8")
    expect(orgRow?.textContent).toContain("No changes")
    expect(orgRow?.querySelectorAll("[data-unchecked]")).toHaveLength(3)
    expect(orgRow?.textContent).toContain("Not checked yet")
    expect(row("prod")?.textContent).toContain("Unknown")
    expect(row("prod")?.textContent).toContain("Not publishing")
    expect(orgRow?.querySelector("a")?.getAttribute("href")).toBe(`?id=${org}#stacks/stack`)
  })

  it("reads at most three plans at once, however many stacks are listed", async () => {
    const ids = Array.from({ length: 7 }, (_, index) => `00000000-0000-4000-8000-00000000010${index}`)
    let inFlight = 0
    let most = 0
    const many: StacksOverviewResult = {
      _tag: "Ready",
      list: { stacks: ids.map((id, index) => summary(id, "fleet", `stage-${index}`, 1)), issues: [] }
    }
    await render(
      reads({
        overview: Effect.succeed(many),
        plan: () =>
          Effect.sync(() => {
            inFlight += 1
            most = Math.max(most, inFlight)
          }).pipe(
            Effect.andThen(Effect.sleep("5 millis")),
            Effect.ensuring(Effect.sync(() => (inFlight -= 1))),
            Effect.as({ _tag: "Ready", plan: { _tag: "NotPublishing" } } satisfies StackPlanResult)
          )
      }),
      "overview"
    )
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 60)))
    expect(most).toBe(3)
    const rows = [...document.querySelectorAll("tbody tr:not([data-app])")]
    expect(rows).toHaveLength(7)
    expect(rows.every((row) => row.textContent?.includes("Not publishing") === true)).toBe(true)
  })

  it("keeps the stack page up when a plan's publish time is malformed", async () => {
    const malformed: PlanState =
      published._tag === "Ready"
        ? { ...published, plan: { ...published.plan, source: { ...published.plan.source, publishedAt: "not a date" } } }
        : published
    await render(reads({ plan: () => Effect.succeed({ _tag: "Ready", plan: malformed }) }), "stack", `id=${org}`)
    const activity = document.querySelector("[aria-label='Activity']")
    expect(activity?.textContent).toContain("No changes")
    expect(activity?.textContent).toContain("today, a1b2c3d")
    expect(activity?.textContent).not.toContain("UTC")
  })

  it("names the stacks that couldn’t be read", async () => {
    await render(reads(), "overview")
    expect(text()).toContain("site prod couldn’t be read, so its resources read Unknown. The other stacks were read.")
  })

  it("says why stacks aren't available on this hub, naming the setting", async () => {
    await render(
      reads({ overview: Effect.succeed({ _tag: "Unavailable", reason: "not_configured", host: null }) }),
      "overview"
    )
    expect(text()).toContain("Stacks aren’t available on this hub.")
    expect(text()).toContain("RELAY_STACKS_HOST")
  })

  it("shows a stack's activity, with the plan's run linked, and its resource tabs", async () => {
    await render(reads(), "stack", `id=${org}`)
    expect(document.querySelector("a[data-back]")?.getAttribute("href")).toBe("?#stacks/overview")
    expect(document.querySelector("h2")?.textContent).toBe("org")
    expect(document.querySelector(".stacks-title p")?.textContent).toBe("App infra1 resource")
    const activity = document.querySelector("[aria-label='Activity']")
    expect(activity?.textContent).toContain("Last apply")
    expect(activity?.textContent).toContain("Not checked yet")
    expect(activity?.textContent).toContain("No changes")
    expect(activity?.textContent).toContain("12:15 UTC, today, a1b2c3d")
    expect(document.querySelector(".ac-resource-name")?.tagName).toBe("SPAN")
    expect(activity?.querySelector("a")?.getAttribute("href")).toBe("https://github.com/knpkv/infra/actions/runs/101")
    expect([...document.querySelectorAll("[role='tab']")].map(({ textContent }) => textContent)).toEqual([
      "Resources",
      "State",
      "Outputs",
      "Plan"
    ])
    const buttons = [...document.querySelectorAll("button")].map(({ textContent }) => textContent ?? "")
    expect(buttons.some((label) => /apply|destroy|deploy|approve|preview changes/iu.test(label))).toBe(false)
  })

  it("asks to sign in again when the hub session lapsed, on both pages", async () => {
    const lapsed = Effect.fail(new StacksReadFailed({ reason: "unauthorized" }))
    await render(reads({ overview: lapsed, stack: () => lapsed }), "overview")
    expect(text()).toContain("Reload this page to sign in again.")
    await render(reads({ overview: lapsed, stack: () => lapsed }), "stack", `id=${org}`)
    expect(text()).toContain("Reload this page to sign in again.")
  })

  it("reports an unknown or missing stack id as not found", async () => {
    await render(reads(), "stack", "")
    expect(text()).toContain("This stack is no longer available.")
  })
})
