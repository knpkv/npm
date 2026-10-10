// @vitest-environment happy-dom

import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import { TerminalKeyRail } from "../src/view.js"
import { dispatchTerminalKey, noTerminalModifiers, toggleTerminalModifier } from "../src/terminal-keyboard.js"

const roots: Array<Root> = []

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
})

describe("TerminalKeyRail", () => {
  it("uses the existing modifier chip for Shift and releases it after back-tab", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const sent: Array<string> = []
    const Fixture = () => {
      const [modifier, setModifier] = useState(noTerminalModifiers)
      return (
        <TerminalKeyRail
          modifier={modifier}
          onFocusTerminal={() => undefined}
          onKey={(key) => {
            const dispatch = dispatchTerminalKey(key, modifier)
            if (dispatch._tag !== "sent") return
            sent.push(dispatch.command.text)
            setModifier(dispatch.nextModifier)
          }}
          onModifierChange={(key) => setModifier(toggleTerminalModifier(modifier, key))}
        />
      )
    }
    await act(async () => root.render(<Fixture />))
    const shift = host.querySelector<HTMLButtonElement>('[data-terminal-key="shift"]')
    const tab = host.querySelector<HTMLButtonElement>('[data-terminal-key="tab"]')
    expect(shift?.className).toBe("terminal-key terminal-key-modifier")
    expect(shift?.textContent).toBe("Shift")
    expect(shift?.getAttribute("aria-pressed")).toBe("false")
    await act(async () => shift?.click())
    expect(shift?.getAttribute("aria-pressed")).toBe("true")
    expect(tab?.getAttribute("aria-label")).toBe("Shift Tab")
    await act(async () => tab?.click())
    expect(sent).toEqual(["\u001b[Z"])
    expect(shift?.getAttribute("aria-pressed")).toBe("false")
    expect(tab?.getAttribute("aria-label")).toBe("Tab")
    await act(async () => tab?.click())
    expect(sent).toEqual(["\u001b[Z", "\t"])
  })

  it("announces both latched modifiers and disables unsupported keys", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () =>
      root.render(
        <TerminalKeyRail
          modifier={{ base: "ctrl", shift: true }}
          onFocusTerminal={() => undefined}
          onKey={() => undefined}
          onModifierChange={() => undefined}
        />
      )
    )
    for (const key of ["ctrl", "shift"]) {
      expect(host.querySelector(`[data-terminal-key="${key}"]`)?.getAttribute("aria-pressed")).toBe("true")
    }
    expect(host.querySelector('[data-terminal-key="alt"]')?.getAttribute("aria-pressed")).toBe("false")
    expect(host.querySelector('[data-terminal-key="arrowUp"]')?.getAttribute("aria-label")).toBe("Ctrl Shift Arrow up")
    for (const key of ["escape", "tab"]) {
      expect(host.querySelector<HTMLButtonElement>(`[data-terminal-key="${key}"]`)?.disabled).toBe(true)
    }
  })

  it("moves the sequential tab stop when the focused key becomes unavailable", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)

    await act(async () => {
      root.render(
        <TerminalKeyRail
          modifier={{ base: null, shift: false }}
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
          modifier={{ base: "ctrl", shift: false }}
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
            modifier={{ base: null, shift: false }}
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
          modifier={{ base: null, shift: false }}
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

  it("offers a Keyboard toggle whose pressed state is the keyboard's, and asks for the other state", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const requests: Array<boolean> = []
    const render = async (keyboardOpen: boolean, withToggle: boolean) =>
      act(async () => {
        root.render(
          <TerminalKeyRail
            keyboardOpen={keyboardOpen}
            modifier={{ base: null, shift: false }}
            onFocusTerminal={() => undefined}
            onKey={() => undefined}
            {...(withToggle ? { onKeyboardToggle: (open: boolean) => requests.push(open) } : {})}
            onModifierChange={() => undefined}
          />
        )
      })

    await render(false, false)
    expect(host.querySelector('[data-terminal-key="keyboard"]')).toBeNull()

    await render(false, true)
    const keyboard = host.querySelector<HTMLButtonElement>('[data-terminal-key="keyboard"]')
    expect(keyboard?.textContent).toBe("Keyboard")
    expect(keyboard?.getAttribute("aria-pressed")).toBe("false")
    await act(async () => keyboard?.click())

    await render(true, true)
    expect(host.querySelector('[data-terminal-key="keyboard"]')?.getAttribute("aria-pressed")).toBe("true")
    await act(async () => host.querySelector<HTMLButtonElement>('[data-terminal-key="keyboard"]')?.click())
    expect(requests).toEqual([true, false])
  })

  it("offers Paste only with a handler, and keeps it in reach when the keys are hidden", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    let pastes = 0
    const render = async (withPaste: boolean) =>
      act(async () => {
        root.render(
          <TerminalKeyRail
            keysHidden
            modifier={{ base: null, shift: false }}
            onFocusTerminal={() => undefined}
            onKey={() => undefined}
            onKeysHiddenChange={() => undefined}
            onModifierChange={() => undefined}
            {...(withPaste ? { onPaste: () => (pastes += 1) } : {})}
          />
        )
      })

    await render(false)
    expect(host.querySelector('[data-terminal-key="paste"]')).toBeNull()

    await render(true)
    const paste = host.querySelector<HTMLButtonElement>('[data-terminal-key="paste"]')
    expect(paste?.getAttribute("aria-label")).toBe("Paste from clipboard")
    expect(paste?.disabled).toBe(false)
    await act(async () => paste?.click())
    expect(pastes).toBe(1)
  })
})
