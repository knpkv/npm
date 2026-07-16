// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { type RlyTimelineActorKind, type RlyTimelineEvent, TimelineRow } from "../../src/patterns/TimelineRow.js"
import { render } from "../primitives/render.js"

const eventAt = (index: number, actorKind: RlyTimelineActorKind = "system"): RlyTimelineEvent => ({
  actor: <span>{actorKind === "human" ? "Maya Chen" : `${actorKind} actor`}</span>,
  actorKind,
  dateTime: `2026-07-13T10:${String(index).padStart(2, "0")}:00Z`,
  detail: `Complete normalized event detail ${index + 1}.`,
  href: `/activity/${index + 1}`,
  id: `event-${index + 1}`,
  service: index % 2 === 0 ? "codepipeline" : "jira",
  time: `10:${String(index).padStart(2, "0")}`,
  title: `Activity event ${index + 1}`
})

describe("TimelineRow", () => {
  it("renders a native list item, time, optional link, service provenance, and actor slot", () => {
    const row = render(<TimelineRow continued event={eventAt(0, "human")} />)
    if (row === null) throw new Error("TimelineRow did not render")

    expect(row.tagName).toBe("LI")
    expect(row.getAttribute("data-rly-timeline-event-id")).toBe("event-1")
    expect(row.getAttribute("data-rly-timeline-actor")).toBe("human")
    expect(row.querySelector("time")?.getAttribute("datetime")).toBe("2026-07-13T10:00:00Z")
    expect(row.querySelector("a")?.getAttribute("href")).toBe("/activity/1")
    expect(row.querySelector("[data-rly-service='codepipeline']")?.getAttribute("aria-label")).toBe("CodePipeline")
    expect(row.textContent).toContain("Human")
    expect(row.textContent).toContain("Maya Chen")
    expect(row.querySelector("[data-rly-timeline-connector]")).not.toBeNull()
  })

  it("renders plain supplied titles when no destination, service, or actor is present", () => {
    const plain = {
      actorKind: "system",
      dateTime: "2026-07-13T10:01:00Z",
      detail: "Complete normalized event detail 2.",
      id: "event-2",
      time: "10:01",
      title: "Activity event 2"
    } satisfies RlyTimelineEvent
    const row = render(<TimelineRow continued={false} event={plain} />)
    expect(row?.querySelector("h2")?.textContent).toBe("Activity event 2")
    expect(row?.querySelector("a")).toBeNull()
    expect(row?.querySelector("[data-rly-service]")).toBeNull()
    expect(row?.textContent).toContain("System")
  })

  it("keeps one, six, and twenty event cardinalities complete without dangling connectors", () => {
    for (const count of [1, 6, 20]) {
      const markup = renderToStaticMarkup(
        <ol>
          {Array.from({ length: count }, (_, index) => (
            <TimelineRow continued={index < count - 1} event={eventAt(index)} key={index} />
          ))}
        </ol>
      )
      const host = document.createElement("div")
      host.innerHTML = markup
      expect(host.querySelectorAll("[data-rly-timeline-event-id]")).toHaveLength(count)
      expect(host.querySelectorAll("[data-rly-timeline-connector]")).toHaveLength(Math.max(0, count - 1))
      expect(host.querySelector("[data-rly-timeline-event-id]:last-child [data-rly-timeline-connector]")).toBeNull()
    }
  })

  it("publishes every actor kind as visible, color-independent text", () => {
    const actorKinds = ["human", "agent", "plugin", "system"] satisfies ReadonlyArray<RlyTimelineActorKind>
    const markup = renderToStaticMarkup(
      <ol>
        {actorKinds.map((actorKind, index) => (
          <TimelineRow continued={index < actorKinds.length - 1} event={eventAt(index, actorKind)} key={actorKind} />
        ))}
      </ol>
    )
    for (const actorKind of actorKinds) {
      expect(markup).toContain(`data-rly-timeline-actor="${actorKind}"`)
      expect(markup).toContain(`${actorKind.slice(0, 1).toUpperCase()}${actorKind.slice(1)}`)
    }
  })

  it("rejects blank visible fields and unsupported actor kinds", () => {
    const valid = eventAt(0)
    const blankFieldCases = [
      ["id", "event id"],
      ["title", "event title"],
      ["detail", "event detail"],
      ["dateTime", "event dateTime"],
      ["time", "event time"],
      ["href", "event href"]
    ] satisfies ReadonlyArray<readonly [keyof RlyTimelineEvent, string]>
    for (const [field, message] of blankFieldCases) {
      expect(() => renderToStaticMarkup(<TimelineRow continued={false} event={{ ...valid, [field]: " " }} />)).toThrow(
        message
      )
    }

    const invalidActor = { ...valid }
    Reflect.set(invalidActor, "actorKind", "vendor")
    expect(() => renderToStaticMarkup(<TimelineRow continued={false} event={invalidActor} />)).toThrow("actorKind")
  })
})
