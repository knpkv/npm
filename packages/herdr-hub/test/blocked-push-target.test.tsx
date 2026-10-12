// @vitest-environment happy-dom

import { RegistryProvider } from "@effect/atom-react"
import { makeConnectAtoms } from "@knpkv/herdr-connect/surface"
import type { ConnectAgent } from "@knpkv/herdr-connect/model"
import { Predicate } from "effect"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { BlockedConnectSurface } from "../src/blocked-connect-surface.js"
import type { BlockedPushPayload } from "../src/blocked-push-model.js"
import { blockedPushDeepLink } from "../src/blocked-push-pwa.js"

declare global {
  interface Window {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
}
window.IS_REACT_ACT_ENVIRONMENT = true
const roots: Array<Root> = []
const originalFetch = window.fetch
const originalUrl = window.location.href
const agent: ConnectAgent = {
  host: "HOST-A",
  id: "agent-one",
  name: "worker",
  kind: "codex",
  state: "blocked",
  work: "project",
  lastActivityAt: 0
}
let listedAgents: ReadonlyArray<ConnectAgent> = []
window.fetch = async (input) => {
  const url = Predicate.isString(input) ? input : "href" in input ? input.href : input.url
  const path = new URL(url, window.location.origin).pathname
  if (path === "/v1/connect/agents")
    return new Response(JSON.stringify({ agents: listedAgents, failures: [], nextCursor: null }))
  if (path === "/v1/push/stage-heartbeat") return new Response(JSON.stringify({ accepted: true }))
  return new Response("{}", { status: 404 })
}
afterAll(() => {
  window.fetch = originalFetch
})
afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
  window.localStorage.clear()
  window.history.replaceState(null, "", originalUrl)
})
const settle = async () => {
  await act(async () => {
    for (let index = 0; index < 24; index += 1) await Promise.resolve()
  })
}
const openNotificationTarget = async () => {
  const payload: BlockedPushPayload = {
    kind: "agent-blocked",
    host: agent.host,
    agentId: agent.id,
    agentName: agent.name,
    state: "blocked",
    firstLine: "worker is blocked",
    approvalJobId: null,
    eventId: "blocker-one"
  }
  const url = blockedPushDeepLink(`${window.location.origin}/`, payload)
  window.history.replaceState(null, "", url)
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () =>
    root.render(
      <RegistryProvider>
        <BlockedConnectSurface atoms={makeConnectAtoms()} />
      </RegistryProvider>
    )
  )
  await settle()
}

describe("blocked notification directory target", () => {
  it("opens the directory agent's stage using the push payload identity, ignoring the future post selector", async () => {
    listedAgents = [agent]
    await openNotificationTarget()
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("worker")
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("HOST-A")
    expect(window.location.search).toContain("event=blocker-one")
  })
  it("shows the existing unknown-target state and a usable directory when the agent is gone", async () => {
    listedAgents = []
    await openNotificationTarget()
    expect(document.querySelector("[role='dialog']")).toBeNull()
    expect(document.querySelector(".connect-preference-error")?.textContent).toContain("connect_target.unknown")
    expect(document.body.textContent).toContain("No agents running on any host.")
  })
})
