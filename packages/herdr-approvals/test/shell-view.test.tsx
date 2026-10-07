import { describe, expect, it } from "@effect/vitest"
import { renderToStaticMarkup } from "react-dom/server"
import {
  FLEET_SEQUENCE_MS,
  FleetShell,
  FleetWorkPanel,
  type FleetWorkState,
  fleetShortcutFor
} from "../src/shell-view.js"

const press = (
  key: string,
  options: {
    readonly alt?: boolean
    readonly control?: boolean
    readonly editable?: boolean
    readonly now?: number
    readonly prefix?: { readonly at: number } | null
  } = {}
) =>
  fleetShortcutFor({
    alt: options.alt ?? false,
    control: options.control ?? false,
    editable: options.editable ?? false,
    key,
    now: options.now ?? 0,
    prefix: options.prefix ?? null
  })

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
    // What the shell knows: configured hosts, not how many answer.
    expect(markup).toContain(">3 hosts<")
    expect(markup).not.toContain("configured")
    expect(markup.match(/role="tab"/g)).toHaveLength(3)
    expect(markup).toContain(">Approvals</button>")
    expect(markup).toContain(">Connect</button>")
    expect(markup).toContain(">Work</button>")
    expect(markup).toContain("Keyboard shortcuts")
    // No key rail inside the panels any more.
    expect(markup).not.toContain("<kbd>")
    expect(markup).not.toContain("APPROVALS_ONLY<section>CONNECT_TERMINAL_CHAT_TREE")
    expect(markup).not.toContain("APPROVALS_ONLY<section>WORK_DEPARTURE_BOARD")
  })

  it("acts on no single bare key: 1, 2, 3 and / do nothing", () => {
    for (const key of ["1", "2", "3", "/", "a", "c", "w"]) expect(press(key)).toEqual({ prefix: null, shortcut: null })
  })

  it("selects a tab with g then a, c or w, within the sequence window", () => {
    const g = press("g", { now: 1_000 })
    expect(g).toEqual({ prefix: { at: 1_000 }, shortcut: null })
    expect(press("c", { now: 1_500, prefix: g.prefix }).shortcut).toEqual({ _tag: "select_tab", tab: "connect" })
    expect(press("a", { now: 1_500, prefix: g.prefix }).shortcut).toEqual({ _tag: "select_tab", tab: "approvals" })
    expect(press("w", { now: 1_000 + FLEET_SEQUENCE_MS, prefix: g.prefix }).shortcut).toEqual({
      _tag: "select_tab",
      tab: "work"
    })
    // Too late, or another key first: nothing.
    expect(press("c", { now: 1_001 + FLEET_SEQUENCE_MS, prefix: g.prefix })).toEqual({ prefix: null, shortcut: null })
    expect(press("x", { now: 1_100, prefix: g.prefix })).toEqual({ prefix: null, shortcut: null })
  })

  it("leaves typing alone: g then c in a field changes nothing", () => {
    const g = press("g", { editable: true })
    expect(g).toEqual({ prefix: null, shortcut: null })
    expect(press("c", { editable: true, prefix: { at: 0 } })).toEqual({ prefix: null, shortcut: null })
  })

  it("focuses agent search with Ctrl or Cmd+K, even from a field, and never with Alt", () => {
    expect(press("k", { control: true }).shortcut).toEqual({ _tag: "focus_agent_search" })
    expect(press("K", { control: true, editable: true }).shortcut).toEqual({ _tag: "focus_agent_search" })
    expect(press("k", { alt: true, control: true }).shortcut).toBeNull()
    expect(press("1", { alt: true }).shortcut).toBeNull()
  })

  it("opens the shortcut list with ?, but not while typing", () => {
    expect(press("?").shortcut).toEqual({ _tag: "open_shortcuts" })
    expect(press("?", { editable: true }).shortcut).toBeNull()
  })

  it("gives the Work tab a page heading while the board, with its own, isn't shown", () => {
    const states: ReadonlyArray<FleetWorkState> = [
      { _tag: "Loading" },
      { _tag: "Unavailable" },
      { _tag: "Failure", content: null, detail: "Work request failed." }
    ]
    for (const state of states) {
      expect(renderToStaticMarkup(<FleetWorkPanel state={state} />)).toMatch(/<h1[^>]*>Work<\/h1>/)
    }
  })
})
