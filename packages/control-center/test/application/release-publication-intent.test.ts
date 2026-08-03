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

  it("rejects negated publication commands instead of reversing the owner's refusal", () => {
    assert.strictEqual(detectReleasePublicationIntent("Do not create a Jira release version"), undefined)
    assert.strictEqual(detectReleasePublicationIntent("Never publish a Confluence page"), undefined)
    assert.strictEqual(detectReleasePublicationIntent("I won't make the Jira release artifact"), undefined)
    assert.deepStrictEqual(detectReleasePublicationIntent("Create a Jira release version"), { provider: "jira" })
  })

  it("requires a direct imperative instead of executing quoted or descriptive text", () => {
    assert.strictEqual(
      detectReleasePublicationIntent(
        "Summarize the runbook sentence: \"Create a Jira release version after approval.\""
      ),
      undefined
    )
    assert.strictEqual(
      detectReleasePublicationIntent("Create a summary of \"Publish the Confluence release page.\""),
      undefined
    )
    assert.deepStrictEqual(detectReleasePublicationIntent("Please publish the Confluence release page"), {
      provider: "confluence"
    })
  })

  it("rejects qualified publication commands instead of silently discarding their conditions", () => {
    assert.strictEqual(
      detectReleasePublicationIntent("Create a Jira release version after Jane approves it"),
      undefined
    )
    assert.strictEqual(detectReleasePublicationIntent("Create a Jira release version tomorrow"), undefined)
    assert.strictEqual(
      detectReleasePublicationIntent("Publish the Confluence release page if the checks pass"),
      undefined
    )
    assert.deepStrictEqual(detectReleasePublicationIntent("Relay: create a Jira release version!"), {
      provider: "jira"
    })
  })
})
