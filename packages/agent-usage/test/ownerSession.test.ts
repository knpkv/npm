import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { authorizeBootstrapRequest, makeOwnerSessionSecrets, mintBootstrapUrl } from "../src/server/OwnerSession.js"

const origin = "http://127.0.0.1:3112"

/** The code a printed URL carries, as the page would send it. */
const codeOf = (url: string): string => decodeURIComponent(url.split("#bootstrap_token=")[1] ?? "")

const spend = (secrets: Effect.Success<ReturnType<typeof makeOwnerSessionSecrets>>, url: string) =>
  Effect.result(authorizeBootstrapRequest({ authorization: `Bearer ${codeOf(url)}`, origin }, secrets))

describe("one-time links", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("a minted link signs in once, and only once", () =>
      Effect.gen(function*() {
        const secrets = yield* makeOwnerSessionSecrets(origin)
        const url = yield* mintBootstrapUrl(secrets)
        expect(url.startsWith(`${origin}/#bootstrap_token=`)).toBe(true)
        expect((yield* spend(secrets, url))._tag).toBe("Success")
        expect((yield* spend(secrets, url))._tag).toBe("Failure")
      }))

    it.effect("a link is refused once its minute has passed", () =>
      Effect.gen(function*() {
        const secrets = yield* makeOwnerSessionSecrets(origin)
        const url = yield* mintBootstrapUrl(secrets)
        yield* TestClock.adjust("61 seconds")
        const outcome = yield* spend(secrets, url)
        expect(outcome._tag === "Failure" && outcome.failure.message).toContain("expired")
      }))

    it.effect("a newer link replaces an unspent one", () =>
      Effect.gen(function*() {
        const secrets = yield* makeOwnerSessionSecrets(origin)
        const older = yield* mintBootstrapUrl(secrets)
        const newer = yield* mintBootstrapUrl(secrets)
        expect(newer).not.toBe(older)
        expect((yield* spend(secrets, older))._tag).toBe("Failure")
        expect((yield* spend(secrets, newer))._tag).toBe("Success")
      }))

    it.effect("a fresh link works even after guesses closed the previous one", () =>
      Effect.gen(function*() {
        const secrets = yield* makeOwnerSessionSecrets(origin)
        yield* mintBootstrapUrl(secrets)
        for (let guess = 0; guess < 6; guess++) yield* spend(secrets, `${origin}/#bootstrap_token=wrong-${guess}`)
        const url = yield* mintBootstrapUrl(secrets)
        expect((yield* spend(secrets, url))._tag).toBe("Success")
      }))

    it.effect("nothing signs in before a link has been minted", () =>
      Effect.gen(function*() {
        const secrets = yield* makeOwnerSessionSecrets(origin)
        expect((yield* spend(secrets, `${origin}/#bootstrap_token=anything`))._tag).toBe("Failure")
      }))
  })
})
