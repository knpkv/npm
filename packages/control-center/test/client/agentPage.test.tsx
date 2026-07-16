// @vitest-environment happy-dom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter, Outlet, Route, Routes } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PortfolioReleaseSummary } from "../../src/api/portfolio.js"
import { AgentPage, boundedReleaseAgentHistory, type ReleaseAgentTurn } from "../../src/client/AgentPage.js"
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

const CanonicalAgent = ({ runTurn }: { readonly runTurn?: ReleaseAgentTurn }) => (
  <MemoryRouter initialEntries={[agentPath]}>
    <Routes>
      <Route element={<Outlet context={readyContext} />}>
        <Route
          path="/w/:workspaceId/releases/:releaseId/agent"
          element={<AgentPage {...(runTurn === undefined ? {} : { runTurn })} />}
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

  it("rejects external and unknown contexts instead of falling back to Overview", () => {
    for (const path of ["https://example.com/release", "/api/v1/portfolio/snapshot", "/w/not-an-id/overview"]) {
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

  it("keeps a local release thread and sends only exact identity, bounded history, and the prompt", async () => {
    const currentRelease = snapshot.releases[0]
    if (currentRelease === undefined) throw new Error("Expected a release turn fixture")
    const answerRelease = PortfolioReleaseSummary.make({
      ...currentRelease,
      version: ReleaseVersion.make("2.18.0-rc.2")
    })
    const runTurn = vi.fn<ReleaseAgentTurn>(async () => ({
      eventCursor: EventCursor.make(11),
      provider: "codex",
      release: answerRelease,
      reply: "Production evidence is missing."
    }))
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    mountedRoot = root
    await act(async () => root.render(<CanonicalAgent runTurn={runTurn} />))

    const suggestion = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Which evidence is still missing?"
    )
    if (suggestion === undefined) throw new Error("Expected an agent suggestion")
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
      prompt: "Which evidence is still missing?",
      releaseId,
      workspaceId: snapshot.workspaceId
    })
    expect(host.textContent).toContain("Which evidence is still missing?")
    expect(host.textContent).toContain("Production evidence is missing.")
    expect(host.textContent).toContain("Local codex")
    expect(host.textContent).toContain("Answered from payments-api 2.18.0-rc.2 · Copper Finch · snapshot 11")

    await act(async () => root.unmount())
    mountedRoot = undefined
    const restoredRoot = createRoot(host)
    mountedRoot = restoredRoot
    await act(async () => restoredRoot.render(<CanonicalAgent runTurn={runTurn} />))
    expect(host.textContent).toContain("Which evidence is still missing?")
    expect(host.textContent).toContain("Production evidence is missing.")
    const nextSuggestion = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Write a concise release summary."
    )
    if (nextSuggestion === undefined) throw new Error("Expected a restored-thread suggestion")
    await act(async () => nextSuggestion.click())
    const restoredTextarea = host.querySelector<HTMLTextAreaElement>("textarea")
    const restoredForm = restoredTextarea?.closest("form")
    if (restoredForm === null || restoredForm === undefined) throw new Error("Expected the restored thread form")
    await act(async () => restoredForm.requestSubmit())
    expect(runTurn).toHaveBeenCalledTimes(2)
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
      (button) => button.textContent === "What blocks this release?"
    )
    if (suggestion === undefined) throw new Error("Expected an agent suggestion")
    await act(async () => suggestion.click())
    const form = host.querySelector<HTMLTextAreaElement>("textarea")?.closest("form")
    if (form === null || form === undefined) throw new Error("Expected the release agent form")
    await act(async () => form.requestSubmit())

    expect(host.textContent).toContain(title)
  })
})
