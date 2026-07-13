// @vitest-environment happy-dom

import { act, type ReactElement, useState } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import {
  PeopleStrip,
  RLY_PEOPLE_STRIP_DEFAULT_VARIANTS,
  RLY_PEOPLE_STRIP_VARIANTS
} from "../../src/patterns/PeopleStrip.js"
import type { RlyPerson } from "../../src/patterns/Person.js"

const people = [
  { id: "avery", name: "Avery Diaz", role: "PR author" },
  { id: "blake", name: "Blake Kim", role: "Release owner" },
  { id: "casey", name: "Casey Singh", role: "Code reviewer" },
  { id: "devon", name: "Devon O'Rourke", role: "Deployment operator" },
  {
    id: "emery",
    name: "Emery van der Meer-Rodríguez with a deliberately long full name",
    role: "Merge approver"
  }
] satisfies ReadonlyArray<RlyPerson>

const ControlledStrip = (): ReactElement => {
  const [expanded, setExpanded] = useState(false)
  return (
    <PeopleStrip
      aria-label="Release collaborators"
      expanded={expanded}
      limit={3}
      onExpandedChange={setExpanded}
      people={people}
    />
  )
}

describe("PeopleStrip", () => {
  it("covers zero, one, the visible limit, and deterministic overflow", () => {
    const unchanged = vi.fn()
    const zero = renderToStaticMarkup(
      <PeopleStrip aria-label="Nobody" expanded={false} onExpandedChange={unchanged} people={[]} />
    )
    const one = renderToStaticMarkup(
      <PeopleStrip aria-label="One person" expanded={false} onExpandedChange={unchanged} people={people.slice(0, 1)} />
    )
    const limit = renderToStaticMarkup(
      <PeopleStrip
        aria-label="Three people"
        expanded={false}
        onExpandedChange={unchanged}
        people={people.slice(0, 3)}
      />
    )
    const overflow = renderToStaticMarkup(
      <PeopleStrip aria-label="Five people" expanded={false} onExpandedChange={unchanged} people={people} />
    )

    expect(zero).toContain('aria-label="Nobody"')
    expect(zero).not.toContain("<li")
    expect(one).toContain("Avery Diaz")
    expect(limit).not.toContain("+1 people")
    expect(overflow).toContain(">+2 people<")
    expect(overflow).toContain('aria-label="Show 2 more people"')
    expect(overflow).not.toContain("Emery van der Meer-Rodríguez")
  })

  it("expands only after its controlled owner updates state", async () => {
    const host = document.createElement("div")
    const root = createRoot(host)
    await act(async () => root.render(<ControlledStrip />))
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Show 2 more people"]')
    expect(button?.textContent).toBe("+2 people")
    await act(async () => button?.click())
    expect(host.textContent).toContain("Emery van der Meer-Rodríguez with a deliberately long full name")
    expect(host.querySelector<HTMLButtonElement>("button")?.getAttribute("aria-label")).toBe("Show fewer people")
    expect(host.querySelector<HTMLButtonElement>("button")?.getAttribute("aria-expanded")).toBe("true")
    await act(async () => root.unmount())
  })

  it("retains full names and roles in a 320px presentation boundary", () => {
    const markup = renderToStaticMarkup(
      <div style={{ inlineSize: "320px" }}>
        <PeopleStrip
          aria-label="Narrow people"
          expanded
          limit={3}
          onExpandedChange={() => undefined}
          people={people}
          size="compact"
        />
      </div>
    )
    const host = document.createElement("div")
    host.innerHTML = markup
    for (const person of people) {
      expect(host.textContent).toContain(person.name)
      expect(host.textContent).toContain(person.role)
    }
    expect(markup).toContain(RLY_PEOPLE_STRIP_VARIANTS.size.compact.className)
    expect(RLY_PEOPLE_STRIP_DEFAULT_VARIANTS).toEqual({ size: "default" })
  })

  it("rejects duplicate identities and invalid limits", () => {
    const common = { "aria-label": "People", expanded: false, onExpandedChange: () => undefined }
    expect(() => renderToStaticMarkup(<PeopleStrip {...common} limit={0} people={people} />)).toThrow(
      "positive integer"
    )
    expect(() =>
      renderToStaticMarkup(
        <PeopleStrip {...common} people={[people[0], people[0]].filter((person) => person !== undefined)} />
      )
    ).toThrow("ids must be unique")
  })
})
