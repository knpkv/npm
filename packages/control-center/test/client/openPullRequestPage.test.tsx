// @vitest-environment happy-dom

import * as Domain from "@knpkv/codecommit-core/Domain.js"
import * as Schema from "effect/Schema"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CsrfToken, SessionSummary } from "../../src/api/session.js"
import { BrowserSessionProvider, useBrowserSession } from "../../src/client/BrowserSession.js"
import { OpenPullRequestPage } from "../../src/client/openPullRequest/OpenPullRequestPage.js"
import {
  browserOpenPullRequestTransport,
  type OpenPullRequestCandidate,
  type OpenPullRequestResolution,
  type OpenPullRequestTransport
} from "../../src/client/openPullRequest/openPullRequest.js"
import { EntityId } from "../../src/domain/identifiers.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const session = Schema.decodeSync(SessionSummary)({
  absoluteExpiresAt: "2026-08-13T10:00:00.000Z",
  actor: { _tag: "human", personId: "01890f6f-6d6a-7cc0-98d2-000000000003" },
  createdAt: "2026-07-14T10:00:00.000Z",
  idleExpiresAt: "2026-07-14T22:00:00.000Z",
  lastSeenAt: "2026-07-14T10:01:00.000Z",
  permission: "workspace-owner",
  revokedAt: null,
  sessionId: "01890f6f-6d6a-7cc0-98d2-000000000004",
  workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000001"
})
const csrfToken = Schema.decodeSync(CsrfToken)("ab".repeat(32))
const pullRequestUrl =
  "https://eu-west-1.console.aws.amazon.com/codesuite/codecommit/repositories/payments/pull-requests/42?region=eu-west-1"

let mountedRoot: Root | undefined
let sessionControls: ReturnType<typeof useBrowserSession> | undefined

const SessionProbe = (): null => {
  sessionControls = useBrowserSession()
  return null
}

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  sessionControls = undefined
  sessionStorage.clear()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

const mountPage = async (
  transport: OpenPullRequestTransport,
  activeSession: SessionSummary = session,
  submit = true
) => {
  const host = document.createElement("div")
  document.body.append(host)
  mountedRoot = createRoot(host)
  const router = createMemoryRouter([{ path: "/open-pr", element: <OpenPullRequestPage transport={transport} /> }], {
    initialEntries: ["/open-pr"]
  })
  await act(async () =>
    mountedRoot?.render(
      <BrowserSessionProvider>
        <SessionProbe />
        <RouterProvider router={router} />
      </BrowserSessionProvider>
    )
  )
  if (sessionControls === undefined) throw new Error("browser session controls are unavailable")
  act(() => sessionControls?.establishSession(csrfToken, activeSession))
  if (!submit) return { host, router }
  const input = host.querySelector<HTMLInputElement>("input[type=url]")
  const form = host.querySelector("form")
  if (input === null || form === null) throw new Error("open pull request form is unavailable")
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    if (valueSetter === undefined) throw new Error("native input value setter is unavailable")
    valueSetter.call(input, pullRequestUrl)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  return { host, router }
}

