// @vitest-environment happy-dom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import type { ConnectLimitsView } from "../src/limits-model.js"
import { ConnectLimits } from "../src/limits-view.js"

const roots: Array<Root> = []

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
})

const render = async (element: React.ReactNode): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(element))
  return host
}

const t = 1_000 * 3_600_000
const view: ConnectLimitsView = {
  line: [
    { agent: "claude", tone: "near", text: "Claude 86% 5-hour" },
    { agent: "codex", tone: "unknown", text: "Codex unknown" }
  ],
  hosts: [
    { host: "SER8", now: t, latest: [] },
    { host: "PI", now: t, latest: [] }
  ],
  notes: ["No reading from MBP (offline)"],
  off: false
}

describe("ConnectLimits", () => {
  it("shows one line of state labels and links to the Usage tab for each host's cards", async () => {
    const host = await render(<ConnectLimits problem={null} view={view} />)
    expect([...host.querySelectorAll(".connect-limits-line li")].map((item) => item.textContent)).toEqual([
      "Claude 86% 5-hour",
      "Codex unknown"
    ])
    const link = host.querySelector("a")
    expect(link?.getAttribute("href")).toBe("/?tab=usage")
    expect(link?.textContent).toBe("Limits and usage on each host")
    // The cards and notes moved to the Usage tab: Connect keeps only its line.
    expect(host.querySelector("details")).toBeNull()
    expect(host.querySelectorAll("h2")).toHaveLength(0)
    const single = await render(<ConnectLimits problem={null} view={{ ...view, hosts: [view.hosts[0]!] }} />)
    expect(single.querySelector("a")?.textContent).toBe("Limits and usage")
  })

  it("shows nothing while limits are off, and says why when the first load failed", async () => {
    expect((await render(<ConnectLimits problem={null} view={{ ...view, off: true }} />)).textContent).toBe("")
    expect((await render(<ConnectLimits problem="Couldn't load limits." view={null} />)).textContent).toBe(
      "Couldn't load limits."
    )
  })
})
