// @vitest-environment happy-dom

import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  confluenceEditorMarkdown,
  releasePublicationSucceeded,
  safeConfluenceEditorLinkHref,
  WorkspaceConfluenceVisualEditor
} from "../../src/client/entities/WorkspaceConfluenceVisualEditor.js"
import { EntityId, ReleaseId } from "../../src/domain/identifiers.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const mounted: Array<{ readonly container: HTMLDivElement; readonly root: ReturnType<typeof createRoot> }> = []

afterEach(async () => {
  for (const { container, root } of mounted.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
})

describe("Confluence visual editor", () => {
  it("allows web links but rejects executable and embedded-data schemes", () => {
    expect(safeConfluenceEditorLinkHref("https://example.test/evidence")).toBe("https://example.test/evidence")
    expect(safeConfluenceEditorLinkHref("http://localhost/report")).toBe("http://localhost/report")
    expect(safeConfluenceEditorLinkHref("javascript:alert(1)")).toBeNull()
    expect(safeConfluenceEditorLinkHref("data:text/html,unsafe")).toBeNull()
  })

  it("treats only a terminal succeeded governed action as a saved page", () => {
    expect(releasePublicationSucceeded("succeeded")).toBe(true)
    expect(releasePublicationSucceeded("failed")).toBe(false)
    expect(releasePublicationSucceeded("unknown")).toBe(false)
    expect(releasePublicationSucceeded("denied")).toBe(false)
  })
  it("serializes the supported visual document structure to safe Markdown", () => {
    const root = document.createElement("div")
    const heading = document.createElement("h2")
    heading.textContent = "Release checks"
    const paragraph = document.createElement("p")
    paragraph.append("Confirm ")
    const strong = document.createElement("strong")
    strong.textContent = "Stage"
    paragraph.append(strong, " approval.")
    const list = document.createElement("ul")
    for (const value of ["Test report", "Risk assessment"]) {
      const item = document.createElement("li")
      item.textContent = value
      list.append(item)
    }
    root.append(heading, paragraph, list)

    expect(confluenceEditorMarkdown(root)).toBe(
      "## Release checks\n\nConfirm **Stage** approval.\n\n- Test report\n- Risk assessment"
    )
  })

  it("round-trips task markers while leaving ordinary bullets unchanged", () => {
    const root = document.createElement("div")
    const list = document.createElement("ul")
    const pending = document.createElement("li")
    const pendingControl = document.createElement("input")
    pendingControl.type = "checkbox"
    pending.append(pendingControl, " Run smoke tests")
    const completed = document.createElement("li")
    const completedControl = document.createElement("input")
    completedControl.type = "checkbox"
    completedControl.checked = true
    completed.append(completedControl, " Attach report")
    const ordinary = document.createElement("li")
    ordinary.textContent = "Keep the rollback notes"
    list.append(pending, completed, ordinary)
    root.append(list)

    expect(confluenceEditorMarkdown(root)).toBe(
      "- [ ] Run smoke tests\n- [x] Attach report\n- Keep the rollback notes"
    )
  })

  it("preserves nested list hierarchy and sizes code fences to their content", () => {
    const root = document.createElement("div")
    const list = document.createElement("ul")
    const parent = document.createElement("li")
    parent.append("Deploy services")
    const nested = document.createElement("ol")
    const nestedItem = document.createElement("li")
    nestedItem.textContent = "Verify Stage approval"
    nested.append(nestedItem)
    parent.append(nested)
    list.append(parent)
    const pre = document.createElement("pre")
    pre.textContent = "Use ``` inside the example"
    root.append(list, pre)

    expect(confluenceEditorMarkdown(root)).toBe(
      "- Deploy services\n  1. Verify Stage approval\n\n````\nUse ``` inside the example\n````"
    )
  })

  it("drops unsupported embedded media while keeping its readable text", () => {
    const root = document.createElement("div")
    const paragraph = document.createElement("p")
    paragraph.append("Evidence ")
    const image = document.createElement("img")
    image.setAttribute("src", "https://example.test/private.png")
    image.setAttribute("alt", "private diagram")
    paragraph.append(image)
    root.append(paragraph)

    expect(confluenceEditorMarkdown(root)).toBe("Evidence")
  })

  it("ticks a release task from read mode through the exact-page update", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    mounted.push({ container, root })
    const submitPublication = vi.fn(async () => ({ actionId: "action-1", state: "succeeded" }))
    const onSaved = vi.fn()

    await act(async () =>
      root.render(
        createElement(WorkspaceConfluenceVisualEditor, {
          canEdit: true,
          entityId: EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000091"),
          onAskAgent: () => undefined,
          onSaved,
          page: {
            attachmentInventoryLabel: "Complete",
            attachments: [],
            content: "- [ ] Run smoke tests\n- [x] Attach report",
            contentState: "loaded",
            contributors: [],
            createdAt: null,
            historyInventoryLabel: "Complete",
            revision: "4",
            runbookEvidenceCount: 0,
            sourceSpaceId: "SD",
            status: "Current",
            updatedAt: null,
            versions: [],
            watcherInventoryLabel: "Complete"
          },
          releaseId: ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000092"),
          submitPublication,
          title: "Release test report"
        })
      )
    )

    expect(container.textContent).toContain("1 of 2 complete")
    const checkbox = container.querySelector<HTMLInputElement>("input[type=\"checkbox\"]:not([disabled])")
    if (checkbox === null) throw new Error("Expected a release-task checkbox")
    await act(async () => {
      checkbox.click()
      await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    })

    expect(submitPublication).toHaveBeenCalledWith(expect.objectContaining({
      markdown: "- [x] Run smoke tests\n- [x] Attach report",
      provider: "confluence",
      targetEntityId: EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000091"),
      targetRevision: "4"
    }))
    expect(onSaved).toHaveBeenCalledOnce()
    expect(container.querySelector("[data-confluence-visual-editor]")).toBeNull()
  })

  it("does not report a resolved failed publication as saved", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    mounted.push({ container, root })
    const submitPublication = vi.fn(async () => ({ actionId: "action-1", state: "failed" }))
    const onSaved = vi.fn()

    await act(async () =>
      root.render(
        createElement(WorkspaceConfluenceVisualEditor, {
          canEdit: true,
          entityId: EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000091"),
          onAskAgent: () => undefined,
          onSaved,
          page: {
            attachmentInventoryLabel: "Complete",
            attachments: [],
            content: "Release body",
            contentState: "loaded",
            contributors: [],
            createdAt: null,
            historyInventoryLabel: "Complete",
            revision: "4",
            runbookEvidenceCount: 0,
            sourceSpaceId: "SD",
            status: "Current",
            updatedAt: null,
            versions: [],
            watcherInventoryLabel: "Complete"
          },
          releaseId: ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000092"),
          submitPublication,
          title: "Release test report"
        })
      )
    )

    const edit = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "Edit on this page"
    )
    if (edit === undefined) throw new Error("Expected edit action")
    await act(async () => edit.click())
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "Save to Confluence"
    )
    if (save === undefined) throw new Error("Expected save action")
    await act(async () => {
      save.click()
      await vi.waitFor(() => expect(submitPublication).toHaveBeenCalledOnce())
    })

    expect(onSaved).not.toHaveBeenCalled()
    expect(container.textContent).toContain("The page was not saved")
  })
})
