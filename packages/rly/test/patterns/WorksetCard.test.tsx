// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { LinkProvider, type RlyLinkProps } from "../../src/foundations/LinkProvider.js"
import {
  type RlyWorksetGap,
  type RlyWorksetJiraItem,
  type RlyWorksetPipeline,
  type RlyWorksetPullRequestGroup,
  WorksetCard
} from "../../src/patterns/WorksetCard.js"
import { render } from "../primitives/render.js"

const owner = { id: "avery", name: "Avery Diaz", role: "Release owner" }
const author = { id: "blake", name: "Blake Kim", role: "Pull request author" }
const operator = { id: "casey", name: "Casey Singh", role: "Deployment operator" }
const approver = { id: "devon", name: "Devon O'Rourke", role: "Deployment approver" }

const jiraItems = Array.from({ length: 6 }, (_, index) => ({
  id: `jira-${index + 1}`,
  key: `OPS-${428 + index}`,
  title: `Release requirement ${index + 1}`,
  state: index === 5 ? "Needs link" : "In progress",
  tone: index === 5 ? "caution" : "progress",
  href: `/jira/OPS-${428 + index}`,
  ...(index === 0 ? { owner } : {})
})) satisfies ReadonlyArray<RlyWorksetJiraItem>

const pullRequestGroups = [
  {
    id: "pr-a",
    title: "Checkout and capture",
    reference: "PR-184",
    state: "Ready for review",
    tone: "progress",
    href: "/pull-requests/184",
    linkedJiraKeys: ["OPS-428", "OPS-429", "OPS-430"],
    author
  },
  {
    id: "pr-b",
    title: "Settlement verification",
    reference: "PR-191",
    state: "Approved",
    tone: "positive",
    href: "/pull-requests/191",
    linkedJiraKeys: ["OPS-430", "OPS-431", "OPS-432"]
  }
] satisfies ReadonlyArray<RlyWorksetPullRequestGroup>

const gaps = [
  {
    id: "gap-ops-433",
    label: "OPS-433 has no CodeCommit pull request",
    reason: "Implementation evidence has not been linked.",
    service: "codecommit"
  }
] satisfies ReadonlyArray<RlyWorksetGap>

const pipelines = [
  {
    id: "pipeline-1842",
    title: "Payments production delivery",
    reference: "Execution #1842",
    state: "Verifying",
    tone: "progress",
    href: "/pipelines/1842",
    stages: [
      { id: "build", name: "Build", state: "Passed", tone: "positive" },
      { id: "verify", name: "Verify", state: "Running", tone: "progress" },
      { id: "production", name: "Production", state: "Waiting", tone: "neutral" }
    ],
    operator,
    approver
  }
] satisfies ReadonlyArray<RlyWorksetPipeline>

const commonProps = {
  gaps,
  heading: "Payments release workset",
  jiraItems,
  pipelines,
  pullRequestGroups
}

