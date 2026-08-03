import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { PluginConnectionId, ReleaseId, WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import {
  confluencePublicationRequestMatchesHistory,
  loadLatestConfluenceReleasePublication
} from "../../src/server/application/releasePublicationSubmissions.js"
import {
  GovernedActionReleasePublicationReadInput
} from "../../src/server/persistence/repositories/governed-action/contract.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-520000000001")
const RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-520000000002")
const PLUGIN_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-520000000003")
const PUBLISHED_AT = Schema.decodeUnknownSync(UtcTimestamp)("2026-08-03T08:00:00.000Z")

describe("release publication submissions", () => {
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
        publishedAt: PUBLISHED_AT
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
        publishedAt: PUBLISHED_AT
      }
    }
    assert.isTrue(confluencePublicationRequestMatchesHistory({
      pageId: "42",
      expectedVersion: 2
    }, history))
    assert.isFalse(confluencePublicationRequestMatchesHistory({
      pageId: "99",
      expectedVersion: 2
    }, history))
    assert.isFalse(confluencePublicationRequestMatchesHistory({
      pageId: "42",
      expectedVersion: 3
    }, history))
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
