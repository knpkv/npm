import { describe, expect, it } from "@effect/vitest"
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import {
  RelayBackendNotConfigured,
  RelayDecisionNotPending,
  type RelayEvent,
  type RelayHarnessService,
  RelayRunNotActive
} from "@knpkv/relay"
import { Effect, Fiber, FileSystem, Layer, Path, Ref, Stream } from "effect"
import { Etag, HttpPlatform } from "effect/http"
import { HttpApiTest } from "effect/http-api"
import * as TestClock from "effect/testing/TestClock"
import { CodeCommitApi, OwnerSessionAuth, type RelayRef, RelayUnavailableError } from "../src/server/Api.js"
import { RelayLive } from "../src/server/handlers/relay-live.js"
import { RelayMount } from "../src/server/relay/RelayMount.js"

const ref: RelayRef = { product: "codecommit", kind: "pull-request", id: "123456789012/us-east-1/payments/42" }

const transport = Layer.mergeAll(
  Path.layer,
  Etag.layerWeak,
  HttpPlatform.layer,
  Layer.succeed(OwnerSessionAuth, { ownerCookie: (httpEffect) => httpEffect })
).pipe(Layer.provideMerge(FileSystem.layerNoop({})))

const snapshot: RelayEvent = { _tag: "Snapshot", session: "s-1", seq: 0, messages: [], runIds: [] }

/** A harness that records what the routes asked of it and answers from fixed outcomes. */
const fakeHarness = (sent: Ref.Ref<ReadonlyArray<string>>): RelayHarnessService => ({
  tools: [],
  send: (_ref, text, requestId, options) =>
    options?.backend === "codex-cli"
      ? Effect.fail(new RelayBackendNotConfigured({ backend: options.backend }))
      : Ref.update(sent, (all) => [
        ...all,
        `${requestId}:${text}`,
        ...(options?.context ?? []).map((context) => `${context.label}\n${context.body}`)
      ]),
  events: () => Stream.concat(Stream.make(snapshot), Stream.never),
  decide: (callId) =>
    Effect.fail(
      new RelayDecisionNotPending({
        callId,
        state: callId === "answered" ? { _tag: "Decided", allow: false } : { _tag: "Expired" }
      })
    ),
  cancel: (_ref, runId) => runId === "req-live" ? Effect.void : Effect.fail(new RelayRunNotActive({ runId })),
  session: () => Effect.succeed({ tools: [], backend: "claude-code", cancel: true }),
  backends: Effect.succeed([{
    _tag: "Unverified",
    backend: "claude-code",
    label: "Claude Code",
    version: "2.1.0 (Claude Code)"
  }])
})

const relayLayer = (
  harness: Effect.Effect<RelayHarnessService, RelayUnavailableError>,
  authorize: OwnerSession.OwnerSessionService["authorizeHttp"] = () => Effect.void
) =>
  RelayLive.pipe(
    Layer.provideMerge(Layer.mergeAll(
      Layer.succeed(RelayMount, { harness }),
      Layer.mock(OwnerSession.OwnerSession, {
        authorityOrigin: "http://127.0.0.1:3000",
        browserOrigin: "http://127.0.0.1:3000",
        cookieName: "cc_owner",
        writes: { _tag: "ReadOnly" },
        sessionCookie: "cc_owner=test",
        authorizeHttp: authorize
      })
    )),
    Layer.provideMerge(transport)
  )

const sent = Ref.makeUnsafe<ReadonlyArray<string>>([])