describe("WorksetCard", () => {
  it("renders one labelled surface with three complete semantic dimensions", () => {
    const card = render(<WorksetCard {...commonProps} />)
    if (card === null) throw new Error("WorksetCard did not render")
    const heading = card.querySelector("h2")
    if (heading === null) throw new Error("WorksetCard heading did not render")
    expect(card.getAttribute("aria-labelledby")).toBe(heading.id)
    expect(card.querySelectorAll(":scope > [class] > [data-rly-workset-dimension]")).toHaveLength(3)
    expect(card.querySelectorAll("[data-rly-workset-jira-id]")).toHaveLength(6)
    expect(card.querySelectorAll("[data-rly-workset-pr-id]")).toHaveLength(2)
    expect(card.querySelectorAll("[data-rly-workset-gap-id]")).toHaveLength(1)
    expect(card.querySelectorAll("[data-rly-workset-pipeline-id]")).toHaveLength(1)
    for (const provider of ["Jira", "CodeCommit", "CodePipeline"]) {
      expect(card.querySelector(`[role='img'][aria-label='${provider}']`)).not.toBeNull()
    }
  })

  it("keeps many-to-many Jira linkage and an explicit missing relationship visible", () => {
    const card = render(<WorksetCard {...commonProps} />)
    expect(card?.querySelectorAll("[data-rly-linked-jira-key='OPS-430']")).toHaveLength(2)
    const gap = card?.querySelector("[data-rly-workset-gap-id='gap-ops-433']")
    expect(gap?.textContent).toContain("OPS-433 has no CodeCommit pull request")
    expect(gap?.textContent).toContain("Implementation evidence has not been linked.")
    expect(gap?.querySelector("a")).toBeNull()
  })

  it("renders links through LinkProvider and preserves named pipeline people and every stage", () => {
    const Bridge = ({ href, ...props }: RlyLinkProps) => <a {...props} data-bridge="" href={`/app${href}`} />
    const card = render(
      <LinkProvider component={Bridge}>
        <WorksetCard {...commonProps} />
      </LinkProvider>
    )
    expect(card?.querySelectorAll("a[data-bridge]")).toHaveLength(9)
    expect(card?.textContent).toContain("Casey Singh")
    expect(card?.textContent).toContain("Deployment operator")
    expect(card?.textContent).toContain("Devon O'Rourke")
    expect(card?.textContent).toContain("Deployment approver")
    expect(card?.querySelectorAll("[data-rly-stage-id]")).toHaveLength(3)
  })

  it("renders zero, one, six, and twenty Jira items without truncation", () => {
    const twenty = Array.from({ length: 20 }, (_, index) => ({
      id: `item-${index + 1}`,
      key: `BULK-${index + 1}`,
      title: `Complete work item ${index + 1}`,
      state: "Queued",
      tone: "neutral"
    })) satisfies ReadonlyArray<RlyWorksetJiraItem>

    for (const count of [0, 1, 6, 20]) {
      const card = render(<WorksetCard {...commonProps} gaps={[]} jiraItems={twenty.slice(0, count)} />)
      expect(card?.querySelectorAll("[data-rly-workset-jira-id]")).toHaveLength(count)
    }
    const empty = render(
      <WorksetCard gaps={[]} heading="Empty workset" jiraItems={[]} pipelines={[]} pullRequestGroups={[]} />
    )
    expect(empty?.textContent).toContain("No Jira work recorded.")
    expect(empty?.textContent).toContain("No pull request groups recorded.")
    expect(empty?.textContent).toContain("No relationship gaps recorded.")
    expect(empty?.textContent).toContain("No pipeline delivery recorded.")
  })

  it("rejects blank presentation fields and duplicate ids within every dimension", () => {
    expect(() => renderToStaticMarkup(<WorksetCard {...commonProps} heading=" " />)).toThrow("WorksetCard heading")
    const firstJira = jiraItems.slice(0, 1)
    const firstPullRequest = pullRequestGroups.slice(0, 1)
    const firstGap = gaps.slice(0, 1)
    const firstPipeline = pipelines.slice(0, 1)
    expect(() =>
      renderToStaticMarkup(<WorksetCard {...commonProps} jiraItems={[...firstJira, ...firstJira]} />)
    ).toThrow("Jira item ids must be unique")
    expect(() =>
      renderToStaticMarkup(
        <WorksetCard {...commonProps} pullRequestGroups={[...firstPullRequest, ...firstPullRequest]} />
      )
    ).toThrow("pull request group ids must be unique")
    expect(() => renderToStaticMarkup(<WorksetCard {...commonProps} gaps={[...firstGap, ...firstGap]} />)).toThrow(
      "gap ids must be unique"
    )
    expect(() =>
      renderToStaticMarkup(<WorksetCard {...commonProps} pipelines={[...firstPipeline, ...firstPipeline]} />)
    ).toThrow("pipeline ids must be unique")

    const blankKey = {
      id: "blank-jira",
      key: " ",
      title: "Blank Jira key",
      state: "Queued",
      tone: "neutral"
    } satisfies RlyWorksetJiraItem
    expect(() => renderToStaticMarkup(<WorksetCard {...commonProps} jiraItems={[blankKey]} />)).toThrow("Jira key")
    const blankLink = {
      id: "blank-pr",
      title: "Blank linked key",
      reference: "PR-BLANK",
      state: "Queued",
      tone: "neutral",
      linkedJiraKeys: [" "]
    } satisfies RlyWorksetPullRequestGroup
    expect(() => renderToStaticMarkup(<WorksetCard {...commonProps} pullRequestGroups={[blankLink]} />)).toThrow(
      "linked Jira key"
    )
  })
})
