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
})
