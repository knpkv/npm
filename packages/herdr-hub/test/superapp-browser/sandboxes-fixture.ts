/** The Sandboxes pool from the design's page 14, as the overview route returns it. */
import { SandboxCard, type SandboxesOverview } from "@knpkv/sandbox-pool/host"
import { Schema } from "effect"

const card = Schema.decodeUnknownSync(SandboxCard)

export const sandboxesOverviewFixture: SandboxesOverview = {
  _tag: "Ready",
  sandboxes: [
    card({
      accountId: "999999999990",
      name: "ephemeral-01",
      label: null,
      state: {
        _tag: "Leased",
        holder: "review-runner-02",
        startedAt: "2026-10-17T09:20:00.000Z",
        endsAt: "2026-10-17T17:20:00.000Z"
      }
    }),
    card({
      accountId: "999999999991",
      name: "ephemeral-02",
      label: null,
      state: { _tag: "Available", lastResetAt: "2026-10-17T11:42:00.000Z" }
    })
  ],
  badge: { quarantined: 0, stale: false, partial: false, asOf: null }
}
