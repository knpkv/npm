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
  it("shows one line of state labels and keeps the cards closed", async () => {
    const host = await render(<ConnectLimits problem={null} view={view} />)
    expect([...host.querySelectorAll(".connect-limits-line li")].map((item) => item.textContent)).toEqual([
      "Claude 86% 5-hour",
      "Codex unknown"
    ])
    const details = host.querySelector("details")
    expect(details?.open).toBe(false)
    expect(details?.querySelector("summary")?.textContent).toBe("Limits on each host")
  })

  it("gives each host's cards their own heading", async () => {
    const host = await render(<ConnectLimits problem={null} view={view} />)
    const headings = [...host.querySelectorAll("h2")]
    expect(headings.map((heading) => heading.textContent)).toEqual(["Limits on SER8", "Limits on PI"])
    expect(new Set(headings.map((heading) => heading.id)).size).toBe(2)
    expect(host.textContent).toContain("No reading from MBP (offline)")
  })

  it("shows nothing while limits are off, and says why when the first load failed", async () => {
    expect((await render(<ConnectLimits problem={null} view={{ ...view, off: true }} />)).textContent).toBe("")
    expect((await render(<ConnectLimits problem="Couldn't load limits." view={null} />)).textContent).toBe(
      "Couldn't load limits."
    )
  })
})
