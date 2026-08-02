// @vitest-environment happy-dom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter, Outlet, Route, Routes } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PortfolioReleaseSummary } from "../../src/api/portfolio.js"
import {
  AgentPage,
  boundedReleaseAgentHistory,
  ConnectedAgentPage,
  type ReleaseAgentPresetLoader,
  type ReleaseAgentTurn
} from "../../src/client/AgentPage.js"
import { presentPortfolio } from "../../src/client/portfolio/presentPortfolio.js"
import type { WorkspaceReleaseOutletContext } from "../../src/client/releases/WorkspaceReleaseLayout.js"
import { EventCursor } from "../../src/domain/identifiers.js"
import { ReleaseVersion } from "../../src/domain/release.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const snapshot = makePortfolioSnapshot()
const historyRole = (index: number): "assistant" | "user" => (index % 2 === 0 ? "user" : "assistant")
const failureCases: ReadonlyArray<readonly [string, string]> = [
  ["RateLimitedApiError", "Too many agent turns"],
  ["RequestTimedOutApiError", "Relay took too long"]
]
const releaseId = snapshot.releases[0]?.releaseId
if (releaseId === undefined) throw new Error("Expected an agent-page release fixture")
const agentPath = `/w/${snapshot.workspaceId}/releases/${releaseId}/agent`
const readyContext = {
  controller: {
    onRetry: vi.fn(),
    state: {
      _tag: "ready",
      connection: { _tag: "connected" },
      isSnapshotStale: false,
      portfolio: presentPortfolio(snapshot)
    }
  },
  requestReleaseFocus: vi.fn(),
  workspaceId: snapshot.workspaceId
} satisfies WorkspaceReleaseOutletContext

let mountedRoot: Root | undefined

beforeEach(() => {
  sessionStorage.setItem("cc_session_id", "01890f6f-6d6a-7cc0-98d2-000000000002")
})

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  sessionStorage.clear()
  document.body.replaceChildren()
})

const CanonicalAgent = ({
  availableProviders,
  runTurn
}: {
  readonly availableProviders?: ReadonlyArray<"claude" | "codex">
  readonly runTurn?: ReleaseAgentTurn
}) => (
  <MemoryRouter initialEntries={[agentPath]}>
    <Routes>
      <Route element={<Outlet context={readyContext} />}>
        <Route
          path="/w/:workspaceId/releases/:releaseId/agent"
          element={
            <AgentPage
              {...(availableProviders === undefined ? {} : { availableProviders })}
              {...(runTurn === undefined ? {} : { runTurn })}
            />
          }
        />
      </Route>
    </Routes>
  </MemoryRouter>
)

const ConnectedCanonicalAgent = ({
  loadPresets,
  runTurn = async () => Promise.reject()
}: {
  readonly loadPresets: ReleaseAgentPresetLoader
  readonly runTurn?: ReleaseAgentTurn
}) => (
  <MemoryRouter initialEntries={[agentPath]}>
    <Routes>
      <Route element={<Outlet context={readyContext} />}>
        <Route
          path="/w/:workspaceId/releases/:releaseId/agent"
          element={<ConnectedAgentPage loadPresets={loadPresets} runTurn={runTurn} />}
        />
      </Route>
    </Routes>
  </MemoryRouter>
)

