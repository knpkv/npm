// @vitest-environment happy-dom
import type { StackDetailResult, StacksOverviewResult } from "@knpkv/alchemy-console/host"
import { PortalProvider } from "@knpkv/rly/foundations"
import { Effect } from "effect"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { StacksModuleReads } from "../src/stacks-client.js"
import { makeStacksModuleViews } from "../src/stacks-module-view.js"
import type { ModulePageMount } from "../src/modules.js"

describe("Stacks module pages", { concurrent: false }, () => {
  let root: Root | null = null
  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true))
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = null
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })
  const id = "00000000-0000-4000-8000-000000000001"
  const overview: StacksOverviewResult = {
    _tag: "Ready",
    list: {
      stacks: [
        {
          id,
          app: "aws-org",
          stage: "org",
          backend: "s3",
          alchemyVersion: "2.0.0-beta.81",
          lastDeploy: null,
          resourceCount: 42
        }
      ],
      issues: []
    }
  }
  const detail: StackDetailResult = {
    _tag: "Ready",
    detail: {
      id,
      state: {
        app: "aws-org",
        stage: "org",
        backend: "s3",
        alchemyVersion: "2.0.0-beta.81",
        lastDeploy: null,
        outputs: [],
        resources: []
      }
    }
  }
  const reads = (over: Partial<StacksModuleReads> = {}): StacksModuleReads => ({
    overview: Effect.succeed(overview),
    stack: () => Effect.succeed(detail),
    plan: () => Effect.succeed({ _tag: "Ready", plan: { _tag: "NotPublishing" } }),
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

  it("lists the host's stacks and links each one to its stack page", async () => {
    await render(reads(), "overview")
    expect(document.body.textContent).toContain("aws-org")
    const link = [...document.querySelectorAll("a")].find(({ textContent }) => textContent?.includes("org"))
    expect(link?.getAttribute("href")).toBe(`?id=${id}#stacks/stack`)
  })

  it("says why stacks aren't available on this hub, naming the setting", async () => {
    await render(
      reads({ overview: Effect.succeed({ _tag: "Unavailable", reason: "not_configured", host: null }) }),
      "overview"
    )
    expect(document.body.textContent).toContain("Stacks aren’t available on this hub.")
    expect(document.body.textContent).toContain("RELAY_STACKS_HOST")
  })

  it("shows a stack's resources and its plan state, with no apply or plan action", async () => {
    await render(reads(), "stack", `id=${id}&view=plan`)
    expect(document.body.textContent).toContain("aws-org")
    const buttons = [...document.querySelectorAll("button")].map(({ textContent }) => textContent ?? "")
    expect(buttons.some((text) => /apply|destroy|deploy|preview changes/iu.test(text))).toBe(false)
  })

  it("reports an unknown or missing stack id as not found", async () => {
    await render(reads(), "stack", "")
    expect(document.body.textContent).toContain("This stack is no longer available.")
  })
})
