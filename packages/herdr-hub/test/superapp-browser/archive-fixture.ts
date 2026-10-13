/** Schema-checked synthetic closures aligned with the export51 Home archive. */
import { type ConnectAgentHue, ConnectArchivePage } from "@knpkv/herdr-connect/model"
import { Schema } from "effect"

const rows = [
  {
    name: "fix-pins",
    host: "atlas",
    at: "2026-10-11T09:40:00+02:00",
    parent: "coord",
    words: "The pins are applied and the lock file is committed on sandbox-env."
  },
  {
    name: "doc-pass",
    host: "birch",
    at: "2026-10-10T17:12:00+02:00",
    words: "Docs build passes. Two links still point at the old Fleet route."
  },
  { name: "probe-cedar", host: "cedar", at: "2026-10-10T11:05:00+02:00", words: "" },
  {
    name: "tok-audit",
    host: "atlas",
    at: "2026-10-09T16:48:00+02:00",
    words: "Token totals match the provider export for the last seven days."
  },
  {
    name: "rev-tabs",
    host: "birch",
    at: "2026-10-08T14:20:00+02:00",
    parent: "doc-pass",
    words: "Reviewed the tab order; no findings left open."
  },
  {
    name: "pair-css",
    host: "atlas",
    at: "2026-10-06T10:31:00+02:00",
    parent: "tok-audit",
    words: "Moved the shared bar rules into one stylesheet and checked both pages."
  },
  { name: "seed-data", host: "cedar", at: "2026-10-02T08:15:00+02:00", words: "" }
]

// Recorded export families, including its page-wide probing across live, Ready and archived fixtures.
const recordedFamilies = new Map<string, ConnectAgentHue>([
  ["fix-pins", "teal"],
  ["doc-pass", "teal"],
  ["probe-cedar", "sky"],
  ["tok-audit", "amber"],
  ["rev-tabs", "amber"],
  ["pair-css", "sky"],
  ["seed-data", "amber"],
  ["older", "rose"]
])

export const archiveFixture = (older = false): ConnectArchivePage =>
  Schema.decodeUnknownSync(ConnectArchivePage)({
    agents: (older
      ? [{ name: "older", host: "atlas", at: "2026-10-01T09:40:00+02:00", words: "Earlier checks passed." }]
      : rows).map((row) => {
        const agent = {
          host: row.host,
          agentId: `agent-${row.name}`,
          name: row.name,
          kind: "codex",
          state: "done",
          work: "The checks passed.",
          firstSeenAt: Date.parse(row.at) - 60_000,
          closedAt: Date.parse(row.at)
        }
        const hue = recordedFamilies.get(row.name)
        const colored = hue === undefined ? agent : { ...agent, hue }
        const related = "parent" in row
          ? {
            ...colored,
            relationship: { parentAgentId: `agent-${row.parent}`, parentName: row.parent, relation: "delegated" }
          }
          : colored
        return row.words.length === 0
          ? related
          : { ...related, lastWords: { text: row.words, createdAt: Date.parse(row.at) - 1000 } }
      }),
    nextCursor: older
      ? null
      : { host: "cedar", agentId: "agent-seed-data", closedAt: Date.parse("2026-10-02T08:15:00+02:00") }
  }, { onExcessProperty: "error" })
