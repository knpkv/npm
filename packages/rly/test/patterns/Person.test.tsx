// @vitest-environment happy-dom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Person, RLY_PERSON_DEFAULT_VARIANTS, RLY_PERSON_VARIANTS, type RlyPerson } from "../../src/patterns/Person.js"
import { render } from "../primitives/render.js"

const avery = {
  id: "avery",
  name: "Avery Diaz",
  role: "Code reviewer"
} satisfies RlyPerson

describe("Person", () => {
  it("always renders a decorative avatar, full name, and explicit role", () => {
    const person = render(<Person person={avery} size="compact" />)
    expect(person?.textContent).toContain("Avery Diaz")
    expect(person?.textContent).toContain("Code reviewer")
    expect(person?.querySelector('[aria-hidden="true"]')?.textContent).toBe("AD")
    expect(person?.className).toContain(RLY_PERSON_VARIANTS.size.compact.className)
    expect(RLY_PERSON_DEFAULT_VARIANTS).toEqual({ size: "default" })
  })

  it("keeps deterministic fallback content for missing and broken images", async () => {
    const host = document.createElement("div")
    const root = createRoot(host)
    await act(async () =>
      root.render(
        <Person person={{ ...avery, avatarFallback: "RE", avatarSrc: "/broken-reviewer.png", id: "broken" }} />
      )
    )
    expect(host.querySelector("img")).toBeNull()
    expect(host.textContent).toContain("RE")
    expect(host.textContent).toContain("Avery Diaz")
    expect(host.textContent).toContain("Code reviewer")
    await act(async () => root.unmount())
  })

  it("rejects blank presentation identity fields and unsafe empty image values", () => {
    expect(() => renderToStaticMarkup(<Person person={{ ...avery, name: " " }} />)).toThrow("Person name")
    expect(() => renderToStaticMarkup(<Person person={{ ...avery, role: " " }} />)).toThrow("Person role")
    expect(() => renderToStaticMarkup(<Person person={{ ...avery, avatarFallback: " " }} />)).toThrow("avatarFallback")
    expect(() => renderToStaticMarkup(<Person person={{ ...avery, avatarSrc: " " }} />)).toThrow("avatarSrc")
  })
})
