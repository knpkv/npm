// @vitest-environment happy-dom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import type { UsageTabView } from "../src/usage-model.js"
import { UsageTab, type UsageTabProps } from "../src/usage-view.js"

const roots: Array<Root> = []

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
})

const render = async (props: Partial<UsageTabProps> = {}): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () =>
    root.render(
      <UsageTab
        limits={{ problem: null, view: null }}
        onHubMachine={false}
        onRangeChange={() => undefined}
        range="7d"
        usage={{ loading: false, problem: null, view }}
        {...props}
      />
    )
  )
  return host
}

const day = 86_400_000
const view: UsageTabView = {
  periods: [
    { key: "2026-10-08", start: 0 },
    { key: "2026-10-09", start: day }
  ],
  range: { from: 0, to: 2 * day, bucket: "day" },
  preset: "7d",
  cells: [{ period: 1, id: "claude:claude-opus-5", value: 1_200 }],
  labels: new Map([["claude:claude-opus-5", "Claude claude-opus-5"]]),
  totalTokens: 1_200,
  hosts: [{ host: "SER8", range: { from: 0, to: 2 * day, bucket: "day" }, now: 2 * day, series: [] }],
  notes: ["PI is offline."]
}

describe("UsageTab", () => {
  it("names the token chart by model, never by booking, and lists its models", async () => {
    const host = await render()
    const chart = host.querySelector(".usage-chart svg")
    expect(chart?.getAttribute("aria-label")).toBe("Tokens per day, stacked by model")
    expect(chart?.getAttribute("aria-label")).not.toMatch(/booking/iu)
    expect([...host.querySelectorAll(".usage-legend li")].map((item) => item.textContent)).toEqual([
      "Claude claude-opus-5"
    ])
    expect(host.textContent).toContain("1.2K tokens in the last 7 days")
    expect(host.textContent).toContain("PI is offline.")
  })

  // A switch keeps the old range's reads on screen until the new ones land: they keep their own label.
  it("labels the totals with the range the shown reads answer for, and says when a switch is loading", async () => {
    const switching = await render({ range: "30d", usage: { loading: true, problem: null, view } })
    expect(switching.textContent).toContain("Updating to the last 30 days… showing the last 7 days")
    expect(switching.textContent).not.toContain("in the last 30 days")
    expect(switching.querySelector("[aria-busy='true']")).not.toBeNull()
    const settled = await render({ range: "30d", usage: { loading: false, problem: null, view } })
    expect(settled.textContent).toContain("1.2K tokens in the last 7 days")
  })

  it("says no host has usage when the fleet answered without any, rather than loading forever", async () => {
    const none = await render({
      usage: {
        loading: false,
        problem: null,
        view: { ...view, range: null, preset: null, cells: [], totalTokens: 0, hosts: [] }
      }
    })
    expect(none.textContent).toContain("No host has usage to show.")
    expect(none.querySelector("[aria-label='Loading usage']")).toBeNull()
    expect([...none.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual(["Tokens"])
  })

  it("offers 24h, 7d and 30d on every size, and reports the chosen one", async () => {
    const chosen: Array<string> = []
    const host = await render({ onRangeChange: (range) => chosen.push(range) })
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("[aria-label='Range'] button")]
    expect(buttons.map((button) => button.textContent)).toEqual(["24h", "7d", "30d"])
    await act(async () => buttons[2]?.click())
    expect(chosen).toEqual(["30d"])
  })

  it("links to agent-usage's own page only on the hub's machine", async () => {
    expect((await render()).querySelector(".usage-tab-full")).toBeNull()
    const local = await render({ onHubMachine: true })
    expect(local.querySelector(".usage-tab-full")?.getAttribute("href")).toBe("http://127.0.0.1:3112/")
  })

  it("says why there is nothing to show, rather than drawing empty charts", async () => {
    const failed = await render({ usage: { loading: false, problem: "Couldn't load usage.", view: null } })
    expect(failed.textContent).toContain("Couldn't load usage.")
    expect(failed.querySelector(".usage-chart")).toBeNull()
    // No read yet: no history panel holding only its heading.
    expect([...failed.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual(["Tokens"])
    const quiet = await render({
      usage: { loading: false, problem: null, view: { ...view, cells: [], totalTokens: 0 } }
    })
    expect(quiet.textContent).toContain("No tokens in this range.")
  })
})
