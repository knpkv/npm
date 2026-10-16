import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

import { PluginSynchronizationState } from "../../src/api/plugins.js"
import { syncedAtText, syncFailureSentence, syncLine } from "../../src/client/services/syncPresentation.js"

const NOW = new Date("2026-10-08T19:35:00")

const state = (
  result: PluginSynchronizationState["result"],
  extra: Partial<typeof PluginSynchronizationState.Encoded> = {}
) =>
  Schema.decodeUnknownSync(PluginSynchronizationState)({
    pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000171",
    providerId: "codecommit",
    streamKey: "pull-requests",
    lastAttemptAt: null,
    lastSuccessAt: null,
    result,
    pagesCommitted: 0,
    ...extra
  })

describe("sync presentation", () => {
  it("says when the last sync succeeded as relative and clock time, never ISO", () => {
    expect(syncedAtText(new Date("2026-10-08T19:34:40"), NOW)).toBe("Synced just now, 19:34")
    expect(syncedAtText(new Date("2026-10-08T19:33:00"), NOW)).toBe("Synced 2 min ago, 19:33")
    expect(syncedAtText(new Date("2026-10-08T16:05:00"), NOW)).toBe("Synced 3 h ago, 16:05")
    expect(syncedAtText(new Date("2026-10-05T09:00:00"), NOW)).toBe("Synced 5 Oct, 09:00")
  })

  it("names each sync state in the Services vocabulary", () => {
    expect(syncLine(state("queued"), NOW)).toEqual({ label: "First sync queued", tone: "progress" })
    expect(syncLine(state("never"), NOW)).toEqual({ label: "Not synced yet", tone: "neutral" })
    expect(syncLine(state("running"), NOW)).toEqual({ label: "Syncing…", tone: "progress" })
    expect(syncLine(state("synchronized", { lastSuccessAt: "2026-10-08T17:33:00.000Z" }), NOW).tone).toBe("positive")
    expect(syncLine(state("source-unavailable"), NOW)).toEqual({ label: "Sync failed", tone: "critical" })
    expect(syncLine(state("interrupted"), NOW)).toEqual({ label: "Sync failed", tone: "critical" })
  })

  // A failure is a sentence with its fix, never a bare class name.
  it("explains a failed sync with its fix", () => {
    expect(syncFailureSentence(state("source-unavailable", {
      failure: { failureClass: "timeout", safeMessage: "Provider operation timed out." }
    }))).toBe("The provider took too long to answer. Sync again.")
    expect(syncFailureSentence(state("source-unavailable", {
      failure: { failureClass: "rate-limit", safeMessage: "Rate limited." }
    }))).toBe("The provider is limiting requests. Wait a minute, then sync again.")
    expect(syncFailureSentence(state("interrupted"))).toBe("The sync stopped before it finished. Sync again.")
    expect(syncFailureSentence(state("source-unavailable"))).toBe(
      "The provider couldn’t be read. Check the connection, then sync again."
    )
    expect(syncFailureSentence(state("source-unavailable", {
      failure: { failureClass: "authentication", safeMessage: "Provider authentication failed." }
    }))).toBe("The provider refused the account’s credentials. Sign in again or renew them, then sync again.")
    expect(syncFailureSentence(state("synchronized"))).toBeNull()
  })

  // A resource that doesn't exist won't appear by syncing again: name it and point at the connection.
  it("never offers another sync for a configuration failure", () => {
    const failed = state("source-unavailable", {
      failure: {
        failureClass: "configuration",
        safeMessage:
          "The repository wasn’t found in this account and region. Check the repository name or region, then edit the connection."
      }
    })
    expect(syncFailureSentence(failed)).toBe(
      "The repository wasn’t found in this account and region. Check the repository name or region, then edit the connection."
    )
    expect(syncLine(failed, NOW)).toEqual({ label: "Needs correction", tone: "critical" })
  })
})
