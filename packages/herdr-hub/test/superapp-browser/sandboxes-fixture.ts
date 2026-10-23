/** The Sandboxes pool from the design's page 14, as the overview route returns it, timed from the server's clock. */
import { SandboxCard, type SandboxesOverview } from "@knpkv/sandbox-pool/host"
import { Schema } from "effect"

const card = Schema.decodeUnknownSync(SandboxCard)
const minute = 60_000
const at = (millis: number): string => new Date(millis).toISOString()

/** One lease that started 3 h 45 min ago and ends in 4 h 15 min; one account free for 1 h 23 min. */
export const sandboxesOverviewFixture = (now: number): SandboxesOverview => ({
  _tag: "Ready",
  sandboxes: [
    card({
      accountId: "999999999990",
      name: "ephemeral-01",
      label: null,
      state: {
        _tag: "Leased",
        holder: "review-runner-02",
        startedAt: at(now - 225 * minute),
        endsAt: at(now + 255 * minute)
      }
    }),
    card({
      accountId: "999999999991",
      name: "ephemeral-02",
      label: null,
      state: { _tag: "Available", lastResetAt: at(now - 83 * minute) }
    })
  ],
  badge: { quarantined: 0, stale: false, partial: false, asOf: null },
  spendLimits: null
})
