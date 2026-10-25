/**
 * The one-time code `herdr-hub login` trades for a local session.
 *
 * **Mental model**
 *
 * - **The CLI asks, the page spends.** The hub mints a code only for a request carrying its CLI token (the
 *   caller checks that). The CLI opens the page with the code in the URL fragment, which no server, history
 *   request or Referer sees, and the page spends it once for a local session.
 * - **The CLI token is no barrier to agents.** Every process of the user can read it, so the code shows
 *   that someone on this computer asked, not who.
 * - **One live code, 60 seconds, 5 wrong guesses.** A newer code replaces an unspent one; 5 failed
 *   exchanges drop the live code, until a new one is minted. Spending is one atomic swap, so two racing
 *   exchanges can't both win.
 * - In memory: a restart drops the live code, and `herdr-hub login` simply asks again.
 * - **No rate limit beyond that.** With one live code and the guess cap there is nothing left to limit. A
 *   local process can burn the live code with 5 wrong guesses; that only makes `herdr-hub login` ask again,
 *   and that process runs as the same user anyway.
 *
 * @module
 */
import { credentialValuesEqual, issuePairingCode, type PairingCode } from "@knpkv/browser-pairing"
import { Clock, Effect, Redacted, Ref } from "effect"

const codeLifetimeMillis = 60_000
const maxFailures = 5

type Live = { readonly code: string; readonly expiresAt: number; readonly failures: number } | null

export const makeLocalLogin = Effect.gen(function*() {
  const live = yield* Ref.make<Live>(null)
  return {
    /** A fresh code, replacing any unspent one. */
    mint: Effect.gen(function*() {
      const code: Redacted.Redacted<PairingCode> = yield* issuePairingCode()
      const now = yield* Clock.currentTimeMillis
      yield* Ref.set(live, { code: Redacted.value(code), expiresAt: now + codeLifetimeMillis, failures: 0 })
      return code
    }),
    /** Whether `code` is the live code, spending it if so. */
    exchange: (code: string): Effect.Effect<boolean> =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Ref.modify(live, (current): [boolean, Live] => {
          if (current === null || current.expiresAt <= now) return [false, null]
          if (credentialValuesEqual(code, current.code)) return [true, null]
          const failures = current.failures + 1
          return [false, failures >= maxFailures ? null : { ...current, failures }]
        }))
  }
})
