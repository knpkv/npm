// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { TodayView, type TodayReadState } from "../src/today-view.js"
import type { NeedsYouItem } from "../src/modules.js"

const item: NeedsYouItem = {
  key: "fleet:alpha:job:1",
  provider: "fleet",
  destination: { _tag: "FleetApproval", module: "fleet", host: "ALPHA", jobId: "job:1" },
  kind: "nix.apply",
  actor: "operator",
  createdAt: 1_000,
  expiresAt: 181_000
}
const render = (state: TodayReadState, now = 1_000) => {
  const host = document.createElement("div")
  host.innerHTML = renderToStaticMarkup(
    <TodayView state={state} now={now} agents={<p>Existing agents</p>} history={<p>Existing history</p>} />
  )
  return host
}
const ready = (items: ReadonlyArray<NeedsYouItem>): TodayReadState => ({
  reading: { result: { _tag: "Complete", items, contributions: [] }, checkedAt: 1_000 },
  failed: false
})

describe("Today view", () => {
  it("opens the exact approval with original host case and an opaque job identity", () => {
    const host = render(ready([item]))
    const link = host.querySelector<HTMLAnchorElement>(".today-request")
    expect(link?.getAttribute("href")).toBe("?approvalHost=ALPHA&approvalJob=job%3A1#fleet/approvals")
    expect(link?.textContent).toContain("Apply Nix configuration")
    expect(link?.textContent).toContain("ALPHA")
    expect(link?.textContent).toContain("3m left")
    expect(link?.querySelector("button")).toBeNull()
    expect(host.querySelector<HTMLAnchorElement>('[href="?#fleet/usage"]')?.textContent).toContain("Check local limits")
    expect(host.textContent).toContain("Existing agents")
    expect(host.textContent).toContain("Existing history")
  })

  it("claims clear only for a complete fresh Fleet reading", () => {
    const host = render(ready([]))
    expect(host.querySelector("h1")?.textContent).toBe("You're clear.")
    expect(host.textContent).toContain("No Fleet approvals are waiting")
    expect(host.textContent).not.toContain("Code")
    expect(host.textContent).not.toContain("Stacks")
    expect(host.querySelectorAll(".connect-creature")).toHaveLength(1)
    expect(host.querySelector("#today-needs-you-heading")).toBeNull()
    expect(host.querySelector("#today-clear-heading")?.textContent).toBe("A quiet day for your fleet")
    expect(host.querySelector(".today-empty")?.textContent).toMatch(/Checked \d{2}:\d{2}/)
    const failed = render({ ...ready([]), failed: true })
    expect(failed.querySelector("h1")?.textContent).toBe("Previous reading: 0 approvals.")
    expect(failed.textContent).toMatch(/Previous reading \d{2}:\d{2}/)
  })

  it("keeps source failures visible even when no approvals were read", () => {
    const host = render({
      reading: {
        checkedAt: 1_000,
        result: {
          _tag: "Partial",
          items: [],
          sources: [
            { provider: "fleet", issue: { state: "hosts", hosts: [{ host: "ALPHA", reason: "offline" }] } },
            { provider: "fleet", issue: { state: "truncated" } }
          ],
          contributions: []
        }
      },
      failed: false
    })
    expect(host.querySelector("h1")?.textContent).toBe("Discovery is incomplete.")
    expect(host.textContent).toContain("ALPHA is offline")
    expect(host.textContent).toContain("More Fleet approvals may be waiting")
    expect(host.textContent).not.toContain("You're clear")
  })

  it("counts waiting requests separately and lists expired requests after them", () => {
    const expired = { ...item, key: "fleet:alpha:expired", expiresAt: 1_000 }
    const host = render(ready([expired, item]))
    expect(host.querySelector("h1")?.textContent).toBe("1 thing needs you. 1 expired.")
    const rows = host.querySelectorAll(".today-request")
    expect(rows).toHaveLength(2)
    expect(rows[0]?.getAttribute("data-expired")).toBe("false")
    expect(rows[1]?.textContent).toContain("Expired")
  })

  it("keeps a previous list visibly old on read failure and distinguishes expired requests", () => {
    const host = render({ ...ready([item]), failed: true }, 182_000)
    expect(host.textContent).toContain("Couldn't refresh")
    expect(host.textContent).toContain("Previous reading")
    expect(host.querySelector(".today-request")?.textContent).toContain("Expired")
    expect(host.textContent).not.toContain("left")
  })

  it("keeps a partial old count qualified and singular", () => {
    const host = render({
      reading: {
        checkedAt: 1_000,
        result: {
          _tag: "Partial",
          items: [item],
          sources: [{ provider: "fleet", issue: { state: "truncated" } }],
          contributions: []
        }
      },
      failed: true
    })
    expect(host.querySelector("h1")?.textContent).toBe("Previous reading: at least 1 approval.")
  })

  it("does not present loading or a failed initial read as an empty result", () => {
    expect(render({ reading: null, failed: false }).querySelector("h1")?.textContent).toBe("Checking your fleet.")
    const host = render({ reading: null, failed: true })
    expect(host.querySelector("h1")?.textContent).toBe("Couldn't read your fleet.")
    expect(host.textContent).not.toContain("You're clear")
  })
})
