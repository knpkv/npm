// @vitest-environment happy-dom

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import type { RlyReleasePresentation } from "../../src/patterns/ReleasePresentation.js"
import { ReleasePreview } from "../../src/patterns/ReleasePreview.js"
import { RLY_DIALOG_VARIANTS } from "../../src/primitives/Dialog.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const release = {
  algorithm: "rly-relay-v1",
  approver: { id: "dev", name: "Dev Shah", role: "Production approver" },
  codename: "Copper Finch",
  facts: [
    { id: "commit", label: "Commit", value: "8fa21c7" },
    { id: "target", label: "Target", value: "production-eu-west-1" },
    { id: "changes", label: "Changes", value: "14 files" }
  ],
  freshness: "cached",
  freshnessDateTime: "2026-07-13T09:42:00Z",
  freshnessTime: "09:42 UTC",
  id: "release-240",
  owner: { id: "mara", name: "Mara Bell", role: "Release owner" },
  reason: "All required evidence is present and the production approver is assigned.",
  state: "ready",
  symbolIndices: [2, 7, 13],
  tone: "positive",
  verdict: "Ready to deploy",
  version: "v2.4.0"
} satisfies RlyReleasePresentation

const unassignedRelease = {
  algorithm: release.algorithm,
  codename: "Copper Finch Pending",
  facts: release.facts,
  freshness: release.freshness,
  freshnessDateTime: release.freshnessDateTime,
  freshnessTime: release.freshnessTime,
  id: "release-241",
  reason: "No readiness evaluation has been supplied for this release.",
  state: "unknown",
  symbolIndices: release.symbolIndices,
  tone: "neutral",
  verdict: "Readiness not evaluated",
  version: "v2.4.1"
} satisfies RlyReleasePresentation

interface MountedPreview {
  readonly host: HTMLDivElement
  readonly portal: HTMLDivElement
  readonly root: Root
}

const mounted: Array<MountedPreview> = []

const mount = async (element: ReactElement): Promise<MountedPreview> => {
  const host = document.createElement("div")
  const portal = document.createElement("div")
  document.body.append(host, portal)
  const root = createRoot(host)
  const entry = { host, portal, root }
  mounted.push(entry)
  await act(async () => root.render(<PortalProvider container={portal}>{element}</PortalProvider>))
  return entry
}

const preview = (overrides: Partial<Parameters<typeof ReleasePreview>[0]> = {}): ReactElement => (
  <ReleasePreview
    agentEntry={<section aria-label="Agent entry">Ask the release agent</section>}
    collaborators={<section aria-label="Release collaborators">Four complete assignments</section>}
    evidence={<section aria-label="Evidence">Three checks attached</section>}
    onOpenChange={() => undefined}
    onOpenFullView={() => undefined}
    open
    primaryAction={<button type="button">Deploy release</button>}
    release={release}
    stages={<section aria-label="Stages">Build, verify, production</section>}
    workset={<section aria-label="Workset">Fourteen changed files</section>}
    {...overrides}
  />
)

