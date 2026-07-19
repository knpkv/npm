// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { type ReactElement, act, StrictMode, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useLocation } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  AtlassianOAuthGrantExchangeResponse,
  type AtlassianOAuthProviderIntent,
  DiscoveredAtlassianProfile
} from "../../src/api/plugins.js"
import { CsrfToken, SessionSummary } from "../../src/api/session.js"
import { BrowserSessionProvider, useBrowserSession } from "../../src/client/BrowserSession.js"
import { AtlassianOAuthCallbackPage } from "../../src/client/services/AtlassianOAuthCallbackPage.js"
import type { ConnectionTestTransport } from "../../src/client/services/connectionTestTransport.js"
import { PersonId, WorkspaceId } from "../../src/domain/identifiers.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const grantId = "a".repeat(43)
const oauthIntentKey = (state: string): string => `cc_atlassian_oauth_setup_intent:${state}`
const exchangeResponse = Schema.decodeSync(AtlassianOAuthGrantExchangeResponse)({
  grantId,
  accountName: "Avery Bell",
  accountEmail: "avery@example.com",
  sites: [
    { cloudId: "cloud-1", name: "Acme Europe", siteUrl: "https://acme.atlassian.net/" },
    { cloudId: "cloud-2", name: "Acme Labs", siteUrl: "https://labs.atlassian.net/" }
  ]
})
const completedProfile = Schema.decodeSync(DiscoveredAtlassianProfile)({
  profileId: "account-1@cloud-2",
  name: "Avery Bell @ labs.atlassian.net",
  siteUrl: "https://labs.atlassian.net/",
  cloudId: "cloud-2",
  accountName: "Avery Bell",
  accountEmail: "avery@example.com",
  status: "valid",
  providers: ["jira", "confluence"]
})
const callbackReturnCases: ReadonlyArray<{
  readonly destination: string
  readonly label: string
  readonly providers: AtlassianOAuthProviderIntent
}> = [
  {
    destination: "/services?enable=confluence&atlassianProfile=account-1%40cloud-2&atlassianProvider=confluence",
    label: "Confluence-only",
    providers: ["confluence"]
  },
  {
    destination: "/services?enable=jira&atlassianProfile=account-1%40cloud-2&atlassianProvider=jira",
    label: "Jira-only",
    providers: ["jira"]
  },
  {
    destination:
      "/services?enable=jira&atlassianProfile=account-1%40cloud-2&atlassianProvider=jira&atlassianProvider=confluence",
    label: "combined Jira and Confluence",
    providers: ["jira", "confluence"]
  }
]
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
let currentLocation = ""
type CallbackTransport = Pick<ConnectionTestTransport, "completeAtlassianOAuthGrant" | "exchangeAtlassianOAuthGrant">

const Harness = ({ transport }: { readonly transport: CallbackTransport }): ReactElement => {
  sessionControls = useBrowserSession()
  const location = useLocation()
  currentLocation = `${location.pathname}${location.search}`
  return <AtlassianOAuthCallbackPage transport={transport} />
}

const DismissibleHarness = ({ transport }: { readonly transport: CallbackTransport }): ReactElement => {
  sessionControls = useBrowserSession()
  const location = useLocation()
  const [isCallbackMounted, setIsCallbackMounted] = useState(true)
  currentLocation = `${location.pathname}${location.search}`
  return (
    <>
      <button onClick={() => setIsCallbackMounted(false)} type="button">
        Leave callback
      </button>
      {isCallbackMounted ? <AtlassianOAuthCallbackPage transport={transport} /> : null}
    </>
  )
}

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
  sessionControls = undefined
  currentLocation = ""
  document.body.replaceChildren()
  sessionStorage.clear()
})

