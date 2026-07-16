// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { EntityShell, type EntityShellProps } from "../../src/patterns/EntityShell.js"
import { render } from "../primitives/render.js"

const slots = {
  actions: <button type="button">Review action</button>,
  activity: <div>Recent activity</div>,
  agentEntry: <button type="button">Open contextual agent</button>,
  collaborators: <div>Named collaborators</div>,
  content: <div>Native entity content</div>,
  evidence: <div>Evidence provenance</div>,
  facts: <div>Entity facts</div>,
  navigation: <a href="/releases/payments">Back to release</a>,
  relationships: <div>Relationship views</div>
} satisfies Pick<
  EntityShellProps,
  | "actions"
  | "activity"
  | "agentEntry"
  | "collaborators"
  | "content"
  | "evidence"
  | "facts"
  | "navigation"
  | "relationships"
>

const shell = (
  <EntityShell
    {...slots}
    freshness="stale"
    freshnessDateTime="2026-07-13T10:18:00Z"
    freshnessTime="Observed 12 minutes ago"
    reason="Three integration checks failed against the current release head."
    service="jira"
    title="OPS-428 · Production retry policy"
    tone="critical"
    verdict="Cannot ship"
  />
)

describe("EntityShell", () => {
  it("renders one labelled article with service, title, verdict, freshness, and required slots", () => {
    const article = render(shell)
    if (article === null) throw new Error("EntityShell did not render")
    const heading = article.querySelector("h1")
    if (heading === null) throw new Error("EntityShell title did not render")

    expect(article.tagName).toBe("ARTICLE")
    expect(article.getAttribute("aria-labelledby")).toBe(heading.id)
    expect(heading.textContent).toBe("OPS-428 · Production retry policy")
    expect(article.querySelector("[data-rly-service='jira']")?.getAttribute("aria-label")).toBe("Jira")
    expect(article.textContent).toContain("Cannot ship")
    expect(article.textContent).toContain("Three integration checks failed")
    expect(article.textContent).toContain("Stale")
    expect(article.querySelector("time")?.getAttribute("datetime")).toBe("2026-07-13T10:18:00Z")
    for (const value of Object.values(slots)) expect(article.textContent).toContain(value.props.children)
  })

  it("keeps semantic slot order stable across wide and compact presentation", () => {
    const article = render(shell)
    const order = Array.from(article?.querySelectorAll("[data-rly-entity-shell-slot]") ?? [], (element) =>
      element.getAttribute("data-rly-entity-shell-slot")
    )
    expect(order).toEqual([
      "navigation",
      "freshness",
      "actions",
      "agent-entry",
      "content",
      "facts",
      "evidence",
      "collaborators",
      "relationships",
      "activity"
    ])
  })

  it("omits optional regions without hiding required content", () => {
    const article = render(
      <EntityShell
        actions="Actions unavailable"
        agentEntry="Agent unavailable"
        collaborators="No collaborators assigned"
        content="Entity content"
        freshness="unavailable"
        reason="The source is unavailable."
        relationships="No relationships recorded"
        service="clockify"
        title="Clockify rollup"
        tone="neutral"
        verdict="Unavailable"
      />
    )
    expect(article?.querySelector("nav")).toBeNull()
    expect(article?.querySelector("[data-rly-entity-shell-slot='facts']")).toBeNull()
    expect(article?.querySelector("[data-rly-entity-shell-slot='evidence']")).toBeNull()
    expect(article?.querySelector("[data-rly-entity-shell-slot='activity']")).toBeNull()
    expect(article?.textContent).toContain("Entity content")
    expect(article?.textContent).toContain("No relationships recorded")
  })

  it("rejects blank visible identity and incomplete freshness time pairs", () => {
    expect(() =>
      renderToStaticMarkup(
        <EntityShell
          actions="Actions"
          agentEntry="Agent"
          collaborators="People"
          content="Content"
          freshness="current"
          reason="Current evidence."
          relationships="Relationships"
          service="jira"
          title=" "
          tone="positive"
          verdict="Ready"
        />
      )
    ).toThrow("EntityShell title")

    const invalidProps: EntityShellProps = {
      actions: "Actions",
      agentEntry: "Agent",
      collaborators: "People",
      content: "Content",
      freshness: "current",
      freshnessDateTime: "2026-07-13T10:18:00Z",
      freshnessTime: "Now",
      reason: "Current evidence.",
      relationships: "Relationships",
      service: "jira",
      title: "Issue",
      tone: "positive",
      verdict: "Ready"
    }
    Reflect.deleteProperty(invalidProps, "freshnessDateTime")
    expect(() => renderToStaticMarkup(<EntityShell {...invalidProps} />)).toThrow("must be supplied together")
  })
})
