/** The host dashboard page is hydrated, and polls only what its listener serves (QA-141). */
import { describe, expect, it } from "@effect/vitest"
import { dashboardPolls } from "../src/internal/dashboard-polls.js"
import { type ListenerMode, listenerServesWork } from "../src/internal/listener.js"

describe("host dashboard polls", () => {
  it("serves the Work snapshot only where the route exists", () => {
    expect(listenerServesWork("serve", true)).toBe(true)
    expect(listenerServesWork("work", true)).toBe(true)
    expect(listenerServesWork("local", false)).toBe(true)
    // A cross-host fleet's local dashboard has no Work route; nor do the other listeners.
    expect(listenerServesWork("local", true)).toBe(false)
    const others: ReadonlyArray<ListenerMode> = ["tailnet", "approval", "lan"]
    for (const mode of others) expect(listenerServesWork(mode, false)).toBe(false)
  })

  it("polls nothing a host dashboard does not serve, and everything on the hub", () => {
    expect(dashboardPolls({ chatEnabled: false, pushEnabled: false, workEnabled: false })).toEqual({
      chat: false,
      push: false,
      work: false
    })
    expect(dashboardPolls({ chatEnabled: true, pushEnabled: true, workEnabled: true })).toEqual({
      chat: true,
      push: true,
      work: true
    })
  })
})
