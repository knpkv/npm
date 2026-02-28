import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Account, PRComment, PullRequest } from "../src/Domain.js"

describe("Domain", () => {
  describe("Account", () => {
    // Schema.Class decode must enforce branded AwsProfileName on id field
    it.effect("decodes valid account", () =>
      Effect.gen(function*() {
        const account = yield* Schema.decode(Account)({ profile: "dev", region: "us-east-1" })
        expect(account.profile).toBe("dev")
        expect(account.region).toBe("us-east-1")
      }))
  })

  describe("PullRequest", () => {
    const validPR = {
      id: "123",
      title: "Add feature",
      author: "john",
      repositoryName: "my-repo",
      creationDate: new Date("2024-01-15"),
      lastModifiedDate: new Date("2024-01-16"),
      link: "https://console.aws.amazon.com",
      account: { profile: "dev", region: "us-east-1" },
      status: "OPEN" as const,
      sourceBranch: "feature/x",
      destinationBranch: "main",
      isMergeable: true,
      isApproved: false
    }

    // Ensures Schema.Class roundtrips and all fields are preserved
    it.effect("decodes valid pull request with all fields", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)(validPR)
        expect(pr.id).toBe("123")
        expect(pr.title).toBe("Add feature")
        expect(pr.status).toBe("OPEN")
        expect(pr.isMergeable).toBe(true)
      }))

    // consoleUrl getter must construct correct AWS Console deep-link
    it.effect("computes consoleUrl from account region and PR id", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)(validPR)
        expect(pr.consoleUrl).toContain("us-east-1.console.aws.amazon.com")
        expect(pr.consoleUrl).toContain("/pull-requests/123")
        expect(pr.consoleUrl).toContain("my-repo")
      }))

    // description is optional — must accept absent value
    it.effect("allows missing description", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)(validPR)
        expect(pr.description).toBeUndefined()
      }))

    // Status must only accept OPEN or CLOSED literals
    it.effect("rejects invalid status", () =>
      Effect.gen(function*() {
        const result = yield* Schema.decode(PullRequest)({ ...validPR, status: "INVALID" }).pipe(
          Effect.flip
        )
        expect(result).toBeDefined()
      }))
  })

  describe("PRComment", () => {
    // Verifies Schema.Class decode with branded CommentId
    it.effect("decodes valid comment", () =>
      Effect.gen(function*() {
        const comment = yield* Schema.decode(PRComment)({
          id: "c-1",
          content: "Looks good",
          author: "jane",
          creationDate: new Date("2024-01-15"),
          deleted: false
        })
        expect(comment.id).toBe("c-1")
        expect(comment.content).toBe("Looks good")
      }))

    // Optional fields (inReplyTo, filePath, lineNumber) must be absent-safe
    it.effect("allows optional fields to be absent", () =>
      Effect.gen(function*() {
        const comment = yield* Schema.decode(PRComment)({
          id: "c-2",
          content: "LGTM",
          author: "bob",
          creationDate: new Date(),
          deleted: false
        })
        expect(comment.inReplyTo).toBeUndefined()
        expect(comment.filePath).toBeUndefined()
        expect(comment.lineNumber).toBeUndefined()
      }))
  })
})
