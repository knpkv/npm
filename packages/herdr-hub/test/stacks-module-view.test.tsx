// @vitest-environment happy-dom
import type { DiscoveryIssue } from "@knpkv/alchemy-console/api"
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
  const overviewList = { stacks: [summary(site, "site", "prod", null), summary(org, "infra", "org", 8)], issues: [] }
  const overview: StacksOverviewResult = { _tag: "Ready", list: overviewList }
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
    // A missing count isn't a failure: S3 listings don't count resources.
    expect(text()).toContain("2 stacks in 2 apps.")
    expect(text()).not.toContain("attention")
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
    expect(row("prod")?.textContent).toContain("Not counted")
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
    expect(activity?.textContent).toContain("today")
    expect(activity?.textContent).not.toContain("UTC")
  })

  it("never names stacks as unreadable from a missing count; source problems read one line per cause", async () => {
    const issues: ReadonlyArray<DiscoveryIssue> = [
      { source: "local", reason: "skipped" },
      ...Array.from({ length: 8 }, (): DiscoveryIssue => ({ source: "s3", reason: "authentication" }))
    ]
    await render(reads({ overview: Effect.succeed({ _tag: "Ready", list: { ...overviewList, issues } }) }), "overview")
    expect(text()).not.toContain("couldn’t be read, so")
    const notes = [...document.querySelectorAll("[data-source-issue]")].map(({ textContent }) => textContent)
    expect(notes).toEqual([
      "Sign-in expired for 8 AWS profiles, so their state buckets weren’t read. Fix: run aws sso login for them on the stacks host.",
      "Some project folders under the stacks root couldn’t be read; the rest were."
    ])
  })

  it("says plainly when no stack could be read, naming every cause and its fix", async () => {
    await render(
      reads({
        overview: Effect.succeed({
          _tag: "Ready",
          list: {
            stacks: [],
            issues: [
              { source: "s3", reason: "authentication" },
              { source: "local", reason: "io" }
            ]
          }
        })
      }),
      "overview"
    )
    expect(text()).toContain("Couldn’t read stacks.")
    expect(text()).toContain(
      "Sign-in expired for 1 AWS profile, so its state buckets weren’t read. Fix: run aws sso login for it on the stacks host."
    )
    expect(text()).toContain("The local stacks root or a project’s state couldn’t be read")
    expect(text()).not.toContain("No alchemy stacks found")
  })

  it("counts denied S3 reads per profile, as discovery reports them", async () => {
    const issues: ReadonlyArray<DiscoveryIssue> = [
      { source: "s3", reason: "denied" },
      { source: "s3", reason: "denied" }
    ]
    await render(reads({ overview: Effect.succeed({ _tag: "Ready", list: { ...overviewList, issues } }) }), "overview")
    expect(text()).toContain("Access was denied for 2 AWS profiles, so their state buckets weren’t read.")
  })

  it("never claims the rest were read when the local root itself failed", async () => {
    await render(
      reads({
        overview: Effect.succeed({ _tag: "Ready", list: { stacks: [], issues: [{ source: "local", reason: "io" }] } })
      }),
      "overview"
    )
    expect(text()).not.toContain("the rest were")
    expect(text()).not.toContain("some project folders")
  })

  it("says a capped local walk stopped early and kept what it found", async () => {
    await render(
      reads({
        overview: Effect.succeed({
          _tag: "Ready",
          list: { ...overviewList, issues: [{ source: "local", reason: "truncated" }] }
        })
      }),
      "overview"
    )
    expect(text()).toContain("The project walk stopped early, so projects already found are listed.")
    expect(text()).not.toContain("read failed (truncated)")
  })

  it("does not use the stopped-walk sentence for a local state limit", async () => {
    await render(
      reads({
        overview: Effect.succeed({
          _tag: "Ready",
          list: { ...overviewList, issues: [{ source: "local", reason: "limit" }] }
        })
      }),
      "overview"
    )
    expect(text()).not.toContain("project walk stopped early")
    expect(text()).toContain("local read failed (limit)")
  })

  it("says why stacks aren't available on this computer, naming the setting", async () => {
    await render(
      reads({ overview: Effect.succeed({ _tag: "Unavailable", reason: "not_configured", host: null }) }),
      "overview"
    )
    expect(text()).toContain("Stacks aren’t available on this computer.")
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
    expect(activity?.textContent).toContain("12:15 UTC, today")
    expect(activity?.textContent).toContain("Head")
    // The short id is the copy button's name, not visible text.
    expect(activity?.textContent).not.toMatch(/\b[0-9a-f]{7}\b/u)
    expect(activity?.querySelector("button[aria-label='Copy head a1b2c3d']")).not.toBeNull()
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

  it("copies the activity head without showing the id", async () => {
    const writeText = vi.fn(() => Promise.resolve())
    const prior = Object.getOwnPropertyDescriptor(navigator, "clipboard")
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    try {
      await render(reads(), "stack", `id=${org}`)
      const activity = document.querySelector("[aria-label='Activity']")
      expect(activity?.textContent).toContain("Head")
      expect(activity?.textContent).toContain("12:15 UTC, today")
      expect(activity?.textContent).not.toMatch(/\b[0-9a-f]{7}\b/u)
      const button = activity?.querySelector<HTMLButtonElement>("button[aria-label='Copy head a1b2c3d']")
      expect(button).not.toBeNull()
      expect(button?.getAttribute("tabindex")).not.toBe("-1")
      await act(async () => button?.click())
      expect(writeText).toHaveBeenCalledWith("a1b2c3d")
      expect(activity?.querySelector("[aria-live='polite']")?.textContent).toBe("Copied")
      expect(activity?.querySelector("button svg")?.getAttribute("class")).toContain("lucide-check")
      expect(activity?.querySelector("[role='alert']")).toBeNull()
      expect(activity?.textContent).not.toMatch(/\b[0-9a-f]{7}\b/u)
    } finally {
      if (prior === undefined) {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
      } else Object.defineProperty(navigator, "clipboard", prior)
    }
  })

  it("says when the activity head cannot be copied", async () => {
    const prior = Object.getOwnPropertyDescriptor(navigator, "clipboard")
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
    try {
      await render(reads(), "stack", `id=${org}`)
      const activity = document.querySelector("[aria-label='Activity']")
      const button = activity?.querySelector<HTMLButtonElement>("button[aria-label='Copy head a1b2c3d']")
      await act(async () => button?.click())
      expect(activity?.querySelector("[role='alert']")?.textContent).toBe("Couldn’t copy the head")
      expect(activity?.textContent).not.toMatch(/\b[0-9a-f]{7}\b/u)
    } finally {
      if (prior === undefined) {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
      } else Object.defineProperty(navigator, "clipboard", prior)
    }
  })

  it("copies head, base and digest from the plan line without showing them", async () => {
    const writeText = vi.fn(() => Promise.resolve())
    const prior = Object.getOwnPropertyDescriptor(navigator, "clipboard")
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    try {
      if (published._tag !== "Ready") throw new Error("fixture")
      const plan: PlanState = {
        _tag: "Ready",
        plan: {
          ...published.plan,
          source: { ...published.plan.source, base: "b4b5b6b" }
        }
      }
      await render(reads({ plan: () => Effect.succeed({ _tag: "Ready", plan }) }), "stack", `id=${org}&view=plan`)
      const panel = document.querySelector("[aria-label='Latest CI plan']")
      const text = panel?.textContent ?? ""
      expect(text).toContain("Head")
      expect(text).toContain("Base")
      expect(text).toContain("Digest")
      expect(text).toContain("published")
      expect(text).not.toMatch(/\b[0-9a-f]{7}\b/u)
      expect(text).not.toContain("ab12…cd34")
      expect(text).not.toContain("·")
      const copies: ReadonlyArray<readonly [string, string]> = [
        ["Copy head a1b2c3d", "a1b2c3d"],
        ["Copy base b4b5b6b", "b4b5b6b"],
        ["Copy digest ab12…cd34", "ab12…cd34"]
      ]
      for (const [name, value] of copies) {
        const button = panel?.querySelector<HTMLButtonElement>(`button[aria-label='${name}']`)
        expect(button).not.toBeNull()
        expect(button?.getAttribute("tabindex")).not.toBe("-1")
        await act(async () => button?.click())
        expect(writeText).toHaveBeenCalledWith(value)
        expect(button?.parentElement?.querySelector("[aria-live='polite']")?.textContent).toBe("Copied")
        expect(button?.querySelector("svg")?.getAttribute("class")).toContain("lucide-check")
        expect(panel?.textContent).not.toMatch(/\b[0-9a-f]{7}\b/u)
      }
    } finally {
      if (prior === undefined) {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
      } else Object.defineProperty(navigator, "clipboard", prior)
    }
  })

  it("names the plan head and digest on copy buttons on the Plan tab", async () => {
    await render(reads(), "stack", `id=${org}&view=plan`)
    const panel = document.querySelector("[aria-label='Latest CI plan']")
    expect(panel?.textContent).toContain("published")
    expect(panel?.textContent).toContain("Head")
    expect(panel?.textContent).toContain("Digest")
    expect(panel?.textContent).not.toMatch(/\b[0-9a-f]{7}\b/u)
    expect(panel?.querySelector("button[aria-label='Copy head a1b2c3d']")).not.toBeNull()
    // The digest is a copy button too. Relay copy uses commas, never middots.
    expect(panel?.textContent).not.toContain("ab12…cd34")
    expect(panel?.querySelector("button[aria-label='Copy digest ab12…cd34']")).not.toBeNull()
    expect(document.querySelector(".stacks-page")?.textContent).not.toContain("·")
  })

  it("reports an unknown or missing stack id as not found", async () => {
    await render(reads(), "stack", "")
    expect(text()).toContain("This stack is no longer available.")
  })
})
