import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { ReleaseDeliveryGraphInspection } from "../../src/api/deliveryGraph.js"
import { GovernedActionEnvelopeDigest } from "../../src/domain/governedAction/index.js"
import { GovernedActionId, PluginConnectionId, ReleaseId, WorkspaceId } from "../../src/domain/identifiers.js"
import { releasePipelineApprovalReadiness } from "../../src/domain/releasePipelineApproval.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import {
  confluenceEntityPublicationContext,
  confluencePublicationRequestContext,
  confluencePublicationRequestMatchesHistory,
  jiraPublicationPayloadWithinLimits,
  loadLatestConfluenceReleasePublication,
  releaseConfluenceTaskReadiness
} from "../../src/server/application/releasePublicationSubmissions.js"
import {
  GovernedActionReleasePublicationReadInput
} from "../../src/server/persistence/repositories/governed-action/contract.js"
import { releaseWorksetFixture } from "../fixtures/releaseWorkset.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-520000000001")
const RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-520000000002")
const PLUGIN_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-520000000003")
const PUBLICATION_ACTION_ID = GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-520000000004")
const PUBLISHED_AT = Schema.decodeUnknownSync(UtcTimestamp)("2026-08-03T08:00:00.000Z")
const SOURCE_REVISION_DIGEST = GovernedActionEnvelopeDigest.make(`sha256:${"a".repeat(64)}`)

