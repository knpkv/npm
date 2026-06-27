import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { parseSyncBaseline, serializeSyncBaseline } from "../src/internal/sync/baseline.js"
import { parseWorkspaceConfig, serializeWorkspaceConfig } from "../src/internal/sync/config.js"
import { makeEmptyManifest, parseSyncManifest, serializeSyncManifest } from "../src/internal/sync/manifest.js"
import type { SyncBaseline } from "../src/internal/sync/types.js"

const runExit = <A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> => Effect.runPromiseExit(effect)

describe("Jira Markdown Sync local data", () => {
  describe("WorkspaceConfig", () => {
    it("parses defaults and requested custom fields", async () => {
      const result = await Effect.runPromise(parseWorkspaceConfig(
        "config.yaml",
        `
siteUrl: https://example.atlassian.net
customFields:
  - displayName: Security & Compliance Impact
    shape: singleSelect
  - displayName: Reviewer
    fieldId: customfield_12345
    shape: user
`
      ))

      expect(result.documentsDir).toBe("issues")
      expect(result.customFields).toHaveLength(2)
      expect(result.customFields[1]).toMatchObject({
        displayName: "Reviewer",
        fieldId: "customfield_12345",
        shape: "user"
      })
    })

    it("rejects unsupported field shapes", async () => {
      const result = await runExit(parseWorkspaceConfig(
        "config.yaml",
        `
siteUrl: https://example.atlassian.net
customFields:
  - displayName: Mystery
    shape: unsupported
`
      ))

      expect(Exit.isFailure(result)).toBe(true)
    })

    it("rejects duplicate display names without field ids", async () => {
      const result = await runExit(parseWorkspaceConfig(
        "config.yaml",
        `
siteUrl: https://example.atlassian.net
customFields:
  - displayName: Reviewer
    shape: user
  - displayName: Reviewer
    shape: user
`
      ))

      expect(Exit.isFailure(result)).toBe(true)
    })

    it("allows duplicate display names when field ids disambiguate", async () => {
      const config = await Effect.runPromise(parseWorkspaceConfig(
        "config.yaml",
        `
siteUrl: https://example.atlassian.net
customFields:
  - displayName: Reviewer
    fieldId: customfield_1
    shape: user
  - displayName: Reviewer
    fieldId: customfield_2
    shape: user
`
      ))

      expect(config.customFields).toHaveLength(2)
    })

    it("round-trips YAML serialization", async () => {
      const config = await Effect.runPromise(parseWorkspaceConfig(
        "config.yaml",
        `
siteUrl: https://example.atlassian.net
documentsDir: issue-docs
customFields: []
`
      ))

      const parsed = await Effect.runPromise(parseWorkspaceConfig("config.yaml", serializeWorkspaceConfig(config)))
      expect(parsed).toEqual(config)
    })
  })

  describe("SyncManifest", () => {
    it("round-trips an empty manifest", async () => {
      const manifest = makeEmptyManifest("https://example.atlassian.net")
      const parsed = await Effect.runPromise(parseSyncManifest("manifest.json", serializeSyncManifest(manifest)))
      expect(parsed).toEqual(manifest)
    })
  })

  describe("SyncBaseline", () => {
    const baseline: SyncBaseline = {
      version: 1,
      issueId: "100123",
      issueKey: "PROJ-123",
      fields: {
        summary: "Fix checkout copy",
        description: "Editable description",
        labels: ["checkout", "copy"],
        customFields: {
          "Security & Compliance Impact": {
            fieldId: "customfield_10001",
            displayName: "Security & Compliance Impact",
            shape: "singleSelect",
            value: { id: "10423", value: "Low" }
          }
        }
      },
      comments: [{ id: "20001" }]
    }

    it("round-trips baseline JSON", async () => {
      const parsed = await Effect.runPromise(parseSyncBaseline("100123.json", serializeSyncBaseline(baseline)))
      expect(parsed).toEqual(baseline)
    })

    it("rejects corrupt baseline JSON", async () => {
      const result = await runExit(parseSyncBaseline("100123.json", "{nope"))
      expect(Exit.isFailure(result)).toBe(true)
    })
  })
})
