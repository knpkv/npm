// @vitest-environment happy-dom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LimitsView, LimitWindowView } from "../src/limits-model.js"
import { LimitsChips, LimitsPanel, limitsPanelHeadingId } from "../src/limits-view.js"
import { FleetShell } from "../src/shell-view.js"

const roots: Array<Root> = []

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
  window.history.replaceState(null, "", "/")
})

const render = async (element: React.ReactNode): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(element))
  return host
}

const limitWindow = (overrides: Partial<LimitWindowView>): LimitWindowView => ({
  key: "weekly",
  name: "Weekly",
  tone: "ok",
  value: 47,
  stale: false,
  projected: null,
  reserveMark: 85,
  usedText: "47% used",
  detailText: "resets in 3d 4h",
  paceText: "lasts until reset",
  sourceText: "read on SER8, 2m ago",
  ...overrides
})

const unknownWeekly = limitWindow({
  key: "weekly",
  tone: "unknown",
  value: null,
  usedText: "Unknown",
  detailText: "No reading for 6h 0m",
  paceText: null,
  sourceText: null
})

const view: LimitsView = {
  accounts: [
    {
      key: "claude:",
      provider: "claude",
      name: "Claude",
      account: "andrey@example.com",
      windows: [limitWindow({ key: "five_hour", name: "5-hour", value: 19 }), limitWindow({})],
      headline: limitWindow({})
    },
    { key: "codex:", provider: "codex", name: "Codex", account: null, windows: [unknownWeekly], headline: unknownWeekly }
  ],
  notes: ["Limits are off on MBP"]
}

describe("LimitsChips", () => {
  it("shows each provider's headline window and opens the panel", async () => {
    const onOpen = vi.fn()
    const host = await render(<LimitsChips onOpen={onOpen} view={view} />)
    const chips = [...host.querySelectorAll("a.limits-chip")]
    expect(chips.map((chip) => chip.textContent)).toEqual(["Claude 47%weekly", "Codex unknownweekly"])
    expect(chips[0]?.getAttribute("href")).toBe(`#${limitsPanelHeadingId}`)
    await act(async () => host.querySelector<HTMLAnchorElement>("a.limits-chip")?.click())
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it("renders nothing when no account has a window", async () => {
    const host = await render(<LimitsChips view={{ accounts: [], notes: ["Limits are off on SER8"] }} />)
    expect(host.querySelector(".limits-chips")).toBeNull()
  })
})

describe("LimitsPanel", () => {
  it("gives an unknown window its reason in place of a number", async () => {
    const host = await render(<LimitsPanel view={view} />)
    const codex = host.querySelector('[aria-label="Codex"]')
    expect(codex?.textContent).toContain("No reading for 6h 0m")
    expect(codex?.textContent).toContain("Unknown")
    expect(codex?.textContent).not.toMatch(/\d+%/)
    // LimitTrack draws its no-reading hatch: no fill part at all.
    expect(codex?.querySelector('[data-part="fill"]')).toBeNull()
  })

  it("names the account, the reset, the pace and the host each window was read on", async () => {
    const host = await render(<LimitsPanel view={view} />)
    const claude = host.querySelector('[aria-label="Claude, andrey@example.com"]')
    expect(claude?.textContent).toContain("47% used")
    expect(claude?.textContent).toContain("resets in 3d 4h; lasts until reset; read on SER8, 2m ago")
    expect(host.textContent).toContain("Limits are off on MBP")
  })

  it("says it is reading before the first load, and keeps the last view under a failed one", async () => {
    expect((await render(<LimitsPanel view={null} />)).textContent).toContain("Reading limits")
    const failed = await render(<LimitsPanel problem="Couldn't load limits. Trying again every minute." view={view} />)
    expect(failed.textContent).toContain("Couldn't load limits")
    expect(failed.textContent).toContain("47% used")
  })
})

describe("FleetShell limits", () => {
  it("opens the Approvals tab from a chip on another tab", async () => {
    window.history.replaceState(null, "", "/?tab=connect")
    const host = await render(
      <FleetShell
        approvals={<LimitsPanel view={view} />}
        connect={<section>Terminal</section>}
        hostCount={2}
        limits={(open) => <LimitsChips onOpen={open} view={view} />}
        work={<section>Work board</section>}
      />
    )
    const selected = () => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent
    expect(selected()).toBe("Connect")
    await act(async () => host.querySelector<HTMLAnchorElement>("a.limits-chip")?.click())
    expect(selected()).toBe("Approvals")
  })
})
