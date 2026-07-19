import { describe, expect, it } from "vitest"

import {
  renderWorkspaceEntityOwnersQuery,
  renderWorkspaceEntityRelationshipsQuery,
  renderWorkspaceEntityReleasesQuery
} from "../src/index.js"

const entity = { entityId: "entity-a", workspaceId: "workspace-a" }

describe("canonical workspace entity queries", () => {
  it("keeps ownership and graph reads scoped to the exact workspace entity", () => {
    const owners = renderWorkspaceEntityOwnersQuery(entity)
    const relationships = renderWorkspaceEntityRelationshipsQuery({ ...entity, limit: 101 })
    const releases = renderWorkspaceEntityReleasesQuery(entity)

    expect(owners.sql).toContain("role_assignments")
    expect(owners.sql).toContain("persons")
    expect(owners.params).toContain("workspace-a")
    expect(owners.params).toContain("entity-a")
    expect(relationships.sql).toContain("relationship_heads")
    expect(relationships.sql).toContain("delivery_nodes")
    expect(relationships.params).toContain(101)
    expect(releases.sql).toContain("distinct")
    expect(releases.params).toContain("rejected")
    expect(releases.params).toContain("superseded")
  })
})
