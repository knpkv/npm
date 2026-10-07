/**
 * What every surface relies on when it exposes a capability: a contract name every surface accepts,
 * untrusted arguments decoded before the handler runs, outputs and declared failures encoded as JSON
 * with the failure's fix intact, and anything undeclared left a defect instead of a model-visible message.
 */
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import {
  ContractNameInvalid,
  defineContract,
  describeCall,
  implement,
  inputJsonSchema,
  invoke,
  isToolName,
  ObjectRef
} from "../src/index.js"

class PullRequestNotFound extends Schema.TaggedError<PullRequestNotFound>()("PullRequestNotFound", {
  id: Schema.String,
  fix: Schema.String
}) {
  override get message(): string {
    return `Pull request ${this.id} was not found`
  }
}

const PullRequest = Schema.Struct({ ref: ObjectRef, title: Schema.String, openedAt: Schema.Date })

const ref = (id: string): ObjectRef => ({ product: "codecommit", kind: "pull-request", id })

const getPullRequestContract = defineContract({
  name: "get_pull_request",
  description: "Read one pull request.",
  access: "read",
  input: Schema.Struct({ id: Schema.String }),
  output: PullRequest,
  failure: PullRequestNotFound,
  cites: (pullRequest) => [pullRequest.ref]
})

const getPullRequest = implement(getPullRequestContract, ({ id }) =>
  id === "missing"
    ? Effect.fail(new PullRequestNotFound({ id, fix: "List open pull requests and pick one that exists." }))
    : Effect.succeed({ ref: ref(id), title: "Tidy the parser", openedAt: new Date("2026-10-06T10:00:00.000Z") }))

const postCommentContract = defineContract({
  name: "post_comment",
  description: "Post a comment on a pull request.",
  access: "write",
  reversible: false,
  input: Schema.Struct({ id: Schema.String, body: Schema.String }),
  output: Schema.Struct({ commentId: Schema.String }),
  failure: Schema.Never,
  describe: ({ body, id }) => ({ verb: "Post comment", target: ref(id), args: { body } })
})

describe("defineContract", () => {
  it("accepts names every surface accepts and rejects the rest at definition", () => {
    expect(isToolName("get_pull_request")).toBe(true)
    expect(isToolName("get-pull-request")).toBe(true)
    expect(isToolName("get pull request")).toBe(false)
    expect(isToolName("x".repeat(65))).toBe(false)
    expect(() =>
      defineContract({
        name: "get pull request",
        description: "Invalid name.",
        access: "read",
        input: Schema.Struct({}),
        output: Schema.String,
        failure: Schema.Never
      })
    ).toThrow(ContractNameInvalid)
  })

  it("cites nothing unless the contract says otherwise", () => {
    expect(postCommentContract.cites({ commentId: "c1" })).toEqual([])
  })
})

describe("invoke", () => {
  it.effect("decodes JSON arguments, runs the handler and encodes the output as JSON with its citations", () =>
    Effect.gen(function*() {
      const result = yield* invoke(getPullRequest, { id: "7" })
      expect(result.output).toEqual({
        ref: ref("7"),
        title: "Tidy the parser",
        openedAt: "2026-10-06T10:00:00.000Z"
      })
      expect(result.cites).toEqual([ref("7")])
    }))

  it.effect("rejects arguments the input schema rejects before the handler runs", () =>
    Effect.gen(function*() {
      const error = yield* invoke(getPullRequest, { id: 7 }).pipe(Effect.flip)
      expect(error._tag).toBe("CapabilityInputInvalid")
      expect(error).toMatchObject({ capability: "get_pull_request" })
    }))

  it.effect("returns a declared failure encoded, with its message and fix", () =>
    Effect.gen(function*() {
      const error = yield* invoke(getPullRequest, { id: "missing" }).pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "CapabilityFailed",
        capability: "get_pull_request",
        tag: "PullRequestNotFound",
        reason: "Pull request missing was not found",
        fix: "List open pull requests and pick one that exists.",
        failure: {
          _tag: "PullRequestNotFound",
          id: "missing",
          fix: "List open pull requests and pick one that exists."
        }
      })
    }))

  it.effect("leaves an undeclared failure a defect, never a model-visible message", () =>
    Effect.gen(function*() {
      const crashing = implement(getPullRequestContract, () => Effect.die(new Error("database password rejected")))
      const exit = yield* invoke(crashing, { id: "7" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
    }))
})

describe("invoke boundaries", () => {
  it.effect("keeps a failure outside the declared union a defect with its original value", () =>
    Effect.gen(function*() {
      // The declared failure requires a non-empty fix; its TypeScript type is just string, so a handler
      // can fail with a value the union rejects, as anything from untyped JavaScript could.
      const Busy = Schema.TaggedStruct("Busy", {
        message: Schema.String,
        fix: Schema.String.check(Schema.isNonEmpty())
      })
      const original: typeof Busy.Type = { _tag: "Busy", message: "Busy", fix: "" }
      const busy = implement(
        defineContract({
          name: "busy",
          description: "Fails with a value outside its declared failure.",
          access: "read",
          input: Schema.Struct({}),
          output: Schema.String,
          failure: Busy
        }),
        () => Effect.fail(original)
      )
      const exit = yield* invoke(busy, {}).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(original)
    }))

  it.effect("rejects citations that break the ObjectRef schema", () =>
    Effect.gen(function*() {
      const badCites = implement(
        defineContract({
          name: "bad_cites",
          description: "Cites an empty reference.",
          access: "read",
          input: Schema.Struct({}),
          output: Schema.String,
          failure: Schema.Never,
          cites: () => [{ product: "", kind: "pull-request", id: "7" }]
        }),
        () => Effect.succeed("ok")
      )
      const error = yield* invoke(badCites, {}).pipe(Effect.flip)
      expect(error._tag).toBe("CapabilityEncodingFailed")
    }))

  it.effect("rejects a pending action that breaks the PendingAction schema", () =>
    Effect.gen(function*() {
      const badAction = defineContract({
        name: "bad_action",
        description: "Describes an action with no verb.",
        access: "write",
        reversible: true,
        input: Schema.Struct({ id: Schema.String }),
        output: Schema.String,
        failure: Schema.Never,
        describe: ({ id }) => ({ verb: "", target: ref(id), args: { n: Number.NaN } })
      })
      const error = yield* describeCall(badAction, { id: "7" }).pipe(Effect.flip)
      expect(error._tag).toBe("CapabilityEncodingFailed")
    }))
})

describe("describeCall", () => {
  it.effect("shows the exact pending action for decoded arguments", () =>
    Effect.gen(function*() {
      const action = yield* describeCall(postCommentContract, { id: "7", body: "Looks good" })
      expect(action).toEqual({ verb: "Post comment", target: ref("7"), args: { body: "Looks good" } })
    }))

  it.effect("decodes the arguments before describing them", () =>
    Effect.gen(function*() {
      const error = yield* describeCall(postCommentContract, { id: "7" }).pipe(Effect.flip)
      expect(error._tag).toBe("CapabilityInputInvalid")
    }))
})

describe("inputJsonSchema", () => {
  it("describes the input as an object with named, required fields", () => {
    expect(inputJsonSchema(postCommentContract)).toMatchObject({
      type: "object",
      properties: { id: { type: "string" }, body: { type: "string" } },
      required: ["id", "body"]
    })
  })
})
