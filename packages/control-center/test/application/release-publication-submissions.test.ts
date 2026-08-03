import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { ReleaseId, WorkspaceId } from "../../src/domain/identifiers.js"
import { loadLatestConfluenceReleasePublication } from "../../src/server/application/releasePublicationSubmissions.js"
import {
  GovernedActionReleasePublicationReadInput
} from "../../src/server/persistence/repositories/governed-action/contract.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-520000000001")
const RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-520000000002")

describe("release publication submissions", () => {
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
