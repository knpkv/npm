import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { GovernedActionEnvelopeDigest } from "../../src/domain/governedAction/index.js"
import { GovernedActionId, PluginConnectionId, ReleaseId, WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import {
  confluencePublicationRequestContext,
  confluencePublicationRequestMatchesHistory,
  jiraPublicationPayloadWithinLimits,
  loadLatestConfluenceReleasePublication
} from "../../src/server/application/releasePublicationSubmissions.js"
import {
  GovernedActionReleasePublicationReadInput
} from "../../src/server/persistence/repositories/governed-action/contract.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-520000000001")
const RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-520000000002")
const PLUGIN_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-520000000003")
const PUBLICATION_ACTION_ID = GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-520000000004")
const PUBLISHED_AT = Schema.decodeUnknownSync(UtcTimestamp)("2026-08-03T08:00:00.000Z")
const SOURCE_REVISION_DIGEST = GovernedActionEnvelopeDigest.make(`sha256:${"a".repeat(64)}`)

describe("release publication submissions", () => {
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
