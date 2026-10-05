import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { makeOwnerSession, mintBootstrapUrl } from "../src/server/OwnerSession.js"

// The policy itself is tested in @knpkv/browser-pairing; this covers agent-usage's wiring of it.

const origin = "http://127.0.0.1:3112"

/** The code a printed URL carries, as the page would send it. */
const codeOf = (url: string): string => decodeURIComponent(url.split("#bootstrap_token=")[1] ?? "")

describe("agent-usage owner session", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("mints links on the browser origin that sign in once", () =>
      Effect.gen(function*() {
        const session = yield* makeOwnerSession(origin)
        const url = yield* mintBootstrapUrl(session)
        expect(url.startsWith(`${origin}/#bootstrap_token=`)).toBe(true)
        const spend = Effect.result(session.authorizeBootstrap({ authorization: `Bearer ${codeOf(url)}`, origin }))
        expect((yield* spend)._tag).toBe("Success")
        expect((yield* spend)._tag).toBe("Failure")
      }))

    it.effect("points an expired link at agent-usage login", () =>
      Effect.gen(function*() {
        const session = yield* makeOwnerSession(origin)
        const url = yield* mintBootstrapUrl(session)
        yield* TestClock.adjust("61 seconds")
        const outcome = yield* Effect.result(
          session.authorizeBootstrap({ authorization: `Bearer ${codeOf(url)}`, origin })
        )
        expect(outcome._tag === "Failure" && outcome.failure.message).toContain("expired")
        expect(outcome._tag === "Failure" && outcome.failure.message).toContain("agent-usage login")
      }))

    it.effect("is read-only", () =>
      Effect.gen(function*() {
        expect((yield* makeOwnerSession(origin)).writes._tag).toBe("ReadOnly")
      }))
  })
})
