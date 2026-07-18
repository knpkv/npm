// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { type ReactElement, act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AtlassianOAuthGrantExchangeResponse } from "../../src/api/plugins.js"
import { CsrfToken, SessionSummary } from "../../src/api/session.js"
import { BrowserSessionProvider, useBrowserSession } from "../../src/client/BrowserSession.js"
import { AtlassianOAuthCallbackPage } from "../../src/client/services/AtlassianOAuthCallbackPage.js"
import type { ConnectionTestTransport } from "../../src/client/services/connectionTestTransport.js"
import { PersonId, WorkspaceId } from "../../src/domain/identifiers.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const grantId = "a".repeat(43)
const exchangeResponse = Schema.decodeSync(AtlassianOAuthGrantExchangeResponse)({
  grantId,
  accountName: "Avery Bell",
  accountEmail: "avery@example.com",
  sites: [{ cloudId: "cloud-1", name: "Acme Europe", siteUrl: "https://acme.atlassian.net/" }]
})
const session = Schema.decodeSync(SessionSummary)({
  sessionId: "01890f6f-6d6a-7cc0-98d2-000000000143",
  workspaceId: Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000141"),
  actor: {
    _tag: "human",
    personId: Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000144")
  },
  permission: "workspace-owner",
  createdAt: "2026-07-14T10:00:00.000Z",
  lastSeenAt: "2026-07-14T10:01:00.000Z",
  idleExpiresAt: "2026-07-14T22:00:00.000Z",
  absoluteExpiresAt: "2026-08-13T10:00:00.000Z",
  revokedAt: null
})
const csrfToken = Schema.decodeSync(CsrfToken)("ab".repeat(32))

let root: Root | undefined
let sessionControls: ReturnType<typeof useBrowserSession> | undefined
type CallbackTransport = Pick<ConnectionTestTransport, "completeAtlassianOAuthGrant" | "exchangeAtlassianOAuthGrant">

const Harness = ({ transport }: { readonly transport: CallbackTransport }): ReactElement => {
  sessionControls = useBrowserSession()
  return <AtlassianOAuthCallbackPage transport={transport} />
}

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
  sessionControls = undefined
  document.body.replaceChildren()
  sessionStorage.clear()
})

describe("AtlassianOAuthCallbackPage", () => {
  it("keeps exactly one grant exchange alive across StrictMode effect replay", async () => {
    let resolveExchange: ((value: AtlassianOAuthGrantExchangeResponse) => void) | undefined
    let exchangeSignal: AbortSignal | undefined
    const exchange = vi.fn<NonNullable<ConnectionTestTransport["exchangeAtlassianOAuthGrant"]>>(
      (_grantId, _code, signal) => {
        exchangeSignal = signal
        return new Promise<AtlassianOAuthGrantExchangeResponse>((resolve) => {
          resolveExchange = resolve
        })
      }
    )
    const transport: CallbackTransport = { exchangeAtlassianOAuthGrant: exchange }
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () => {
      root?.render(
        <StrictMode>
          <MemoryRouter initialEntries={[`/services/oauth/atlassian/callback?state=${grantId}&code=auth-code`]}>
            <BrowserSessionProvider>
              <Harness transport={transport} />
            </BrowserSessionProvider>
          </MemoryRouter>
        </StrictMode>
      )
    })
    await act(async () => sessionControls?.establishSession(csrfToken, session))

    expect(exchange).toHaveBeenCalledTimes(1)
    expect(exchangeSignal?.aborted).toBe(false)
    await act(async () => resolveExchange?.(exchangeResponse))
    expect(host.textContent).toContain("Choose your Atlassian site")
    expect(host.textContent).toContain("Acme Europe")

    await act(async () => root?.unmount())
    root = undefined
    await Promise.resolve()
    expect(exchangeSignal?.aborted).toBe(true)
  })
})
