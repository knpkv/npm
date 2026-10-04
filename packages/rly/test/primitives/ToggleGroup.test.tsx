// @vitest-environment happy-dom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  RLY_TOGGLE_GROUP_DEFAULT_VARIANTS,
  RLY_TOGGLE_GROUP_VARIANTS,
  type RlyToggleItem,
  ToggleGroup
} from "../../src/primitives/ToggleGroup.js"
import { render } from "./render.js"

const items = [
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" }
] satisfies ReadonlyArray<RlyToggleItem>

// @ts-expect-error a toggle group is always controlled
const uncontrolled = <ToggleGroup aria-label="Range" items={items} />
// @ts-expect-error option labels must be visible strings
const unnamed: RlyToggleItem = { label: <span>24h</span>, value: "24h" }
void [uncontrolled, unnamed]

afterEach(() => {
  document.body.replaceChildren()
})

const mount = async (onValueChange: (value: string) => void) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(<ToggleGroup aria-label="Range" items={items} onValueChange={onValueChange} value="7d" />)
  )
  return root
}

const option = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)

describe("ToggleGroup", () => {
  it("publishes meaningful size metadata", () => {
    expect(RLY_TOGGLE_GROUP_DEFAULT_VARIANTS).toEqual({ size: "default" })
    expect(Object.keys(RLY_TOGGLE_GROUP_VARIANTS.size)).toEqual(["compact", "default"])
  })

  it("names the group and marks exactly the chosen option as on", () => {
    render(<ToggleGroup aria-label="Range" items={items} onValueChange={() => undefined} value="7d" />)
    const group = document.querySelector('[role="radiogroup"]')
    expect(group?.getAttribute("aria-label")).toBe("Range")
    const checked = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter(
      (button) => button.getAttribute("aria-checked") === "true"
    )
    expect(checked.map((button) => button.textContent)).toEqual(["7d"])
  })

  it("reports a new choice and never reports an empty one when the chosen option is pressed again", async () => {
    const onValueChange = vi.fn()
    const root = await mount(onValueChange)
    await act(async () => option("30d")?.click())
    await act(async () => option("7d")?.click())
    expect(onValueChange.mock.calls).toEqual([["30d"]])
    await act(async () => root.unmount())
  })

  it("arrow keys move to the next option and choose it, as a radio group does, wrapping at the ends", async () => {
    const onValueChange = vi.fn()
    const root = await mount(onValueChange)
    await act(async () => {
      const chosen = option("7d")
      chosen?.focus()
      chosen?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement?.textContent).toBe("30d")
    expect(onValueChange).toHaveBeenLastCalledWith("30d")
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement?.textContent).toBe("24h")
    expect(onValueChange).toHaveBeenLastCalledWith("24h")
    await act(async () => root.unmount())
  })

  it("chooses on a quick tap, where the key is released before focus would move", async () => {
    const onValueChange = vi.fn()
    const root = await mount(onValueChange)
    await act(async () => {
      const chosen = option("7d")
      chosen?.focus()
      chosen?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }))
      chosen?.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowLeft" }))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(onValueChange).toHaveBeenLastCalledWith("24h")
    expect(document.activeElement?.textContent).toBe("24h")
    await act(async () => root.unmount())
  })

  it("reports nothing when an arrow key lands on the option already chosen", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const onValueChange = vi.fn()
    await act(async () =>
      root.render(
        <ToggleGroup
          aria-label="Range"
          items={[{ label: "7d", value: "7d" }]}
          onValueChange={onValueChange}
          value="7d"
        />
      )
    )
    await act(async () => {
      const only = option("7d")
      only?.focus()
      only?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(onValueChange).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })

  it("still moves focus onto the chosen option without reporting it again", async () => {
    const onValueChange = vi.fn()
    const root = await mount(onValueChange)
    await act(async () => {
      const unchosen = option("24h")
      unchosen?.focus()
      unchosen?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement?.textContent).toBe("7d")
    expect(onValueChange).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })

  it("rejects inaccessible or ambiguous configurations", () => {
    const noop = () => undefined
    expect(() =>
      renderToStaticMarkup(<ToggleGroup aria-label=" " items={items} onValueChange={noop} value="7d" />)
    ).toThrow("must contain visible text")
    expect(() =>
      renderToStaticMarkup(
        <ToggleGroup
          aria-label="Range"
          items={[...items, { label: "24h again", value: "24h" }]}
          onValueChange={noop}
          value="7d"
        />
      )
    ).toThrow("must be unique")
    expect(() =>
      renderToStaticMarkup(<ToggleGroup aria-label="Range" items={items} onValueChange={noop} value="1y" />)
    ).toThrow("must identify an option")
  })
})
