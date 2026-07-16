import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties, ReactElement } from "react"
import { expect, userEvent } from "storybook/test"
import { Person } from "../../src/patterns/Person.js"
import { type RlyTimelineActorKind, type RlyTimelineEvent, TimelineRow } from "../../src/patterns/TimelineRow.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "../primitives/storyStyles.js"

const actorKinds = ["human", "agent", "plugin", "system"] satisfies ReadonlyArray<RlyTimelineActorKind>
const listStyle: CSSProperties = { listStyle: "none", margin: 0, padding: 0, width: "100%" }
const compactStyle: CSSProperties = { inlineSize: "100%", maxInlineSize: "320px" }

const eventAt = (index: number, actorKind: RlyTimelineActorKind = "system"): RlyTimelineEvent => ({
  actor:
    actorKind === "human" ? (
      <Person person={{ id: `person-${index}`, name: "Maya Chen", role: "Release approver" }} size="compact" />
    ) : (
      <span>
        {actorKind === "agent" ? "Release Guardian" : actorKind === "plugin" ? "Jira sync" : "Control Center"}
      </span>
    ),
  actorKind,
  dateTime: `2026-07-13T10:${String(index).padStart(2, "0")}:00Z`,
  detail:
    index === 0
      ? "A complete, intentionally long event explanation remains readable without horizontal overflow at compact widths."
      : `Normalized delivery evidence event ${index + 1}.`,
  href: `/w/engineering/activity/${index + 1}`,
  id: `timeline-event-${index + 1}`,
  service: index % 2 === 0 ? "codepipeline" : "jira",
  time: `10:${String(index).padStart(2, "0")}`,
  title:
    index === 0 ? "Integration stage failed against the immutable release candidate" : `Activity event ${index + 1}`
})

const Timeline = ({ count }: { readonly count: number }): ReactElement => (
  <ol aria-label={`${count} timeline events`} data-timeline-cardinality={count} style={listStyle}>
    {Array.from({ length: count }, (_, index) => (
      <TimelineRow
        continued={index < count - 1}
        event={eventAt(index, actorKinds[index % actorKinds.length])}
        key={index}
      />
    ))}
  </ol>
)

const ActorKindsCatalog = (): ReactElement => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Attributed activity timeline
    </Text>
    <div style={stackStyle}>
      <ol aria-label="Timeline actor kinds" style={listStyle}>
        {actorKinds.map((actorKind, index) => (
          <TimelineRow continued={index < actorKinds.length - 1} event={eventAt(index, actorKind)} key={actorKind} />
        ))}
      </ol>
      <Timeline count={1} />
      <Timeline count={6} />
      <Timeline count={20} />
    </div>
  </main>
)

const CompactForcedColorsCatalog = (): ReactElement => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Compact activity timeline
    </Text>
    <div data-timeline-row-compact="" style={compactStyle}>
      <Timeline count={6} />
    </div>
  </main>
)

const meta = {
  component: TimelineRow,
  tags: ["autodocs"],
  title: "Patterns/TimelineRow"
} satisfies Meta<typeof TimelineRow>

export default meta
type Story = StoryObj<typeof meta>

export const ActorKinds: Story = {
  args: { continued: false, event: eventAt(0) },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("[data-rly-timeline-event-id]")).toHaveLength(31)
    for (const actorKind of actorKinds) {
      await expect(canvasElement.querySelector(`[data-rly-timeline-actor="${actorKind}"]`)).not.toBeNull()
    }
    for (const count of [1, 6, 20]) {
      const timeline = canvasElement.querySelector(`[data-timeline-cardinality="${count}"]`)
      if (timeline === null) throw new Error(`TimelineRow ${count}-item fixture did not mount`)
      await expect(timeline.querySelectorAll("[data-rly-timeline-event-id]")).toHaveLength(count)
      await expect(timeline.querySelectorAll("[data-rly-timeline-connector]")).toHaveLength(Math.max(0, count - 1))
    }
    await userEvent.tab()
    await expect(canvasElement.ownerDocument.activeElement?.tagName).toBe("A")
    canvasElement.dataset.timelineRowActorKindsPlayComplete = "true"
  },
  render: () => <ActorKindsCatalog />
}

export const CompactForcedColors: Story = {
  args: { continued: false, event: eventAt(0) },
  globals: { forcedColors: "active", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvasElement }) => {
    const compact = canvasElement.querySelector<HTMLElement>("[data-timeline-row-compact]")
    if (compact === null) throw new Error("TimelineRow compact boundary did not mount")
    await expect(compact.scrollWidth).toBeLessThanOrEqual(compact.clientWidth)
    await expect(compact.querySelectorAll("[data-rly-timeline-event-id]")).toHaveLength(6)
    await expect(compact.querySelectorAll("[data-rly-timeline-connector]")).toHaveLength(5)
    await userEvent.tab()
    await expect(canvasElement.ownerDocument.activeElement?.tagName).toBe("A")
    canvasElement.dataset.timelineRowCompactPlayComplete = "true"
  },
  render: () => <CompactForcedColorsCatalog />
}
