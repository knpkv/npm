import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"

import {
  classifyClockifyActionSubmissionFailure,
  clockifyActionRuntimeAuthorityMatches
} from "../../src/server/application/clockifyActionSubmissions.js"
import { PluginConflictFailure, PluginOutageFailure } from "../../src/server/plugins/failures.js"
import { makeAuthorizedGovernedActionEnvelope } from "../governance/fixtures/authorizedGovernedAction.js"

describe("Clockify action submissions", () => {
  it("preserves expected provider conflicts while retaining outage classification", () => {
    assert.strictEqual(
      classifyClockifyActionSubmissionFailure(
        new PluginConflictFailure({
          operation: "clockify-propose-action",
          diagnosticCode: "clockify-time-entry-revision-conflict"
        })
      ),
      "conflict"
    )
    assert.strictEqual(
      classifyClockifyActionSubmissionFailure(
        new PluginOutageFailure({ operation: "clockify-propose-action" })
      ),
      "unavailable"
    )
  })

  it.effect("accepts only an idempotent retry from the exact persisted runtime generation", () =>
    Effect.gen(function*() {
      const envelope = yield* makeAuthorizedGovernedActionEnvelope({
        pluginConnectionAuthorityDigest: `sha256:${"a".repeat(64)}`,
        variant: "clockify-approval"
      })

      assert.isTrue(
        clockifyActionRuntimeAuthorityMatches(
          envelope,
          Number(envelope.pluginConnectionRevision),
          envelope.pluginConnectionAuthorityDigest
        )
      )
      assert.isFalse(
        clockifyActionRuntimeAuthorityMatches(
          envelope,
          Number(envelope.pluginConnectionRevision) + 1,
          envelope.pluginConnectionAuthorityDigest
        )
      )
      assert.isFalse(
        clockifyActionRuntimeAuthorityMatches(
          envelope,
          Number(envelope.pluginConnectionRevision),
          `sha256:${"b".repeat(64)}`
        )
      )
    }).pipe(Effect.provide(NodeServices.layer)))
})
