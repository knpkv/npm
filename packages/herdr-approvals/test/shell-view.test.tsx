import { describe, expect, it } from "@effect/vitest"
import { renderToStaticMarkup } from "react-dom/server"
import {
  FLEET_SEQUENCE_MS,
  FleetShell,
  FleetWorkPanel,
  type FleetWorkState,
  fleetShortcutFor,
  shellTabLinkTarget
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
  it("keeps Approvals, Connect, Work and Usage in distinct tab panels under one masthead", () => {
    const markup = renderToStaticMarkup(
      <FleetShell
        approvals={<section>APPROVALS_ONLY</section>}
        connect={<section>CONNECT_TERMINAL_CHAT_TREE</section>}
        hostCount={3}
        usage={<section>USAGE_HISTORY</section>}
        work={<section>WORK_DEPARTURE_BOARD</section>}
      />
    )
    expect(markup.match(/fleet-shell-masthead/g)).toHaveLength(1)
    // What the shell knows: configured hosts, not how many answer.
    expect(markup).toContain(">3 hosts<")
    expect(markup).not.toContain("configured")
    expect(markup.match(/role="tab"/g)).toHaveLength(4)
    expect(markup).toContain(">Approvals</button>")
    expect(markup).toContain(">Connect</button>")
    expect(markup).toContain(">Work</button>")
    expect(markup).toContain(">Usage</button>")
    expect(markup).toContain("Keyboard shortcuts")
    // No key rail inside the panels any more.
    expect(markup).not.toContain("<kbd>")
    expect(markup).not.toContain("APPROVALS_ONLY<section>CONNECT_TERMINAL_CHAT_TREE")
    expect(markup).not.toContain("APPROVALS_ONLY<section>WORK_DEPARTURE_BOARD")
  })

  it("places a page notice under the masthead and above the tabs, inside the page", () => {
    const markup = renderToStaticMarkup(
      <FleetShell
        approvals={<section>APPROVALS_ONLY</section>}
        connect={<section>CONNECT</section>}
        hostCount={1}
        notice={<p>REFRESH_FAILED</p>}
        usage={<section>USAGE_HISTORY</section>}
        work={<section>WORK</section>}
      />
    )
    const notice = markup.indexOf("REFRESH_FAILED")
    expect(notice).toBeGreaterThan(markup.indexOf('<main class="fleet-shell-main">'))
    expect(notice).toBeGreaterThan(markup.indexOf("</header>"))
    expect(notice).toBeLessThan(markup.indexOf('role="tablist"'))
  })

  it("brands the masthead Relay, with its mark beside the name and the tabs named after it", () => {
    const markup = renderToStaticMarkup(
      <FleetShell approvals={null} connect={null} hostCount={1} usage={null} work={null} />
    )
    const masthead = markup.slice(markup.indexOf("fleet-shell-masthead"), markup.indexOf("</header>"))
    expect(masthead).toMatch(/<strong[^>]*>Relay<\/strong>/)
    // The name is in words, so the mark is decorative.
    expect(masthead).toMatch(/<span[^>]*aria-hidden="true"[^>]*fleet-shell-mark/)
    expect(masthead).not.toContain("Herdr")
    expect(markup).toContain('aria-label="Relay applications"')
  })

  it("acts on no single bare key: 1, 2, 3 and / do nothing", () => {
    for (const key of ["1", "2", "3", "/", "a", "c", "w", "u"])
      expect(press(key)).toEqual({ prefix: null, shortcut: null })
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

  it("opens Usage with g then u", () => {
    const g = press("g", { now: 1_000 })
    expect(press("u", { now: 1_200, prefix: g.prefix }).shortcut).toEqual({ _tag: "select_tab", tab: "usage" })
  })

  // Connect's limits line links to /?tab=usage: inside the shell that switches tabs, not pages.
  it("reads a same-page ?tab= link as a tab switch, and nothing else", () => {
    const here = { origin: "http://127.0.0.1:8787", pathname: "/" }
    expect(shellTabLinkTarget("/?tab=usage", here)).toBe("usage")
    expect(shellTabLinkTarget("?tab=connect", here)).toBe("connect")
    expect(shellTabLinkTarget("/?tab=settings", here)).toBeNull()
    expect(shellTabLinkTarget("/connect/?tab=usage", here)).toBeNull()
    expect(shellTabLinkTarget("https://example.com/?tab=usage", here)).toBeNull()
    expect(shellTabLinkTarget("/", here)).toBeNull()
  })
})
