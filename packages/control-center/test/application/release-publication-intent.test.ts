import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { detectReleasePublicationIntent } from "../../src/server/application/releasePublicationIntent.js"

describe("release publication intent", () => {
  it("recognizes explicit Jira and Confluence publication requests", () => {
    assert.deepStrictEqual(detectReleasePublicationIntent("Create Confluence page for release"), {
      provider: "confluence"
    })
    assert.deepStrictEqual(detectReleasePublicationIntent("publish the Jira release version"), {
      provider: "jira"
    })
  })

  it("does not turn informational questions or unrelated requests into writes", () => {
    assert.strictEqual(detectReleasePublicationIntent("How do I create a Confluence page?"), undefined)
    assert.strictEqual(detectReleasePublicationIntent("Review the Jira release blockers"), undefined)
    assert.strictEqual(detectReleasePublicationIntent("Create a release note"), undefined)
  })
})