describe("/api/relay", () => {
  it.layer(relayLayer(Effect.succeed(fakeHarness(sent))))("with Relay running", (it) => {
    it.effect("accepts a message with 202 and returns the runId the run's events carry", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(CodeCommitApi, ["relay"])
        const accepted = yield* client.relay.messages({ payload: { ref, text: "Approvals?", requestId: "req-1" } })
        expect(accepted).toEqual({ runId: "req-1" })
        expect(yield* Ref.get(sent)).toEqual(["req-1:Approvals?"])
      }))

    it.effect("gives Relay attached findings with the head they were reviewed at", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(CodeCommitApi, ["relay"])
        yield* Ref.set(sent, [])
        yield* client.relay.messages({
          payload: {
            ref,
            text: "Is the P1 real?",
            requestId: "req-findings",
            context: [{
              _tag: "ReviewFindings",
              reviewedHead: { revisionId: "rev-7", baseCommit: "a".repeat(40), headCommit: "b".repeat(40) },
              findings: [{
                id: "F1",
                priority: "P1",
                title: "Unchecked null",
                summary: "patch-reader reads a nullable field",
                details: "The parser reads a field that can be null.",
                recommendation: "Check for null first.",
                verification: "A test with a null field.",
                publicationTarget: "line-comment",
                location: { scope: "line", filePath: "src/patch-reader.ts", line: 19, side: "after" }
              }]
            }]
          }
        })
        const [message, context] = yield* Ref.get(sent)
        expect(message).toBe("req-findings:Is the P1 real?")
        expect(context).toContain("1 review findings, reviewed at head bbbbbbb")
        expect(context).toContain(`"headCommit":"${"b".repeat(40)}"`)
        expect(context).toContain("say these findings are from an older head")
        expect(context).toContain(`"filePath":"src/patch-reader.ts"`)
      }))

    it.effect("refuses a backend this server doesn't offer with 400", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(CodeCommitApi, ["relay"])
        const refused = yield* client.relay.messages({
          payload: { ref, text: "Hi", requestId: "req-2", backend: "codex-cli" }
        }).pipe(Effect.flip)
        expect(refused).toMatchObject({ _tag: "RelayBadRequestError" })
      }))

    it.effect("answers 409 with the state it found for a stale cancel or decision", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(CodeCommitApi, ["relay"])
        yield* client.relay.cancel({ payload: { ref, runId: "req-live" } })
        const notRunning = yield* client.relay.cancel({ payload: { ref, runId: "req-done" } }).pipe(Effect.flip)
        expect(notRunning).toMatchObject({ _tag: "RelayConflictError", state: { _tag: "NotRunning" } })
        const decided = yield* client.relay.decisions({ payload: { ref, callId: "answered", allow: true } }).pipe(
          Effect.flip
        )
        expect(decided).toMatchObject({ _tag: "RelayConflictError", state: { _tag: "Decided", allow: false } })
        const expired = yield* client.relay.decisions({ payload: { ref, callId: "gone", allow: true } }).pipe(
          Effect.flip
        )
        expect(expired).toMatchObject({ state: { _tag: "Expired" } })
      }))

    it.effect("reports the session's backend and every backend's status", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(CodeCommitApi, ["relay"])
        expect(yield* client.relay.session({ query: ref })).toEqual({ tools: [], backend: "claude-code", cancel: true })
        expect(yield* client.relay.backends()).toMatchObject([{ _tag: "Unverified", version: "2.1.0 (Claude Code)" }])
      }))
  })

  it.layer(relayLayer(
    Effect.succeed(fakeHarness(Ref.makeUnsafe<ReadonlyArray<string>>([]))),
    () => Effect.fail(new OwnerSession.OwnerSessionUnauthorizedError({ message: "expired" }))
  ))("when the owner session expires mid-stream", (it) => {
    it.effect("streams the Snapshot, then ends with Unauthorized at the next heartbeat", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(CodeCommitApi, ["relay"])
        const response = yield* client.relay.events({ query: ref, responseMode: "response-only" })
        const frames = yield* response.stream.pipe(
          Stream.decodeText(),
          Stream.runCollect,
          Effect.forkScoped
        )
        yield* TestClock.adjust("15 seconds")
        const text = (yield* Fiber.join(frames)).join("")
        expect(text).toContain(`"_tag":"Snapshot"`)
        expect(text.trim().endsWith(`data: {"_tag":"Unauthorized"}`)).toBe(true)
      }))
  })

  it.layer(relayLayer(
    Effect.fail(new RelayUnavailableError({ message: "Another process owns the Relay store.", fix: "Stop it." }))
  ))("when Relay could not start", (it) => {
    it.effect("answers 503 with the fix, and the rest of the server is untouched", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(CodeCommitApi, ["relay"])
        const refused = yield* client.relay.backends().pipe(Effect.flip)
        expect(refused).toMatchObject({ _tag: "RelayUnavailableError", fix: "Stop it." })
      }))
  })
})
