// @vitest-environment happy-dom

import { act, type ReactElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import { AgentContextButton } from "../../src/patterns/AgentContextButton.js"
import { AgentDrawer } from "../../src/patterns/AgentDrawer.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

interface MountedDrawer {
  readonly host: HTMLDivElement
  readonly portal: HTMLDivElement
  readonly root: Root
}

const mounted: Array<MountedDrawer> = []

const mount = async (element: ReactElement): Promise<MountedDrawer> => {
  const host = document.createElement("div")
  const portal = document.createElement("div")
  document.body.append(host, portal)
  const root = createRoot(host)
  const entry = { host, portal, root }
  mounted.push(entry)
  await act(async () => root.render(<PortalProvider container={portal}>{element}</PortalProvider>))
  return entry
}

const drawer = (overrides: Partial<Parameters<typeof AgentDrawer>[0]> = {}): ReactElement => (
  <AgentDrawer
    agentName="Release Guardian"
    capabilities={<button type="button">Check release evidence</button>}
    composer={<textarea aria-label="Message Release Guardian" />}
    context={<p>Production release dossier with six Jira items.</p>}
    contextSummary="Release v2.4.0 · Copper Finch"
    evidence={<p>PR #184 · pipeline run 6672</p>}
    onOpenChange={() => undefined}
    open
    thread={<button type="button">Refresh thread</button>}
    title="Release agent"
    {...overrides}
  />
)

afterEach(async () => {
  for (const entry of mounted.splice(0)) await act(async () => entry.root.unmount())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("AgentDrawer", () => {
  it("renders all required slots in exact order and initially focuses context, never the composer", async () => {
    const { portal } = await mount(drawer())
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    const summary = portal.querySelector<HTMLElement>('[data-rly-agent-drawer-slot="context"]')
    const composer = portal.querySelector<HTMLTextAreaElement>("textarea")
    if (dialog === null || summary === null || composer === null) throw new Error("AgentDrawer did not render")

    expect(dialog.textContent).toContain("Release agent")
    expect(dialog.textContent).toContain("Release Guardian")
    expect(summary.textContent).toContain("Release v2.4.0 · Copper Finch")
    expect(summary.tabIndex).toBe(-1)
    expect(document.activeElement).toBe(summary)
    expect(document.activeElement).not.toBe(composer)
    expect(
      [...portal.querySelectorAll("[data-rly-agent-drawer-slot]")].map((slot) =>
        slot.getAttribute("data-rly-agent-drawer-slot")
      )
    ).toEqual(["context", "evidence", "capabilities", "thread", "composer"])
  })

  it("keeps focus stable when the controlled thread receives live updates", async () => {
    const Fixture = (): ReactElement => {
      const [updates, setUpdates] = useState(0)
      return drawer({
        thread: (
          <div>
            <button onClick={() => setUpdates((count) => count + 1)} type="button">
              Add update
            </button>
            <span>Updates {updates}</span>
          </div>
        )
      })
    }
    const { portal } = await mount(<Fixture />)
    const update = [...portal.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Add update"
    )
    if (update === undefined) throw new Error("AgentDrawer update action did not render")
    update.focus()
    await act(async () => update.click())
    expect(portal.textContent).toContain("Updates 1")
    expect(document.activeElement).toBe(update)
    expect(portal.querySelector('[data-rly-agent-drawer-slot="thread"]')?.getAttribute("aria-live")).toBe("polite")
  })

  it("restores the external explicit launcher after controlled keyboard dismissal", async () => {
    const changes: Array<boolean> = []
    const Fixture = (): ReactElement => {
      const [open, setOpen] = useState(false)
      return (
        <>
          <AgentContextButton
            agentName="Release Guardian"
            context="Release v2.4.0 · Copper Finch"
            onClick={() => setOpen(true)}
          />
          {drawer({
            onOpenChange: (nextOpen) => {
              changes.push(nextOpen)
              setOpen(nextOpen)
            },
            open
          })}
        </>
      )
    }
    const { host, portal } = await mount(<Fixture />)
    const launcher = host.querySelector<HTMLButtonElement>("[data-rly-agent-context-button]")
    launcher?.focus()
    await act(async () => launcher?.click())
    const dialog = portal.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()
    await act(async () => dialog?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })))
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(changes).toEqual([false])
    expect(portal.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(launcher)
  })

  it("forwards dismissal while remaining presentation-only and validates visible context", async () => {
    const onOpenChange = vi.fn()
    const { portal } = await mount(drawer({ onOpenChange }))
    const overlay = portal.querySelector<HTMLElement>("[data-rly-sheet-overlay]")
    await act(async () =>
      overlay?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(portal.querySelector('[role="dialog"]')).not.toBeNull()

    expect(() => renderToStaticMarkup(drawer({ contextSummary: " " }))).toThrow("AgentDrawer contextSummary")
  })
})