describe("OpenPullRequestPage", () => {
  it("makes the cross-region CodeCommit boundary explicit", async () => {
    const { host } = await mountPage({ resolve: vi.fn() }, session, false)
    expect(host.textContent).toContain("Paste a CodeCommit PR URL from any AWS region")
    expect(host.querySelector<HTMLInputElement>("input[type=url]")?.placeholder).not.toContain("eu-west-1")
  })

  it("attaches the tab mutation proof through the browser transport", async () => {
    const requests: Array<{ readonly csrf: string | null; readonly method: string; readonly url: string }> = []
    sessionStorage.setItem("cc_csrf", csrfToken)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        requests.push({
          csrf: request.headers.get("x-csrf-token"),
          method: request.method,
          url: request.url
        })
        return new Response(JSON.stringify({ _tag: "not-found", indexTruncated: false }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      })
    )

    const resolution = await browserOpenPullRequestTransport.resolve(
      Schema.decodeSync(Domain.CodeCommitPullRequestUrl)(pullRequestUrl),
      new AbortController().signal
    )

    expect(resolution).toEqual({ _tag: "not-found", indexTruncated: false })
    expect(requests).toEqual([
      {
        csrf: csrfToken,
        method: "POST",
        url: "http://localhost:3000/api/v1/codecommit/pull-requests/resolve"
      }
    ])
  })

  it("lets an approver call the narrow workspace resolver", async () => {
    const resolution: OpenPullRequestResolution = { _tag: "not-found", indexTruncated: false }
    const resolve = vi.fn(() => Promise.resolve(resolution))
    const approver = SessionSummary.make({ ...session, permission: "workspace-approver" })
    const { host, router } = await mountPage({ resolve }, approver)

    await vi.waitFor(() => expect(host.textContent).toContain("PR not found"))
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(router.state.location.search).toBe("")
  })

  it("does not offer the resolver when mutation-proof storage is unavailable", async () => {
    const resolve = vi.fn(() =>
      Promise.resolve<OpenPullRequestResolution>({ _tag: "not-found", indexTruncated: false })
    )
    const storageWrite = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable")
    })

    const { host } = await mountPage({ resolve }, session, false)

    expect(sessionControls?.state).toMatchObject({ _tag: "storage-unavailable", session })
    expect(host.textContent).toContain("Browser storage required")
    expect(host.querySelector("form")).toBeNull()
    expect(resolve).not.toHaveBeenCalled()
    storageWrite.mockRestore()
  })

  it("retries an unchanged URL after a transient lookup failure", async () => {
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue({ _tag: "not-found", indexTruncated: false })
    const { host } = await mountPage({ resolve })
    await vi.waitFor(() => expect(host.textContent).toContain("Lookup failed"))

    const form = host.querySelector("form")
    if (form === null) throw new Error("open pull request form is unavailable")
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))

    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    expect(host.textContent).toContain("PR not found")
  })

  it("invalidates an expired browser session", async () => {
    const resolve = vi.fn(() => Promise.reject({ _tag: "UnauthorizedApiError" }))
    const { host } = await mountPage({ resolve })

    await vi.waitFor(() => expect(host.textContent).toContain("Browser session required"))
    expect(host.textContent).not.toContain("Lookup failed")
  })

  it("renders browser-safe account labels for ambiguous matches", async () => {
    const candidates: ReadonlyArray<OpenPullRequestCandidate> = [
      {
        entityId: EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000071"),
        accountLabel: "Production · AWS 123456789012",
        title: "Protect retries"
      },
      {
        entityId: EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000072"),
        accountLabel: "Staging · AWS 210987654321",
        title: "Protect retries"
      }
    ]
    const resolution: OpenPullRequestResolution = { _tag: "ambiguous", candidates }
    const { host } = await mountPage({ resolve: vi.fn(() => Promise.resolve(resolution)) })

    await vi.waitFor(() => expect(host.textContent).toContain("Production · AWS 123456789012"))
    expect(host.textContent).toContain("Staging · AWS 210987654321")
    expect(host.textContent).not.toContain("connection-a")
  })

  it("clears stale candidates without writing the provider locator to history", async () => {
    const candidates: ReadonlyArray<OpenPullRequestCandidate> = [
      {
        entityId: EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000071"),
        accountLabel: "Production · AWS 123456789012",
        title: "Protect retries"
      }
    ]
    const resolve = vi.fn(() =>
      Promise.resolve<OpenPullRequestResolution>({
        _tag: "ambiguous",
        candidates
      })
    )
    const { host, router } = await mountPage({ resolve })
    await vi.waitFor(() => expect(host.textContent).toContain("Production · AWS 123456789012"))

    const input = host.querySelector<HTMLInputElement>("input[type=url]")
    const form = host.querySelector("form")
    if (input === null || form === null) throw new Error("open pull request form is unavailable")
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
      if (valueSetter === undefined) throw new Error("native input value setter is unavailable")
      valueSetter.call(input, "")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    await vi.waitFor(() => expect(host.textContent).not.toContain("Production · AWS 123456789012"))
    expect(router.state.location.search).toBe("")
  })
})
