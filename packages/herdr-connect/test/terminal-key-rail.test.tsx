// @vitest-environment happy-dom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import { TerminalKeyRail } from "../src/view.js"

const roots: Array<Root> = []

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
})

describe("TerminalKeyRail", () => {
  it("moves the sequential tab stop when the focused key becomes unavailable", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)

    await act(async () => {
      root.render(
        <TerminalKeyRail
          modifier={null}
          onFocusTerminal={() => undefined}
          onKey={() => undefined}
          onModifierChange={() => undefined}
        />
      )
    })

    const escape = host.querySelector<HTMLButtonElement>('[data-terminal-key="escape"]')
    const ctrl = host.querySelector<HTMLButtonElement>('[data-terminal-key="ctrl"]')
    expect(escape).not.toBeNull()
    expect(ctrl).not.toBeNull()
    if (escape === null || ctrl === null) return

    await act(async () => escape.focus())
    expect(escape.tabIndex).toBe(0)

    await act(async () => {
      root.render(
        <TerminalKeyRail
          modifier="ctrl"
          onFocusTerminal={() => undefined}
          onKey={() => undefined}
          onModifierChange={() => undefined}
        />
      )
    })

    expect(escape.disabled).toBe(true)
    expect(escape.tabIndex).toBe(-1)
    expect(ctrl.tabIndex).toBe(0)
    expect(host.querySelectorAll('button[tabindex="0"]')).toHaveLength(1)
  })

  it("offers a Keys toggle only when the caller remembers the choice", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const changes: Array<boolean> = []
    const render = async (keysHidden: boolean, withToggle: boolean) =>
      act(async () => {
        root.render(
          <TerminalKeyRail
            keysHidden={keysHidden}
            modifier={null}
            onFocusTerminal={() => undefined}
            onJumpToLatest={() => undefined}
            onKey={() => undefined}
            {...(withToggle ? { onKeysHiddenChange: (hidden: boolean) => changes.push(hidden) } : {})}
            onModifierChange={() => undefined}
          />
        )
      })

    await render(false, false)
    expect(host.querySelector('[data-terminal-key="keys"]')).toBeNull()

    await render(false, true)
    const toggle = host.querySelector<HTMLButtonElement>('[data-terminal-key="keys"]')
    expect(toggle?.getAttribute("aria-expanded")).toBe("true")
    expect(toggle?.getAttribute("aria-label")).toBe("Hide terminal keys")
    for (const id of toggle?.getAttribute("aria-controls")?.split(" ") ?? []) {
      expect(document.getElementById(id)).not.toBeNull()
    }
    await act(async () => toggle?.click())
    expect(changes).toEqual([true])
  })

  it("hides the modifier and terminal keys, and keeps the view actions in reach", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => {
      root.render(
        <TerminalKeyRail
          keysHidden
          modifier={null}
          onFocusTerminal={() => undefined}
          onJumpToLatest={() => undefined}
          onKey={() => undefined}
          onKeysHiddenChange={() => undefined}
          onModifierChange={() => undefined}
        />
      )
    })

    for (const label of ["Terminal modifiers", "Terminal keys"]) {
      expect(host.querySelector(`[aria-label="${label}"]`)?.hasAttribute("hidden")).toBe(true)
    }
    const ctrl = host.querySelector<HTMLButtonElement>('[data-terminal-key="ctrl"]')
    const escape = host.querySelector<HTMLButtonElement>('[data-terminal-key="escape"]')
    expect(ctrl?.disabled).toBe(true)
    expect(escape?.disabled).toBe(true)
    const toggle = host.querySelector<HTMLButtonElement>('[data-terminal-key="keys"]')
    expect(toggle?.getAttribute("aria-expanded")).toBe("false")
    expect(toggle?.getAttribute("aria-label")).toBe("Show terminal keys")
    expect(toggle?.tabIndex).toBe(0)
    expect(host.querySelector<HTMLButtonElement>('[data-terminal-key="latest"]')?.disabled).toBe(false)
  })
})
