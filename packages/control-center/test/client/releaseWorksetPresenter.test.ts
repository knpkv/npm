import type { RlyStage } from "@knpkv/rly/patterns"
import { describe, expect, it } from "vitest"

import type { ReleaseDeliveryGraphInspection } from "../../src/api/deliveryGraph.js"
import { presentReleaseWorkset } from "../../src/client/releases/presentReleaseWorkset.js"
import { releaseWorksetFixture, WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"

const stages: ReadonlyArray<RlyStage> = [
  { id: "build", name: "Build", state: "Passed", tone: "positive" },
  { id: "verify", name: "Verify", state: "Running", tone: "progress" },
  { id: "production", name: "Production", state: "Waiting", tone: "neutral" }
]

describe("release workset presenter", () => {
  it("keeps all six Jira items in one dimension and groups five under exactly two PRs", () => {
    const workset = presentReleaseWorkset(releaseWorksetFixture, WORKSET_WORKSPACE_ID, stages)

    expect(workset.jiraItems.map(({ key }) => key)).toEqual([
      "OPS-428",
      "OPS-429",
      "OPS-430",
      "OPS-431",
      "OPS-432",
      "OPS-433"
    ])
    expect(workset.pullRequestGroups).toHaveLength(2)
    expect(workset.pullRequestGroups.map(({ linkedJiraKeys }) => linkedJiraKeys)).toEqual([
      ["OPS-428", "OPS-429", "OPS-430"],
      ["OPS-431", "OPS-432"]
    ])
    expect(new Set(workset.pullRequestGroups.flatMap(({ linkedJiraKeys }) => linkedJiraKeys))).toHaveLength(5)
  })

  it("keeps the unlinked item, pipeline stages, runbook, and navigable object identities explicit", () => {
    const workset = presentReleaseWorkset(releaseWorksetFixture, WORKSET_WORKSPACE_ID, stages)

    expect(workset.gaps).toEqual([expect.objectContaining({
      label: "OPS-433 has no CodeCommit pull request",
      reason: "Implementation evidence has not been linked.",
      service: "codecommit"
    })])
    expect(workset.pipelines).toEqual([expect.objectContaining({
      reference: "payments-main/1842",
      state: "Running",
      stages
    })])
    expect(workset.runbooks).toEqual([expect.objectContaining({
      reference: "PAY/RUNBOOK-12",
      state: "current"
    })])
    for (const item of [...workset.jiraItems, ...workset.pullRequestGroups, ...workset.pipelines]) {
      expect(item.href).toMatch(/^\/w\/[^/]+\/releases\/[^/?]+\?object=[^#]+#release-work$/u)
    }
    expect(workset.runbooks[0]?.href).toMatch(/#release-work$/u)
  })

  it("maps the OPS-428 review lifecycle and provider states without copying portfolio labels", () => {
    const workset = presentReleaseWorkset(releaseWorksetFixture, WORKSET_WORKSPACE_ID, stages)

    expect(workset.jiraItems[0]).toEqual(expect.objectContaining({
      key: "OPS-428",
      state: "In review",
      tone: "progress"
    }))
    expect(workset.pullRequestGroups.map(({ state, tone }) => ({ state, tone }))).toEqual([
      { state: "Review requested", tone: "progress" },
      { state: "Approved", tone: "positive" }
    ])
    expect(workset.truncated).toBe(false)
  })

  it("keeps a missing resolved PR-to-Jira edge out of linked work while retaining its gap", () => {
    const firstVerified = releaseWorksetFixture.relationships.find(({ lifecycle }) => lifecycle._tag === "verified")
    const missing = releaseWorksetFixture.relationships.find(({ lifecycle }) => lifecycle._tag === "missing")
    if (firstVerified === undefined || missing === undefined) {
      throw new Error("Expected verified and missing fixture edges")
    }
    const inspection: ReleaseDeliveryGraphInspection = {
      ...releaseWorksetFixture,
      relationships: releaseWorksetFixture.relationships.map((relationship) =>
        relationship.relationshipId === missing.relationshipId
          ? { ...relationship, sourceNodeId: firstVerified.sourceNodeId }
          : relationship
      )
    }

    const workset = presentReleaseWorkset(inspection, WORKSET_WORKSPACE_ID, stages)

    expect(workset.pullRequestGroups[0]?.linkedJiraKeys).toEqual(["OPS-428", "OPS-429", "OPS-430"])
    expect(workset.gaps).toEqual([expect.objectContaining({ label: "OPS-433 has no CodeCommit pull request" })])
  })
})
