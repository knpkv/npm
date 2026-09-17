import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { AgentContextFingerprint, AgentContextSnapshot } from "../src/index.js"

describe("AgentContextSnapshot", () => {
  it("accepts a release-independent context", () => {
    const decoded = Schema.decodeUnknownSync(AgentContextSnapshot)({
      workspaceId: "workspace-1",
      releaseId: null,
      subjectRevision: "revision-1",
      fingerprint: AgentContextFingerprint.make(`sha256:${"a".repeat(64)}`)
    })

    expect(decoded.releaseId).toBeNull()
  })
})