describe("release publication submissions", () => {
  it("blocks release publication until every directly related Confluence task is complete", () => {
    const page = releaseWorksetFixture.entityProjections.find(
      ({ projection }) => projection.details._tag === "page"
    )
    if (page?.projection.details._tag !== "page") throw new Error("Expected a Confluence page fixture")
    const withTasks: ReleaseDeliveryGraphInspection = {
      ...releaseWorksetFixture,
      entityProjections: releaseWorksetFixture.entityProjections.map((entry) =>
        entry.projection.entityId === page.projection.entityId
          ? {
            ...entry,
            projection: {
              ...page.projection,
              details: {
                ...page.projection.details,
                contentState: "loaded",
                content: {
                  representation: "safe-markdown",
                  markdown: "- [x] Test report\n- [ ] Verbal risk assessment"
                }
              }
            }
          }
          : entry
      )
    }

    assert.deepStrictEqual(releaseConfluenceTaskReadiness(withTasks), {
      completed: 1,
      outstanding: 1,
      ready: false,
      total: 2,
      unverifiablePages: 0
    })
    const completed: ReleaseDeliveryGraphInspection = {
      ...withTasks,
      entityProjections: withTasks.entityProjections.map((entry) =>
        entry.projection.entityId === page.projection.entityId && entry.projection.details._tag === "page"
          ? {
            ...entry,
            projection: {
              ...entry.projection,
              details: {
                ...entry.projection.details,
                content: {
                  representation: "safe-markdown",
                  markdown: "- [x] Test report\n- [x] Verbal risk assessment"
                }
              }
            }
          }
          : entry
      )
    }
    assert.isTrue(releaseConfluenceTaskReadiness(completed).ready)
  })

  it("does not claim readiness from a truncated or lazy Confluence release slice", () => {
    const page = releaseWorksetFixture.entityProjections.find(
      ({ projection }) => projection.details._tag === "page"
    )
    if (page?.projection.details._tag !== "page") throw new Error("Expected a Confluence page fixture")
    const lazy: ReleaseDeliveryGraphInspection = {
      ...releaseWorksetFixture,
      entityProjections: releaseWorksetFixture.entityProjections.map((entry) =>
        entry.projection.entityId === page.projection.entityId
          ? {
            ...entry,
            projection: {
              ...page.projection,
              details: { ...page.projection.details, contentState: "lazy", content: null }
            }
          }
          : entry
      )
    }

    const lazyReadiness = releaseConfluenceTaskReadiness(lazy)
    assert.isFalse(lazyReadiness.ready)
    assert.strictEqual(lazyReadiness.unverifiablePages, 1)
    assert.isFalse(releaseConfluenceTaskReadiness({ ...releaseWorksetFixture, truncated: true }).ready)
  })

  it("requires every affected pipeline to wait at its release approval gate", () => {
    assert.deepStrictEqual(releasePipelineApprovalReadiness(releaseWorksetFixture), {
      affected: 1,
      gates: [{
        entityId: releaseWorksetFixture.entityProjections.find(
          ({ projection }) => projection.details._tag === "pipeline-execution"
        )?.projection.entityId,
        pipelineName: "payments-main",
        state: "waiting"
      }],
      missing: 0,
      notWaiting: 0,
      ready: true,
      unverifiablePipelines: 0,
      waiting: 1
    })
    const withoutGate: ReleaseDeliveryGraphInspection = {
      ...releaseWorksetFixture,
      entityProjections: releaseWorksetFixture.entityProjections.map((entry) =>
        entry.projection.details._tag === "pipeline-execution"
          ? {
            ...entry,
            projection: {
              ...entry.projection,
              details: {
                ...entry.projection.details,
                stages: [{ name: "Deploy", status: "running", actionCount: 1, actionsTruncated: false }]
              }
            }
          }
          : entry
      )
    }
    const passedGate: ReleaseDeliveryGraphInspection = {
      ...releaseWorksetFixture,
      entityProjections: releaseWorksetFixture.entityProjections.map((entry) =>
        entry.projection.details._tag === "pipeline-execution"
          ? {
            ...entry,
            projection: {
              ...entry.projection,
              details: {
                ...entry.projection.details,
                stages: [{ name: "Approval", status: "succeeded", actionCount: 1, actionsTruncated: false }]
              }
            }
          }
          : entry
      )
    }

    assert.deepStrictEqual(releasePipelineApprovalReadiness(withoutGate).gates[0]?.state, "missing")
    assert.isFalse(releasePipelineApprovalReadiness(withoutGate).ready)
    assert.deepStrictEqual(releasePipelineApprovalReadiness(passedGate).gates[0]?.state, "not-waiting")
    assert.isFalse(releasePipelineApprovalReadiness(passedGate).ready)
  })

  it("rejects Jira publication payloads beyond provider character and UTF-8 byte limits", () => {
    assert.isTrue(jiraPublicationPayloadWithinLimits("a".repeat(255), "é".repeat(8_192)))
    assert.isFalse(jiraPublicationPayloadWithinLimits("a".repeat(256), "Release notes"))
    assert.isFalse(jiraPublicationPayloadWithinLimits("Release", "é".repeat(8_193)))
  })

  it("allows Confluence creation only when indexed history proves the release was never published", () => {
    assert.isTrue(confluencePublicationRequestMatchesHistory({}, {
      hasBlockingPublication: false,
      latestReference: null
    }))
    assert.isFalse(confluencePublicationRequestMatchesHistory({}, {
      hasBlockingPublication: true,
      latestReference: {
        pageId: "42",
        pageVersion: 2,
        pluginConnectionId: PLUGIN_CONNECTION_ID,
        publicationActionId: PUBLICATION_ACTION_ID,
        publishedAt: PUBLISHED_AT,
        sourceRevisionDigest: SOURCE_REVISION_DIGEST
      }
    }))
    assert.isFalse(confluencePublicationRequestMatchesHistory({}, {
      hasBlockingPublication: true,
      latestReference: null
    }))
  })

  it("allows a corrected Confluence retry after confirmed no-write history stops blocking", () => {
    assert.isTrue(confluencePublicationRequestMatchesHistory({}, {
      hasBlockingPublication: false,
      latestReference: null
    }))
  })

  it("allows Confluence updates only when the page identity and version match history", () => {
    const history = {
      hasBlockingPublication: true,
      latestReference: {
        pageId: "42",
        pageVersion: 2,
        pluginConnectionId: PLUGIN_CONNECTION_ID,
        publicationActionId: PUBLICATION_ACTION_ID,
        publishedAt: PUBLISHED_AT,
        sourceRevisionDigest: SOURCE_REVISION_DIGEST
      }
    }
    assert.isTrue(confluencePublicationRequestMatchesHistory({
      publicationActionId: PUBLICATION_ACTION_ID
    }, history))
    assert.isFalse(confluencePublicationRequestMatchesHistory({
      publicationActionId: GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-520000000005")
    }, history))
  })

  it("adopts any explicitly selected related page while preserving a matching page predecessor", () => {
    const target = {
      pageId: "42",
      pageVersion: 7,
      pluginConnectionId: PLUGIN_CONNECTION_ID
    }
    assert.deepStrictEqual(
      confluenceEntityPublicationContext(
        { hasBlockingPublication: false, latestReference: null },
        target
      ),
      {
        historyMatches: true,
        predecessorPublicationActionId: null,
        publication: target
      }
    )
    assert.isTrue(
      confluenceEntityPublicationContext(
        {
          hasBlockingPublication: true,
          latestReference: {
            ...target,
            pageVersion: 6,
            publicationActionId: PUBLICATION_ACTION_ID,
            publishedAt: PUBLISHED_AT,
            sourceRevisionDigest: SOURCE_REVISION_DIGEST
          }
        },
        target
      ).historyMatches
    )
    assert.deepStrictEqual(
      confluenceEntityPublicationContext(
        {
          hasBlockingPublication: true,
          latestReference: {
            ...target,
            pageId: "99",
            publicationActionId: PUBLICATION_ACTION_ID,
            publishedAt: PUBLISHED_AT,
            sourceRevisionDigest: SOURCE_REVISION_DIGEST
          }
        },
        target
      ),
      {
        historyMatches: true,
        predecessorPublicationActionId: null,
        publication: target
      }
    )
  })

  it("preserves a predecessor reference long enough to find an already-created update", () => {
    const successorActionId = GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-520000000005")
    const predecessor = {
      pageId: "42",
      pageVersion: 2,
      pluginConnectionId: PLUGIN_CONNECTION_ID,
      publicationActionId: PUBLICATION_ACTION_ID,
      publishedAt: PUBLISHED_AT,
      sourceRevisionDigest: SOURCE_REVISION_DIGEST
    }
    const successor = {
      ...predecessor,
      pageVersion: 3,
      publicationActionId: successorActionId
    }

    assert.deepStrictEqual(
      confluencePublicationRequestContext(
        { publicationActionId: PUBLICATION_ACTION_ID },
        { hasBlockingPublication: true, latestReference: successor },
        predecessor
      ),
      {
        historyMatches: false,
        publication: predecessor
      }
    )
  })

  it.effect("uses one indexed release-history read for a Confluence update target", () =>
    Effect.gen(function*() {
      const calls: Array<GovernedActionReleasePublicationReadInput> = []
      const published = yield* loadLatestConfluenceReleasePublication(
        {
          readLatestTerminalReleasePublications: (input) =>
            Effect.sync(() => {
              calls.push(Schema.decodeUnknownSync(GovernedActionReleasePublicationReadInput)(input))
              return []
            })
        },
        WORKSPACE_ID,
        RELEASE_ID
      )

      assert.isNull(published)
      assert.deepStrictEqual(calls, [{
        workspaceId: WORKSPACE_ID,
        providerId: "confluence",
        releaseIds: [RELEASE_ID]
      }])
    }))
})
