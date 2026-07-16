// @vitest-environment happy-dom

import { act, type ReactElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import {
  RLY_SELECT_DEFAULT_VARIANTS,
  RLY_SELECT_VARIANTS,
  Select,
  type RlySelectOption
} from "../../src/primitives/Select.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const options = [
  { label: "Development", value: "development" },
  { label: "Staging", value: "staging" },
  { disabled: true, label: "Production", value: "production" }
] satisfies ReadonlyArray<RlySelectOption>

interface MountedSelect {
  readonly host: HTMLDivElement
  readonly portal: HTMLDivElement
  readonly root: Root
}

const mounted: Array<MountedSelect> = []

const mount = async (element: ReactElement): Promise<MountedSelect> => {
  const host = document.createElement("div")
  const portal = document.createElement("div")
  document.body.append(host, portal)
  const root = createRoot(host)
  mounted.push({ host, portal, root })
  await act(async () => root.render(<PortalProvider container={portal}>{element}</PortalProvider>))
  return { host, portal, root }
}

afterEach(async () => {
  for (const entry of mounted.splice(0)) await act(async () => entry.root.unmount())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("Select", () => {
  it("renders a labelled placeholder and machine-readable size without a portal fallback", () => {
    const markup = renderToStaticMarkup(<Select aria-label="Environment" options={options} size="compact" />)
    expect(markup).toContain('role="combobox"')
    expect(markup).toContain('aria-label="Environment"')
    expect(markup).toContain("Select an option")
    expect(markup).toContain(RLY_SELECT_VARIANTS.size.compact.className)
    expect(RLY_SELECT_DEFAULT_VARIANTS).toEqual({ size: "default" })
  })

  it("opens from the keyboard and reports controlled selection", async () => {
    Reflect.set(HTMLElement.prototype, "scrollIntoView", vi.fn())
    const changes: Array<string> = []
    const Controlled = (): ReactElement => {
      const [value, setValue] = useState<string | undefined>(undefined)
      return (
        <Select
          aria-label="Environment"
          onValueChange={(next) => {
            changes.push(next)
            setValue(next)
          }}
          options={options}
          value={value}
        />
      )
    }
    const { host, portal } = await mount(<Controlled />)
    const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]')
    trigger?.focus()
    await act(async () => trigger?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })))
    const staging = portal.querySelector<HTMLElement>('[role="option"]:nth-of-type(2)')
    expect(portal.querySelector('[role="listbox"]')).not.toBeNull()
    expect(staging?.textContent).toContain("Staging")
    const firstOption = document.activeElement
    expect(firstOption?.getAttribute("role")).toBe("option")
    await act(async () => staging?.focus())
    expect(document.activeElement).toBe(staging)
    await act(async () => staging?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })))
    expect(changes).toEqual(["staging"])
    expect(trigger?.textContent).toContain("Staging")
  })

  it("supports an uncontrolled default and protects disabled states", async () => {
    const { host, portal } = await mount(
      <Select aria-label="Environment" defaultValue="development" disabled options={options} />
    )
    const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]')
    expect(trigger?.disabled).toBe(true)
    expect(trigger?.textContent).toContain("Development")
    await act(async () => trigger?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })))
    expect(portal.querySelector('[role="listbox"]')).toBeNull()
  })

  it("does not mount open content when the controlled portal boundary is unavailable", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        <PortalProvider container={null}>
          <Select aria-label="Environment" onOpenChange={() => undefined} open options={options} />
        </PortalProvider>
      )
    )
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
    await act(async () => root.unmount())
  })

  it("rejects empty, duplicate, and unmatched option contracts", () => {
    expect(() => renderToStaticMarkup(<Select aria-label=" " options={options} />)).toThrow("Select aria-label")
    expect(() =>
      renderToStaticMarkup(
        <Select
          aria-label="Environment"
          options={[
            { label: "One", value: "same" },
            { label: "Two", value: "same" }
          ]}
        />
      )
    ).toThrow("Duplicate Select option value")
    expect(() =>
      renderToStaticMarkup(
        <Select aria-label="Environment" onValueChange={() => undefined} options={options} value="missing" />
      )
    ).toThrow("does not match")
    expect(() => renderToStaticMarkup(<Select aria-label="Environment" options={[]} />)).toThrow(
      "at least one enabled option"
    )
    expect(() =>
      renderToStaticMarkup(
        <Select aria-label="Environment" options={[{ disabled: true, label: "Unavailable", value: "none" }]} />
      )
    ).toThrow("at least one enabled option")
    expect(() =>
      renderToStaticMarkup(<Select aria-label="Environment" disabled options={[]} placeholder="No options" />)
    ).not.toThrow()
  })
})
