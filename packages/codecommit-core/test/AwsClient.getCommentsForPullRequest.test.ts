import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { decodeCommentLocation } from "../src/AwsClient/getCommentsForPullRequest.js"
import { decodeCommentLocations } from "../src/CacheService/repos/commentLocations.js"
import { encodeCommentLocations } from "../src/Domain.js"

describe("getCommentsForPullRequest", () => {
  it.effect("preserves provider before and after sides on decoded line-comment groups", () =>
    Effect.gen(function*() {
      const decode = (relativeFileVersion: "BEFORE" | "AFTER") =>
        decodeCommentLocation({
          beforeCommitId: "a".repeat(40),
          afterCommitId: "b".repeat(40),
          location: { filePath: "src/auth.ts", filePosition: 42, relativeFileVersion },
          comments: [{ commentId: `comment-${relativeFileVersion}`, content: "Review this line" }]
        })

      const before = yield* decode("BEFORE")
      const after = yield* decode("AFTER")

      expect(before.relativeFileVersion).toBe("BEFORE")
      expect(after.relativeFileVersion).toBe("AFTER")
      expect(before.comments[0]?.root.lineNumber).toBe(42)
      expect(after.comments[0]?.root.lineNumber).toBe(42)
    }))

  it.effect("preserves the provider side through cached comment-location JSON", () =>
    Effect.gen(function*() {
      const encoded = encodeCommentLocations([{
        afterCommitId: "b".repeat(40),
        beforeCommitId: "a".repeat(40),
        comments: [],
        filePath: "src/auth.ts",
        relativeFileVersion: "BEFORE"
      }])
      const decoded = yield* decodeCommentLocations(JSON.stringify(encoded))

      expect(decoded[0]?.relativeFileVersion).toBe("BEFORE")
    }))
})
