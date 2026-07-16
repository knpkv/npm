// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { CsrfToken, SessionSummary, type SessionSummary as SessionSummaryType } from "../../src/api/session.js"
import { BrowserSessionProvider, useBrowserSession } from "../../src/client/BrowserSession.js"

const makeSession = (sessionId: string): SessionSummaryType =>
  Schema.decodeSync(SessionSummary)({
    absoluteExpiresAt: "2026-08-13T10:00:00.000Z",
    actor: { _tag: "human", personId: "01890f6f-6d6a-7cc0-98d2-000000000003" },
    createdAt: "2026-07-14T10:00:00.000Z",
    idleExpiresAt: "2026-07-14T22:00:00.000Z",
    lastSeenAt: "2026-07-14T10:01:00.000Z",
    permission: "workspace-owner",
    revokedAt: null,
    sessionId,
    workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000001"
  })

let browserSession: ReturnType<typeof useBrowserSession> | undefined
let container: HTMLDivElement
let root: Root

const SessionProbe = (): ReactElement => {
  browserSession = useBrowserSession()
  return <output>{browserSession.state._tag}</output>
}

const sessionControls = (): ReturnType<typeof useBrowserSession> => {
  if (browserSession === undefined) throw new Error("browser session test provider is not mounted")
  return browserSession
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() =>
    root.render(
      <BrowserSessionProvider>
        <SessionProbe />
      </BrowserSessionProvider>
    )
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  browserSession = undefined
  sessionStorage.clear()
})

describe("BrowserSessionProvider", () => {
  it("does not let a late unauthorized response for session A invalidate replacement session B", () => {
    const sessionA = makeSession("01890f6f-6d6a-7cc0-98d2-000000000004")
    const sessionB = makeSession("01890f6f-6d6a-7cc0-98d2-000000000005")
    const csrfA = Schema.decodeSync(CsrfToken)("ab".repeat(32))
    const csrfB = Schema.decodeSync(CsrfToken)("cd".repeat(32))

    act(() => sessionControls().establishSession(csrfA, sessionA))
    const invalidateRejectedSessionA = sessionControls().invalidateSession
    act(() => sessionControls().establishSession(csrfB, sessionB))
    act(() => invalidateRejectedSessionA(sessionA.sessionId))

    expect(sessionControls().state).toEqual({ _tag: "authenticated", session: sessionB })
    expect(container.textContent).toBe("authenticated")
    expect(sessionStorage.getItem("cc_csrf")).toBe(csrfB)
    expect(sessionStorage.getItem("cc_session_id")).toBe(sessionB.sessionId)
  })

  it("removes the thread namespace when the current session is invalidated", () => {
    const activeSession = makeSession("01890f6f-6d6a-7cc0-98d2-000000000004")
    const csrf = Schema.decodeSync(CsrfToken)("ab".repeat(32))

    act(() => sessionControls().establishSession(csrf, activeSession))
    act(() => sessionControls().invalidateSession(activeSession.sessionId))

    expect(sessionStorage.getItem("cc_csrf")).toBeNull()
    expect(sessionStorage.getItem("cc_session_id")).toBeNull()
    expect(sessionControls().state).toEqual({ _tag: "anonymous" })
  })
})