const renderAgentPage = (from: string): string =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/agent?from=${encodeURIComponent(from)}`]}>
      <AgentPage />
    </MemoryRouter>
  )

describe("AgentPage context", () => {
  it("keeps the newest complete history that fits the server payload bounds", () => {
    const history = boundedReleaseAgentHistory(
      Array.from({ length: 13 }, (_, index) => ({
        content: `${index}: ${"x".repeat(13_000)}`,
        role: historyRole(index)
      }))
    )
    expect(history.length).toBeLessThanOrEqual(12)
    expect(history.at(-1)?.content).toContain("12:")
    expect(history.every(({ content }) => content.length <= 12_000)).toBe(true)
    expect(history.reduce((length, { content }) => length + content.length, 0)).toBeLessThanOrEqual(64_000)
  })

  it("names an exact canonical release context without substituting another entity", () => {
    const path = "/w/01890f6f-6d6a-7cc0-98d2-000000000001/releases/01890f6f-6d6a-7cc0-98d2-000000000011/preview"
    const markup = renderAgentPage(path)
    expect(markup).toContain("Release 000011")
    expect(markup).toContain("01890f6f-6d6a-7cc0-98d2-000000000001")
    expect(markup).toContain(`href="${path}"`)
    expect(markup).not.toContain("The workspace-wide view")
  })

  it("preserves Items and Active work query context for legacy Relay entry", () => {
    const workspaceId = "01890f6f-6d6a-7cc0-98d2-000000000001"
    const itemsPath = `/w/${workspaceId}/items?q=OPS-428&object=issue#item-details`
    const itemsMarkup = renderAgentPage(itemsPath)
    expect(itemsMarkup).toContain("Workspace items")
    expect(itemsMarkup).toContain(`href="${itemsPath.replaceAll("&", "&amp;")}"`)
    expect(itemsMarkup).toContain("Choose a release to run Relay")
    expect(itemsMarkup).not.toContain("Context unavailable")

    const workPath = `/w/${workspaceId}/work?release=01890f6f-6d6a-7cc0-98d2-000000000011`
    const workMarkup = renderAgentPage(workPath)
    expect(workMarkup).toContain("Active work")
    expect(workMarkup).toContain(`href="${workPath.replaceAll("&", "&amp;")}"`)
  })

  it("names the exact selected workspace entity in the Relay chooser", () => {
    const workspaceId = "01890f6f-6d6a-7cc0-98d2-000000000001"
    const entityId = "37eadfe4-caa9-73ca-81ec-86e2ec8f6a07"
    const path = `/w/${workspaceId}/items?object=${entityId}#item-details`
    const markup = renderAgentPage(path)
    expect(markup).toContain(`Workspace item ${entityId.slice(-6)}`)
    expect(markup).toContain(entityId)
    expect(markup).toContain(`href="${path.replaceAll("&", "&amp;")}"`)
  })

  it("preserves an exact Timeline context for Relay", () => {
    const workspaceId = "01890f6f-6d6a-7cc0-98d2-000000000001"
    const timelinePath = `/w/${workspaceId}/timeline?actor=plugin&amp;from=2026-07-01`
    const markup = renderAgentPage(timelinePath.replace("&amp;", "&"))

    expect(markup).toContain("Workspace timeline")
    expect(markup).toContain("Attributable delivery activity")
    expect(markup).toContain(`href="${timelinePath}"`)
    expect(markup).not.toContain("Context unavailable")

    const eventPath = `/w/${workspaceId}/timeline?actor=agent&event=action%3Aevent-43`
    const eventMarkup = renderAgentPage(eventPath)
    expect(eventMarkup).toContain("Timeline event action:event-43")
    expect(eventMarkup).toContain(`href="${eventPath.replaceAll("&", "&amp;")}"`)
  })

  it("rejects external and unknown contexts instead of falling back to Overview", () => {
    const workspaceId = "01890f6f-6d6a-7cc0-98d2-000000000001"
    for (const path of [
      "https://example.com/release",
      "/api/v1/portfolio/snapshot",
      "/w/not-an-id/overview",
      `/x/${workspaceId}/items`,
      `/w/${workspaceId}/items/not-a-route`,
      `/w/${workspaceId}/work?release=invalid`
    ]) {
      const markup = renderAgentPage(path)
      expect(markup).toContain("Context unavailable")
      expect(markup).toContain("No fallback workspace or entity is substituted.")
      expect(markup).not.toContain("Return to Overview")
    }
  })

  it("puts exact release identity and collaborators before an honest runtime state", () => {
    const markup = renderToStaticMarkup(<CanonicalAgent />)
    expect(markup).toContain("Ask Copper Finch.")
    expect(markup).toContain("Copper Finch")
    expect(markup).toContain("Avery Bell")
    expect(markup.indexOf("Avery Bell")).toBeLessThan(markup.indexOf("Release thread"))
    expect(markup).toContain("Local agent not connected")
    expect(markup).toContain(`href="/w/${snapshot.workspaceId}/releases/${releaseId}"`)
  })

  it("disables an unavailable provider preset instead of letting the turn fail after submit", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    mountedRoot = root
    await act(async () =>
      root.render(
        <CanonicalAgent
          availableProviders={["codex"]}
          runTurn={async () => Promise.reject(new Error("Unexpected turn"))}
        />
      )
    )

    const codex = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent?.includes("Run with Codex") === true
    )
    const claude = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent?.includes("Run with Claude") === true
    )
    expect(codex?.disabled).toBe(false)
    expect(claude?.disabled).toBe(true)
    expect(claude?.textContent).toContain("Not configured")
  })

  it("keeps a failed provider discovery retryable and enables the recovered catalog", async () => {
    const loadPresets = vi
      .fn<ReleaseAgentPresetLoader>()
      .mockRejectedValueOnce(new Error("Temporary catalog failure"))
      .mockResolvedValueOnce(["codex"])
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => mountedRoot?.render(<ConnectedCanonicalAgent loadPresets={loadPresets} />))

    expect(host.textContent).toContain("Agent presets could not be refreshed")
    expect(host.textContent).not.toContain("Selected agent is not configured")
    expect([...host.querySelectorAll<HTMLButtonElement>("[role='radio']")].every(({ disabled }) => disabled)).toBe(true)
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true)
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "Retry agent presets"
    )
    if (retry === undefined) throw new Error("Expected the provider-catalog retry")
    await act(async () => retry.click())

    const codex = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent?.includes("Run with Codex") === true
    )
    expect(loadPresets).toHaveBeenCalledTimes(2)
    expect(host.textContent).not.toContain("Agent presets could not be refreshed")
    expect(codex?.disabled).toBe(false)
  })

  it("keeps presets and submission disabled while provider discovery is pending", async () => {
    const loadPresets = vi.fn<ReleaseAgentPresetLoader>(() => new Promise(() => undefined))
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => mountedRoot?.render(<ConnectedCanonicalAgent loadPresets={loadPresets} />))

    expect([...host.querySelectorAll<HTMLButtonElement>("[role='radio']")].every(({ disabled }) => disabled)).toBe(true)
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true)
    expect(host.textContent).not.toContain("Not configured")
  })

  it("enables only the provider returned by connected discovery", async () => {
    const loadPresets = vi.fn<ReleaseAgentPresetLoader>().mockResolvedValue(["claude"])
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => mountedRoot?.render(<ConnectedCanonicalAgent loadPresets={loadPresets} />))

    const codex = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent?.includes("Run with Codex") === true
    )
    const claude = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent?.includes("Run with Claude") === true
    )
    expect(codex?.disabled).toBe(true)
    expect(claude?.disabled).toBe(false)
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false)
  })

  const orderedProviderCases: ReadonlyArray<readonly [ReadonlyArray<"claude" | "codex">, "claude" | "codex"]> = [
    [["claude", "codex"], "claude"],
    [["codex", "claude"], "codex"]
  ]

  it.each(orderedProviderCases)(
    "uses the first ordered connected preset as the untouched default",
    async (providers, expectedProvider) => {
      const currentRelease = snapshot.releases[0]
      if (currentRelease === undefined) throw new Error("Expected a release turn fixture")
      const runTurn = vi.fn<ReleaseAgentTurn>(async (input) => ({
        eventCursor: EventCursor.make(11),
        provider: input.provider,
        release: currentRelease,
        reply: "The configured default answered."
      }))
      const host = document.createElement("div")
      document.body.append(host)
      mountedRoot = createRoot(host)
      await act(async () =>
        mountedRoot?.render(
          <ConnectedCanonicalAgent
            loadPresets={vi.fn<ReleaseAgentPresetLoader>().mockResolvedValue(providers)}
            runTurn={runTurn}
          />
        )
      )

      const suggestion = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        ({ textContent }) => textContent?.includes("Which evidence is still missing?") === true
      )
      if (suggestion === undefined) throw new Error("Expected an agent suggestion")
      await act(async () => suggestion.click())
      const form = host.querySelector<HTMLTextAreaElement>("textarea")?.closest("form")
      if (form === null || form === undefined) throw new Error("Expected the release agent form")
      await act(async () => form.requestSubmit())

      expect(runTurn).toHaveBeenCalledOnce()
      expect(runTurn.mock.calls[0]?.[0].provider).toBe(expectedProvider)
    }
  )

  it("keeps an explicit provider selection over the ordered connected default", async () => {
    const currentRelease = snapshot.releases[0]
    if (currentRelease === undefined) throw new Error("Expected a release turn fixture")
    const runTurn = vi.fn<ReleaseAgentTurn>(async (input) => ({
      eventCursor: EventCursor.make(11),
      provider: input.provider,
      release: currentRelease,
      reply: "The selected provider answered."
    }))
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () =>
      mountedRoot?.render(
        <ConnectedCanonicalAgent
          loadPresets={vi.fn<ReleaseAgentPresetLoader>().mockResolvedValue(["claude", "codex"])}
          runTurn={runTurn}
        />
      )
    )

    const codex = [...host.querySelectorAll<HTMLButtonElement>("[role='radio']")].find(
      ({ textContent }) => textContent?.includes("Run with Codex") === true
    )
    if (codex === undefined) throw new Error("Expected the Codex preset")
    await act(async () => codex.click())
    const suggestion = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent?.includes("Which evidence is still missing?") === true
    )
    if (suggestion === undefined) throw new Error("Expected an agent suggestion")
    await act(async () => suggestion.click())
    const form = host.querySelector<HTMLTextAreaElement>("textarea")?.closest("form")
    if (form === null || form === undefined) throw new Error("Expected the release agent form")
    await act(async () => form.requestSubmit())

    expect(runTurn.mock.calls[0]?.[0].provider).toBe("codex")
  })

  it("keeps a successfully loaded empty provider catalog definitive", async () => {
    const loadPresets = vi.fn<ReleaseAgentPresetLoader>().mockResolvedValue([])
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => mountedRoot?.render(<ConnectedCanonicalAgent loadPresets={loadPresets} />))

    const providerButtons = [...host.querySelectorAll<HTMLButtonElement>("[role='radio']")]
    expect(loadPresets).toHaveBeenCalledOnce()
    expect(providerButtons).toHaveLength(2)
    expect(providerButtons.every(({ disabled }) => disabled)).toBe(true)
    expect(host.textContent).toContain("Selected agent is not configured")
    expect(host.textContent).not.toContain("Retry agent presets")
  })

  it("keeps a local release thread and sends only exact identity, bounded history, and the prompt", async () => {
    const currentRelease = snapshot.releases[0]
    if (currentRelease === undefined) throw new Error("Expected a release turn fixture")
    const answerRelease = PortfolioReleaseSummary.make({
      ...currentRelease,
      version: ReleaseVersion.make("2.18.0-rc.2")
    })
    const runTurn = vi.fn<ReleaseAgentTurn>(async (input) => ({
      eventCursor: EventCursor.make(11),
      provider: input.provider,
      release: answerRelease,
      reply: "Production evidence is missing."
    }))
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    mountedRoot = root
    await act(async () => root.render(<CanonicalAgent runTurn={runTurn} />))

    const suggestion = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Which evidence is still missing?") === true
    )
    if (suggestion === undefined) throw new Error("Expected an agent suggestion")
    expect(host.textContent).not.toContain("Selected agent is not configured")
    expect(suggestion.disabled).toBe(false)
    await act(async () => suggestion.click())
    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")
    if (textarea === null) throw new Error("Expected the release agent composer")
    expect(textarea.value).toBe("Which evidence is still missing?")
    const form = textarea.closest("form")
    if (form === null) throw new Error("Expected the release agent form")
    await act(async () => form.requestSubmit())

    expect(runTurn).toHaveBeenCalledOnce()
    expect(runTurn.mock.calls[0]?.[0]).toEqual({
      history: [],
      originPath: agentPath,
      prompt: "Which evidence is still missing?",
      provider: "codex",
      releaseId,
      workspaceId: snapshot.workspaceId
    })
    expect(host.textContent).toContain("Which evidence is still missing?")
    expect(host.textContent).toContain("Production evidence is missing.")
    expect(host.textContent).toContain("Preset codex")
    expect(host.textContent).toContain("Last answer codex")
    expect(host.textContent).toContain("Answered from payments-api 2.18.0-rc.2 · Copper Finch · snapshot 11")

    await act(async () => root.unmount())
    mountedRoot = undefined
    const restoredRoot = createRoot(host)
    mountedRoot = restoredRoot
    await act(async () => restoredRoot.render(<CanonicalAgent runTurn={runTurn} />))
    expect(host.textContent).toContain("Which evidence is still missing?")
    expect(host.textContent).toContain("Production evidence is missing.")
    const claudePreset = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Run with Claude") === true
    )
    if (claudePreset === undefined) throw new Error("Expected a Claude run preset")
    await act(async () => claudePreset.click())
    const nextSuggestion = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Write a concise release summary.") === true
    )
    if (nextSuggestion === undefined) throw new Error("Expected a restored-thread suggestion")
    await act(async () => nextSuggestion.click())
    const restoredTextarea = host.querySelector<HTMLTextAreaElement>("textarea")
    const restoredForm = restoredTextarea?.closest("form")
    if (restoredForm === null || restoredForm === undefined) throw new Error("Expected the restored thread form")
    await act(async () => restoredForm.requestSubmit())
    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(runTurn.mock.calls[1]?.[0].provider).toBe("claude")
    expect(host.textContent).toContain("Write a concise release summary.")

    await act(async () => restoredRoot.unmount())
    mountedRoot = undefined
    sessionStorage.setItem("cc_session_id", "01890f6f-6d6a-7cc0-98d2-000000000099")
    const replacementSessionRoot = createRoot(host)
    mountedRoot = replacementSessionRoot
    await act(async () => replacementSessionRoot.render(<CanonicalAgent runTurn={runTurn} />))
    expect(host.textContent).not.toContain("Production evidence is missing.")
    expect(host.querySelector("[data-rly-agent-thread-message]")).toBeNull()
  })

  it.each(failureCases)("renders a specific recovery state for %s", async (tag, title) => {
    const runTurn = vi.fn<ReleaseAgentTurn>(async () => Promise.reject({ _tag: tag }))
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    mountedRoot = root
    await act(async () => root.render(<CanonicalAgent runTurn={runTurn} />))

    const suggestion = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("What blocks this release?") === true
    )
    if (suggestion === undefined) throw new Error("Expected an agent suggestion")
    await act(async () => suggestion.click())
    const form = host.querySelector<HTMLTextAreaElement>("textarea")?.closest("form")
    if (form === null || form === undefined) throw new Error("Expected the release agent form")
    await act(async () => form.requestSubmit())

    expect(host.textContent).toContain(title)
  })
})
