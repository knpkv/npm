import { CodeDiffContentQuery, CodeDiffContentResult, CodeReviewResult } from "@knpkv/codecommit-web/host"
import { Schema } from "effect"
import { expect, it } from "vitest"
import {
  CODE_OTHER_REF,
  CODE_REF,
  CODE_REVIEW_STATES,
  codeContentFixture,
  codeReviewFixture
} from "./superapp-browser/code-fixture.js"

/** A missing/invalid fixture is setup failure, never a native prevention red. */
for (const state of CODE_REVIEW_STATES) {
  for (const ref of [CODE_REF, CODE_OTHER_REF]) {
    it(`decodes the saved ${state} review for synthetic ref ${ref}`, () => {
      const value = codeReviewFixture(ref, 1_700_000_000_000, state)
      expect(value).not.toBeNull()
      expect(Schema.is(CodeReviewResult)(value)).toBe(true)
      if (value?._tag === "Ready") {
        expect(value.reading.workspace.identity.subjectId).toBe(ref)
        const query = Schema.decodeUnknownSync(CodeDiffContentQuery)(
          new URLSearchParams({
            ref,
            revisionId: value.reading.diff.revisionId,
            baseCommit: value.reading.diff.baseCommit,
            headCommit: value.reading.diff.headCommit,
            fileIndex: "1"
          })
        )
        const content = codeContentFixture(query.fileIndex, query.revisionId, state)
        expect(Schema.is(CodeDiffContentResult)(content)).toBe(true)
        if (content._tag === "Ready") {
          expect(content.content.fileIndex).toBe(1)
          expect(content.content.revisionId).toBe(value.reading.workspace.identity.revisionId)
        }
      }
    })
  }
}
it("unknown opaque refs have no synthetic reading", () => {
  expect(codeReviewFixture("00000000-0000-4000-8000-000000000099", 1_700_000_000_000, "normal")).toBeNull()
})
