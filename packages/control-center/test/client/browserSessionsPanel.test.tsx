// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { IssueBrowserPairingCodeResponse, PairingCode, SessionSummary } from "../../src/api/session.js"
import { BrowserSessionsPanel, sessionStatus } from "../../src/client/settings/BrowserSessionsPanel.js"
import type { BrowserSessionAdministrationTransport } from "../../src/client/settings/browserSessionTransport.js"
import { PersonId, SessionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let mountedRoot: Root | undefined

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-08-07T11:00:00.000Z"))
})

const workspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000401")
const personId = Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000402")
const sessionTimestamps = {
  createdAt: "2026-08-07T10:00:00.000Z",
  lastSeenAt: "2026-08-07T10:05:00.000Z",
  idleExpiresAt: "2026-08-09T22:05:00.000Z",
  absoluteExpiresAt: "2026-09-06T10:00:00.000Z",
  revokedAt: null
}
const currentSession = Schema.decodeSync(SessionSummary)({
  sessionId: Schema.decodeSync(SessionId)("01890f6f-6d6a-7cc0-98d2-000000000403"),
  workspaceId,
  actor: { _tag: "human", personId },
  permission: "workspace-owner",
  ...sessionTimestamps
})
const secondSession = Schema.decodeSync(SessionSummary)({
  sessionId: Schema.decodeSync(SessionId)("01890f6f-6d6a-7cc0-98d2-000000000404"),
  workspaceId,
  actor: { _tag: "human", personId },
  permission: "workspace-approver",
  ...sessionTimestamps
})
const issued = Schema.decodeSync(IssueBrowserPairingCodeResponse)({
  pairingCode: PairingCode.make("ab".repeat(32)),
  expiresAt: "2026-08-07T10:15:00.000Z"
})

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  document.body.replaceChildren()
  vi.useRealTimers()
})

const mount = async (element: ReactElement): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  mountedRoot = createRoot(host)
  await act(async () => mountedRoot?.render(element))
  return host
}

describe("browser sessions panel", () => {
  it("gives revocation precedence and distinguishes expired sessions from active ones", () => {
    const activeNow = Schema.decodeSync(UtcTimestamp)("2026-08-07T11:00:00.000Z")
    const expiredNow = Schema.decodeSync(UtcTimestamp)("2026-08-10T11:00:00.000Z")
    expect(sessionStatus(secondSession, activeNow)).toContain("Active")
    expect(sessionStatus(secondSession, expiredNow)).toContain("Expired")
    expect(sessionStatus({ ...secondSession, revokedAt: secondSession.lastSeenAt }, expiredNow)).toContain("Revoked")
  })

  it("adds another browser and revokes only the selected independent session", async () => {
    const issuePairingCode = vi.fn<BrowserSessionAdministrationTransport["issuePairingCode"]>(() =>
      Promise.resolve(issued)
    )
    const revoke = vi.fn<BrowserSessionAdministrationTransport["revoke"]>(() => Promise.resolve())
    const transport: BrowserSessionAdministrationTransport = {
      issuePairingCode,
      list: () => Promise.resolve([currentSession, secondSession]),
      revoke
    }
    const host = await mount(
      <BrowserSessionsPanel
        canManage
        currentSession={currentSession}
        onSessionExpired={() => undefined}
        sessionKey={currentSession.sessionId}
        transport={transport}
      />
    )

    await vi.waitFor(() => expect(host.textContent).toContain("This browser"))
    expect(host.textContent).toContain("Workspace approver")

    const addBrowser = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Add browser"
    )
    if (addBrowser === undefined) throw new Error("expected add browser button")
    await act(async () => addBrowser.click())

    await vi.waitFor(() => expect(host.textContent).toContain(issued.pairingCode))
    expect(issuePairingCode).toHaveBeenCalledWith("workspace-owner", expect.any(AbortSignal))

    const revokeButton = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Revoke"
    )
    if (revokeButton === undefined) throw new Error("expected revoke button")
    await act(async () => revokeButton.click())

    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith(secondSession.sessionId, expect.any(AbortSignal)))
  })

  it("keeps pairing and revocation controls owner-only", async () => {
    const transport: BrowserSessionAdministrationTransport = {
      issuePairingCode: () => Promise.reject(new Error("unexpected pairing")),
      list: () => Promise.resolve([secondSession]),
      revoke: () => Promise.reject(new Error("unexpected revocation"))
    }
    const host = await mount(
      <BrowserSessionsPanel
        canManage={false}
        currentSession={secondSession}
        onSessionExpired={() => undefined}
        sessionKey={secondSession.sessionId}
        transport={transport}
      />
    )

    await vi.waitFor(() => expect(host.textContent).toContain("A workspace owner can add or revoke browsers."))
    expect(host.textContent).not.toContain("Add browser")
    expect(host.textContent).not.toContain("Revoke")
  })
})
