// @vitest-environment happy-dom
import { type Patch, parsePatch } from "@knpkv/rly/diff/patch"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it } from "vitest"
import { GuidePage } from "../src/guide/view.js"

/** Unwrap a patch these tests expect to be well formed. */
const parsed = (text: string): Patch => {
  const result = parsePatch(text)
  if (result._tag === "PatchInvalid") throw new Error(`unexpected invalid patch: ${result.reason}`)
  return result.patch
}

it("renders inline Markdown in review navigation and checklist notes without nesting links", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <GuidePage
          guide={{
            title: "Guide",
            intent: "Explain the boundary.",
            sections: [],
            unplacedFiles: [],
            review: { gitRef: "abc" }
          }}
          patch={parsed("")}
          findings={{
            checklist: [
              { item: "Security", verdict: "No", note: "Compare `verified.revision`; see [contract](#policy)." }
            ],
            issues: [
              {
                id: 1,
                severity: "P1",
                file: "release.ts",
                summary: "Check `requestedRevision` and **[approval](#policy)** <img src=x onerror=alert(1)>"
              }
            ]
          }}
        />
      )
    )
    const review = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) =>
      tab.textContent?.startsWith("Review")
    )
    if (review === undefined) throw new TypeError("Fixture has no Review tab")
    await act(async () => review.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })))
    const link = host.querySelector('.review-issues a[href="#issue-1"]')
    expect(link?.querySelector("code")?.textContent).toBe("requestedRevision")
    expect(link?.querySelector("strong")?.textContent).toBe("approval")
    expect(link?.querySelector("a")).toBeNull()
    expect(link?.textContent).not.toContain("`")
    expect(host.querySelector(".review-checklist code")?.textContent).toBe("verified.revision")
    expect(host.querySelector(".review-checklist a")?.getAttribute("href")).toBe("#policy")
    expect(host.querySelector("img")).toBeNull()
    expect(host.querySelector(".review-finding-title code")?.textContent).toBe("requestedRevision")
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it("retains a rendered diagram when diff mode and wrapping change", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <GuidePage
          guide={{
            title: "Guide",
            intent: "```mermaid\nflowchart LR\nA-->B\n```",
            sections: [],
            unplacedFiles: [],
            review: { gitRef: "abc" }
          }}
          patch={parsed("")}
          findings={{ checklist: [], issues: [] }}
        />
      )
    )
    const diagram = host.querySelector(".mermaid")
    if (diagram === null) throw new TypeError("Fixture has no Mermaid container")
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    diagram.replaceChildren(svg)
    const mode = host.querySelector("button")
    const wrap = host.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (mode === null || wrap === null) throw new TypeError("Fixture has no diff controls")
    expect(wrap.labels?.[0]?.textContent?.trim()).toBe("Wrap code")
    expect(wrap.closest(".review-checkbox")).not.toBeNull()
    expect(wrap.checked).toBe(true)
    await act(async () => mode.click())
    expect(mode.textContent).toBe("Split view")
    expect(diagram.firstChild).toBe(svg)
    const themeButtons = [...host.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Theme"] button')]
    expect(themeButtons.map((button) => button.textContent)).toEqual(["Light", "System", "Dark"])
    expect(
      themeButtons
        .filter((button) => button.getAttribute("aria-pressed") === "true")
        .map((button) => button.textContent)
    ).toEqual(["System"])
    for (const button of themeButtons) {
      await act(async () => button.click())
      expect(host.querySelector("[data-theme]")?.getAttribute("data-theme")).toBe(button.textContent?.toLowerCase())
      expect(themeButtons.filter((option) => option.getAttribute("aria-pressed") === "true")).toEqual([button])
      expect(diagram.firstChild).toBe(svg)
    }
    const reviewTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent === "Review"
    )
    const guideTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent === "Change guide"
    )
    if (reviewTab === undefined || guideTab === undefined) throw new TypeError("Fixture has no reading tabs")
    await act(async () => reviewTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })))
    expect(reviewTab.getAttribute("aria-selected")).toBe("true")
    expect(host.querySelector("#verdict")?.textContent).toContain("No review source supplied")
    await act(async () => guideTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })))
    expect(guideTab.getAttribute("aria-selected")).toBe("true")
    expect(host.querySelector(".mermaid")?.textContent).toContain("flowchart LR")
    await act(async () => wrap.click())
    expect(wrap.checked).toBe(false)
    await act(async () => wrap.labels?.[0]?.click())
    expect(wrap.checked).toBe(true)
    expect(diagram.firstChild).toBe(svg)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
