import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties, ReactElement } from "react"
import { expect } from "storybook/test"
import { Person, type RlyPerson } from "../../src/patterns/Person.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle } from "../primitives/storyStyles.js"

const narrowStyle: CSSProperties = {
  display: "grid",
  gap: "var(--rly-space-16)",
  inlineSize: "100%",
  maxInlineSize: "320px"
}

const people = [
  { id: "avery", name: "Avery Diaz", role: "Code reviewer" },
  {
    avatarFallback: "BM",
    avatarSrc: "/fixtures/broken-person-avatar.png",
    id: "broken",
    name: "Beatriz Martínez-van der Meer with a deliberately long full name",
    role: "Deployment operator for production verification"
  }
] satisfies ReadonlyArray<RlyPerson>

const PersonStates = (): ReactElement => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Attributed people
    </Text>
    <div data-person-narrow="" style={narrowStyle}>
      <Person person={people[0] ?? { id: "fallback", name: "Avery Diaz", role: "Code reviewer" }} />
      <Person
        person={people[1] ?? { id: "fallback-long", name: "Beatriz Martínez", role: "Deployment operator" }}
        size="compact"
      />
    </div>
  </main>
)

const meta = {
  component: Person,
  tags: ["autodocs"],
  title: "Patterns/Person"
} satisfies Meta<typeof Person>

export default meta
type Story = StoryObj<typeof meta>

export const States: Story = {
  args: { person: people[0] ?? { id: "fallback", name: "Avery Diaz", role: "Code reviewer" } },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("Avery Diaz")).toBeVisible()
    await expect(canvas.getByText("Code reviewer")).toBeVisible()
    await expect(canvas.getByText("Beatriz Martínez-van der Meer with a deliberately long full name")).toBeVisible()
    await expect(canvas.getByText("Deployment operator for production verification")).toBeVisible()
    await expect(canvasElement.querySelectorAll('[data-rly-person-size="compact"]')).toHaveLength(1)
    await expect(canvasElement.querySelectorAll('[aria-hidden="true"]')).not.toHaveLength(0)

    const narrow = canvasElement.querySelector<HTMLElement>("[data-person-narrow]")
    if (narrow === null) throw new Error("Person narrow story boundary did not mount")
    await expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth)
  },
  render: () => <PersonStates />
}
