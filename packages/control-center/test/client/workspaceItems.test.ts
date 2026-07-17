import { describe, expect, it } from "vitest"

import { filterWorkspaceItems } from "../../src/client/items/ItemsPage.js"
import { presentWorkspaceItems } from "../../src/client/items/presentWorkspaceItems.js"
import { releaseWorksetFixture, WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"

const items = presentWorkspaceItems(WORKSET_WORKSPACE_ID, [releaseWorksetFixture, releaseWorksetFixture])

describe("workspace items", () => {
  it("deduplicates normalized entities across release slices and maps their services", () => {
    expect(items).toHaveLength(10)
    expect(items.filter(({ service }) => service === "jira")).toHaveLength(6)
    expect(items.filter(({ service }) => service === "codecommit")).toHaveLength(2)
    expect(items.filter(({ service }) => service === "codepipeline")).toHaveLength(1)
    expect(items.filter(({ service }) => service === "confluence")).toHaveLength(1)

    const issue = items.find(({ key }) => key === "OPS-428")
    if (issue === undefined) throw new Error("Expected OPS-428 in the workspace item fixture")
    expect(issue).toMatchObject({
      kind: "issue",
      owner: "Unassigned",
      status: "In review",
      statusGroup: "active",
      title: "Review payment capture safeguards",
      tone: "progress"
    })
    expect(issue.href).toBe(
      `/w/${WORKSET_WORKSPACE_ID}/releases/${releaseWorksetFixture.releaseId}?object=${issue.entityId}#release-work`
    )
  })

  it("combines text, service, type, and status filters without substituting results", () => {
    expect(
      filterWorkspaceItems(items, { query: "ops-428", service: "all", status: "all", type: "all" }).map(
        ({ key }) => key
      )
    ).toEqual(["OPS-428"])

    expect(
      filterWorkspaceItems(items, { query: "", service: "codecommit", status: "all", type: "all" })
    ).toHaveLength(2)

    expect(
      filterWorkspaceItems(items, { query: "", service: "all", status: "failed", type: "issue" }).map(
        ({ key }) => key
      )
    ).toEqual(["OPS-433"])

    expect(
      filterWorkspaceItems(items, { query: "does-not-exist", service: "all", status: "all", type: "all" })
    ).toEqual([])
  })
})
