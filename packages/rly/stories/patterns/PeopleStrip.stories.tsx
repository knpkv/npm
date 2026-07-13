import type { Meta, StoryObj } from "@storybook/react-vite"
import { type CSSProperties, type ReactElement, useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import { PeopleStrip } from "../../src/patterns/PeopleStrip.js"
import type { RlyPerson } from "../../src/patterns/Person.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "../primitives/storyStyles.js"

const narrowStyle: CSSProperties = {
  inlineSize: "100%",
  maxInlineSize: "320px"
}

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

const ControlledPeopleStrip = (): ReactElement => {
  const [expanded, setExpanded] = useState(false)
  return (
    <main style={pageStyle}>
      <Text as="h1" variant="section-title">
        Release collaborators
      </Text>
      <div style={stackStyle}>
        <PeopleStrip
          aria-label="Release collaborators"
          expanded={expanded}
          limit={3}
          onExpandedChange={setExpanded}
          people={people}
        />
        <div data-people-narrow="" style={narrowStyle}>
          <PeopleStrip
            aria-label="Compact release collaborators"
            expanded
            limit={3}
            onExpandedChange={() => undefined}
            people={people}
            size="compact"
          />
        </div>
        <PeopleStrip
          aria-label="No assigned reviewers"
          expanded={false}
          onExpandedChange={() => undefined}
          people={[]}
        />
        <PeopleStrip
          aria-label="Single owner"
          expanded={false}
          onExpandedChange={() => undefined}
          people={people.slice(0, 1)}
        />
      </div>
    </main>
  )
}

const meta = {
  component: PeopleStrip,
  tags: ["autodocs"],
  title: "Patterns/PeopleStrip"
} satisfies Meta<typeof PeopleStrip>

export default meta
type Story = StoryObj<typeof meta>

export const Overflow: Story = {
  args: {
    "aria-label": "Release collaborators",
    expanded: false,
    onExpandedChange: () => undefined,
    people
  },
  play: async ({ canvas, canvasElement }) => {
    const releaseList = within(canvas.getByRole("list", { name: "Release collaborators" }))
    const control = releaseList.getByRole("button", { name: "Show 2 more people" })
    await expect(control).toHaveTextContent("+2 people")
    await expect(
      releaseList.queryByText("Emery van der Meer-Rodríguez with a deliberately long full name")
    ).not.toBeInTheDocument()
    await userEvent.click(control)
    await expect(releaseList.getByText("Emery van der Meer-Rodríguez with a deliberately long full name")).toBeVisible()
    await expect(releaseList.getByRole("button", { name: "Show fewer people" })).toHaveAttribute(
      "aria-expanded",
      "true"
    )

    const narrow = canvasElement.querySelector<HTMLElement>("[data-people-narrow]")
    if (narrow === null) throw new Error("PeopleStrip narrow story boundary did not mount")
    await expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth)
  },
  render: () => <ControlledPeopleStrip />
}