describe("AtlassianOAuthCallbackPage", () => {
  it("removes the OAuth code from the callback location while exchange remains pending", async () => {
    const exchange = vi.fn<NonNullable<ConnectionTestTransport["exchangeAtlassianOAuthGrant"]>>(
      () => new Promise<AtlassianOAuthGrantExchangeResponse>(() => undefined)
    )
    const transport: CallbackTransport = { exchangeAtlassianOAuthGrant: exchange }
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/services/oauth/atlassian/callback?state=${grantId}&code=auth-code`]}>
          <BrowserSessionProvider>
            <Harness transport={transport} />
          </BrowserSessionProvider>
        </MemoryRouter>
      )
    })
    await act(async () => sessionControls?.establishSession(csrfToken, session))

    expect(exchange).toHaveBeenCalledOnce()
    expect(currentLocation).toBe("/services/oauth/atlassian/callback")
  })

  it.each([
    ["missing state", "/services/oauth/atlassian/callback?code=auth-code&continue=services"],
    ["invalid state", "/services/oauth/atlassian/callback?state=invalid&code=auth-code&continue=services"]
  ])("preserves the callback location when OAuth parameters have %s", async (_scenario, initialEntry) => {
    const exchange = vi.fn<NonNullable<ConnectionTestTransport["exchangeAtlassianOAuthGrant"]>>()
    const transport: CallbackTransport = { exchangeAtlassianOAuthGrant: exchange }
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[initialEntry]}>
          <BrowserSessionProvider>
            <Harness transport={transport} />
          </BrowserSessionProvider>
        </MemoryRouter>
      )
    })
    await act(async () => sessionControls?.establishSession(csrfToken, session))

    expect(exchange).not.toHaveBeenCalled()
    expect(currentLocation).toBe(initialEntry)
    expect(host.textContent).toContain("Atlassian sign-in did not finish")
  })

  it.each(callbackReturnCases)(
    "returns to the initiating $label setup independently of the completed profile scopes",
    async ({ destination, providers }) => {
      const complete = vi
        .fn<NonNullable<ConnectionTestTransport["completeAtlassianOAuthGrant"]>>()
        .mockResolvedValue(completedProfile)
      const transport: CallbackTransport = {
        completeAtlassianOAuthGrant: complete,
        exchangeAtlassianOAuthGrant: () => Promise.resolve(exchangeResponse)
      }
      const host = document.createElement("div")
      document.body.append(host)
      root = createRoot(host)
      sessionStorage.setItem(oauthIntentKey(grantId), JSON.stringify(providers))

      await act(async () => {
        root?.render(
          <MemoryRouter initialEntries={[`/services/oauth/atlassian/callback?state=${grantId}&code=auth-code`]}>
            <BrowserSessionProvider>
              <Harness transport={transport} />
            </BrowserSessionProvider>
          </MemoryRouter>
        )
      })
      await act(async () => sessionControls?.establishSession(csrfToken, session))
      const useSite = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
        textContent?.includes("Use this site")
      )
      await act(async () => useSite?.click())

      expect(complete).toHaveBeenCalledOnce()
      expect(currentLocation).toBe(destination)
      expect(sessionStorage.getItem(oauthIntentKey(grantId))).toBeNull()
    }
  )

  it("restores a Confluence-only setup after a failed callback", async () => {
    const transport: CallbackTransport = { exchangeAtlassianOAuthGrant: vi.fn() }
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    sessionStorage.setItem(oauthIntentKey(grantId), JSON.stringify(["confluence"]))

    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/services/oauth/atlassian/callback?state=${grantId}&error=access_denied`]}>
          <BrowserSessionProvider>
            <Harness transport={transport} />
          </BrowserSessionProvider>
        </MemoryRouter>
      )
    })
    await act(async () => sessionControls?.establishSession(csrfToken, session))
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Try again")
    )
    await act(async () => retry?.click())

    expect(currentLocation).toBe("/services?enable=confluence&atlassianProvider=confluence")
    expect(sessionStorage.getItem(oauthIntentKey(grantId))).toBeNull()
  })

  it.each([
    ["unknown", null],
    ["invalid", JSON.stringify(["jira", "jira"])],
    ["malformed", "not-json"]
  ])("returns safely to Services for %s callback intent", async (_scenario, storedIntent) => {
    const transport: CallbackTransport = { exchangeAtlassianOAuthGrant: vi.fn() }
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    if (storedIntent !== null) sessionStorage.setItem(oauthIntentKey(grantId), storedIntent)

    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/services/oauth/atlassian/callback?state=${grantId}&error=access_denied`]}>
          <BrowserSessionProvider>
            <Harness transport={transport} />
          </BrowserSessionProvider>
        </MemoryRouter>
      )
    })
    await act(async () => sessionControls?.establishSession(csrfToken, session))
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Try again")
    )
    await act(async () => retry?.click())

    expect(currentLocation).toBe("/services")
    expect(sessionStorage.getItem(oauthIntentKey(grantId))).toBeNull()
  })

  it("keeps exactly one grant exchange alive across StrictMode effect replay", async () => {
    let resolveExchange: ((value: AtlassianOAuthGrantExchangeResponse) => void) | undefined
    let rejectSave: ((reason: Error) => void) | undefined
    let exchangeSignal: AbortSignal | undefined
    let completeCalls = 0
    const exchange = vi.fn<NonNullable<ConnectionTestTransport["exchangeAtlassianOAuthGrant"]>>(
      (_grantId, _code, signal) => {
        exchangeSignal = signal
        return new Promise<AtlassianOAuthGrantExchangeResponse>((resolve) => {
          resolveExchange = resolve
        })
      }
    )
    const complete = vi.fn<NonNullable<ConnectionTestTransport["completeAtlassianOAuthGrant"]>>(() => {
      completeCalls += 1
      return completeCalls === 1
        ? new Promise<DiscoveredAtlassianProfile>((_resolve, reject) => {
            rejectSave = reject
          })
        : Promise.resolve(completedProfile)
    })
    const transport: CallbackTransport = {
      completeAtlassianOAuthGrant: complete,
      exchangeAtlassianOAuthGrant: exchange
    }
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
    const siteButtons = [...host.querySelectorAll<HTMLButtonElement>("button")].filter(({ textContent }) =>
      textContent?.includes("Use this site")
    )
    expect(siteButtons).toHaveLength(2)
    await act(async () => siteButtons[0]?.click())
    expect(siteButtons.every(({ disabled }) => disabled)).toBe(true)
    await act(async () => siteButtons[1]?.click())
    expect(complete).toHaveBeenCalledTimes(1)
    await act(async () => rejectSave?.(new Error("second store unavailable")))
    expect(siteButtons.every(({ disabled }) => !disabled)).toBe(true)
    await act(async () => siteButtons[1]?.click())
    expect(complete).toHaveBeenCalledTimes(2)

    await act(async () => root?.unmount())
    root = undefined
    await Promise.resolve()
    expect(exchangeSignal?.aborted).toBe(true)
  })

  it("does not navigate when an aborted save resolves after the callback unmounts", async () => {
    let resolveSave: ((value: DiscoveredAtlassianProfile) => void) | undefined
    let saveSignal: AbortSignal | undefined
    const transport: CallbackTransport = {
      exchangeAtlassianOAuthGrant: () => Promise.resolve(exchangeResponse),
      completeAtlassianOAuthGrant: (_grantId, _cloudId, signal) => {
        saveSignal = signal
        return new Promise((resolve) => {
          resolveSave = resolve
        })
      }
    }
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[`/services/oauth/atlassian/callback?state=${grantId}&code=auth-code`]}>
          <BrowserSessionProvider>
            <DismissibleHarness transport={transport} />
          </BrowserSessionProvider>
        </MemoryRouter>
      )
    })
    await act(async () => sessionControls?.establishSession(csrfToken, session))
    const useSite = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Use this site")
    )
    await act(async () => useSite?.click())
    const leave = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Leave callback")
    )
    await act(async () => leave?.click())
    await Promise.resolve()
    expect(saveSignal?.aborted).toBe(true)

    await act(async () => resolveSave?.(completedProfile))

    expect(currentLocation).toBe("/services/oauth/atlassian/callback")
  })
})
