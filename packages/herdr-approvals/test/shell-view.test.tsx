import { describe, expect, it } from "@effect/vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { FleetShell, fleetShortcutFor } from "../src/shell-view.js"

describe("shared fleet shell", () => {
  it("keeps Approvals, Connect, and Work in distinct tab panels under one masthead", () => {
    const markup = renderToStaticMarkup(
      <FleetShell
        approvals={<section>APPROVALS_ONLY</section>}
        connect={<section>CONNECT_TERMINAL_CHAT_TREE</section>}
        hostCount={3}
        work={<section>WORK_DEPARTURE_BOARD</section>}
      />
    )
    expect(markup.match(/fleet-shell-masthead/g)).toHaveLength(1)
    expect(markup).toContain("3 configured hosts")
    expect(markup.match(/role="tab"/g)).toHaveLength(3)
    expect(markup).toContain(">Approvals</button>")
    expect(markup).toContain(">Connect</button>")
    expect(markup).toContain(">Work</button>")
    expect(markup).toMatch(/role="tabpanel"[^>]*>.*Keyboard shortcuts.*<section>APPROVALS_ONLY<\/section>/)
    expect(markup).not.toContain("APPROVALS_ONLY<section>CONNECT_TERMINAL_CHAT_TREE")
    expect(markup).not.toContain("APPROVALS_ONLY<section>WORK_DEPARTURE_BOARD")
    expect(markup).toContain("1</kbd>")
    expect(markup).toContain("Agent search")
    expect(markup.indexOf("Keyboard shortcuts")).toBeLessThan(markup.indexOf("APPROVALS_ONLY"))
  })

  it("maps global shortcuts without stealing editable input", () => {
    expect(fleetShortcutFor({ editable: false, key: "1", modified: false })).toEqual({
      _tag: "select_tab",
      tab: "approvals"
    })
    expect(fleetShortcutFor({ editable: false, key: "2", modified: false })).toEqual({
      _tag: "select_tab",
      tab: "connect"
    })
    expect(fleetShortcutFor({ editable: false, key: "/", modified: false })).toEqual({
      _tag: "focus_agent_search"
    })
    expect(fleetShortcutFor({ editable: true, key: "2", modified: false })).toBeNull()
    expect(fleetShortcutFor({ editable: false, key: "2", modified: true })).toBeNull()
  })
})