afterEach(async () => {
  for (const entry of mounted.splice(0)) await act(async () => entry.root.unmount())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("ReleasePreview", () => {
  it("renders a named wide dossier with a focusable visible summary and exact slot order", async () => {
    const { portal } = await mount(preview())
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const summary = portal.querySelector<HTMLElement>("[data-rly-release-preview-summary]")
    if (dialog === null || summary === null) throw new Error("ReleasePreview dialog did not render")

    expect(dialog.className).toContain(RLY_DIALOG_VARIANTS.size.wide.className)
    expect(portal.querySelector("[data-rly-release-preview-presentation='dialog']")).not.toBeNull()
    expect(dialog.textContent).toContain("Release preview: v2.4.0 Copper Finch")
    expect(summary.tabIndex).toBe(-1)
    expect(document.activeElement).toBe(summary)
    expect(summary.textContent).toContain("v2.4.0")
    expect(summary.textContent).toContain("Copper Finch")
    expect(summary.textContent).toContain("Cached")
    expect(summary.textContent).toContain("Mara Bell")
    expect(summary.textContent).toContain("Dev Shah")
    expect(summary.textContent).toContain("Ready to deploy")
    expect(summary.textContent).toContain(release.reason)
    expect(summary.querySelectorAll("dl > div")).toHaveLength(3)
    expect(summary.querySelector('[data-rly-release-relay-size="hero"]')).not.toBeNull()
    expect(
      [...portal.querySelectorAll("[data-rly-release-preview-slot]")].map((slot) =>
        slot.getAttribute("data-rly-release-preview-slot")
      )
    ).toEqual(["collaborators", "primary-action", "stages", "workset", "evidence", "agent-entry"])
    expect(dialog.textContent).toContain("Four complete assignments")
    expect(dialog.textContent).toContain("Deploy release")
    expect(dialog.textContent).toContain("Build, verify, production")
    expect(dialog.textContent).toContain("Fourteen changed files")
    expect(dialog.textContent).toContain("Three checks attached")
    expect(dialog.textContent).toContain("Ask the release agent")
    expect(dialog.textContent).toContain("Close preview")
    const scrollRegion = dialog.querySelector("[data-rly-release-preview-scroll='dialog']")
    const footer = dialog.querySelector("[data-rly-release-preview-footer='dialog']")
    expect(scrollRegion).not.toBeNull()
    expect(footer).not.toBeNull()
    expect(scrollRegion?.parentElement).toBe(footer?.parentElement)
    expect(scrollRegion?.contains(footer)).toBe(false)
    expect(footer?.textContent).toContain("Open full view")
  })

  it("renders the caller-selected sheet with the same dossier order and explicit unassigned owner", async () => {
    const onOpenChange = vi.fn()
    const { portal } = await mount(preview({ onOpenChange, presentation: "sheet", release: unassignedRelease }))
    const sheet = portal.querySelector<HTMLElement>("[data-rly-sheet-side='end']")
    const summary = portal.querySelector<HTMLElement>("[data-rly-release-preview-summary]")
    const overlay = portal.querySelector<HTMLElement>("[data-rly-sheet-overlay]")
    if (sheet === null || summary === null || overlay === null) {
      throw new Error("ReleasePreview sheet did not render")
    }

    expect(portal.querySelector("[data-rly-dialog-overlay]")).toBeNull()
    expect(sheet.getAttribute("role")).toBe("dialog")
    expect(sheet.textContent).toContain("Release preview: v2.4.1 Copper Finch Pending")
    expect(sheet.textContent).toContain("Readiness not evaluated")
    expect(sheet.textContent).toContain("Unassigned")
    expect(sheet.querySelector("[data-rly-release-owner='unassigned']")).not.toBeNull()
    expect(sheet.querySelector("[data-rly-release-approver='unassigned']")).not.toBeNull()
    expect(sheet.querySelector("[data-rly-release-state='unknown']")).not.toBeNull()
    expect(sheet.querySelector("[data-rly-release-preview-presentation='sheet']")).not.toBeNull()
    expect(document.activeElement).toBe(summary)
    const scrollRegion = sheet.querySelector("[data-rly-release-preview-scroll='sheet']")
    const footer = sheet.querySelector("[data-rly-release-preview-footer='sheet']")
    expect(scrollRegion).not.toBeNull()
    expect(footer).not.toBeNull()
    expect(scrollRegion?.parentElement).toBe(footer?.parentElement)
    expect(scrollRegion?.contains(footer)).toBe(false)
    expect(
      [...sheet.querySelectorAll("[data-rly-release-preview-slot]")].map((slot) =>
        slot.getAttribute("data-rly-release-preview-slot")
      )
    ).toEqual(["collaborators", "primary-action", "stages", "workset", "evidence", "agent-entry"])

    await act(async () =>
      overlay.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("assigns the same three caller-owned shared geometry parts as ReleaseRow", async () => {
    const { portal } = await mount(
      preview({
        transitionNames: {
          relay: "release-a-relay",
          verdict: "release-a-verdict",
          version: "release-a-version"
        }
      })
    )
    const parts = [...portal.querySelectorAll<HTMLElement>("[data-rly-release-transition-part]")]
    expect(parts.map((part) => [part.dataset.rlyReleaseTransitionPart, part.dataset.rlyReleaseTransitionName])).toEqual(
      [
        ["relay", "release-a-relay"],
        ["version", "release-a-version"],
        ["verdict", "release-a-verdict"]
      ]
    )
  })

  it("calls the full-view callback exactly once for one activation", async () => {
    const onOpenFullView = vi.fn()
    const { portal } = await mount(preview({ onOpenFullView }))
    const button = [...portal.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      candidate.textContent?.includes("Open full view")
    )
    if (button === undefined) throw new Error("ReleasePreview full-view action did not render")
    await act(async () => button.click())
    expect(onOpenFullView).toHaveBeenCalledTimes(1)
  })

  it("forwards controlled dismissal requests without owning open state", async () => {
    const onOpenChange = vi.fn()
    const { portal } = await mount(preview({ onOpenChange }))
    const overlay = portal.querySelector<HTMLElement>("[data-rly-dialog-overlay]")
    if (overlay === null) throw new Error("ReleasePreview overlay did not render")
    await act(async () =>
      overlay.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(portal.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it("offers an explicit close action for the desktop dialog", async () => {
    const onOpenChange = vi.fn()
    const { portal } = await mount(preview({ onOpenChange }))
    const close = [...portal.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === "Close preview"
    )
    if (close === undefined) throw new Error("ReleasePreview explicit close action did not render")
    await act(async () => close.click())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("validates the shared release projection and full-view label", () => {
    expect(() => renderToStaticMarkup(preview({ release: { ...release, reason: " " } }))).toThrow(
      "Release presentation reason"
    )
    expect(() => renderToStaticMarkup(preview({ openFullViewLabel: " " }))).toThrow("ReleasePreview openFullViewLabel")
  })

  it("keeps the complete collaborators slot optional for existing callers", () => {
    const markup = renderToStaticMarkup(preview({ collaborators: undefined }))
    expect(markup).not.toContain('data-rly-release-preview-slot="collaborators"')
  })
})
