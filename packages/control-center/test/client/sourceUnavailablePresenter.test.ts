import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { presentPortfolio } from "../../src/client/portfolio/presentPortfolio.js"
import { evaluateReleaseFreshnessAt, Freshness, PluginHealth, ReleaseFreshness } from "../../src/domain/freshness.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"

describe("source unavailable presentation", () => {
  it.effect("shows the server's failure start, precise class, retry, and last good read", () =>
    Effect.gen(function*() {
      const snapshot = makePortfolioSnapshot()
      const release = snapshot.releases[0]
      const plugin = snapshot.plugins[0]
      expect(release).toBeDefined()
      expect(plugin).toBeDefined()
      if (release === undefined || plugin === undefined) return
      const checkedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-14T10:15:00.000Z")
      const health = Schema.decodeUnknownSync(PluginHealth)({
        _tag: "unavailable",
        checkedAt: "2026-07-14T10:15:00.000Z",
        failureClass: "rate-limit",
        retryAt: "2026-07-14T10:20:00.000Z",
        safeMessage: "Fixture request limit reached."
      })
      const freshness = yield* evaluateReleaseFreshnessAt(
        Schema.decodeUnknownSync(Schema.toType(Freshness))(release.freshness),
        checkedAt,
        [{ pluginConnectionId: plugin.pluginConnectionId, health, unavailableSince: checkedAt }]
      )
      const presented = presentPortfolio({
        ...snapshot,
        releases: [{ ...release, freshness }],
        plugins: [{ ...plugin, health }]
      }).releases[0]
      expect(presented?.source.freshness).toBe("unavailable")
      expect(presented?.source.warning).toBe(
        "Source unavailable since 14 Jul, 10:15 UTC · rate-limited, retry 14 Jul, 10:20 UTC · last read 14 Jul, 10:03 UTC."
      )
      expect(freshness._tag).toBe("source-unavailable")
      if (freshness._tag !== "source-unavailable") return
      const legacy = presentPortfolio({
        ...snapshot,
        releases: [{
          ...release,
          freshness: Schema.decodeUnknownSync(Schema.toType(ReleaseFreshness))({
            ...freshness,
            unavailableSince: null,
            failedSources: freshness.failedSources.map((source) => ({ ...source, unavailableSince: null }))
          })
        }],
        plugins: [{ ...plugin, health }]
      }).releases[0]
      expect(legacy?.source.warning).toBe(
        "Source unavailable · last checked 14 Jul, 10:15 UTC · rate-limited, retry 14 Jul, 10:20 UTC · last read 14 Jul, 10:03 UTC."
      )
    }))
})
