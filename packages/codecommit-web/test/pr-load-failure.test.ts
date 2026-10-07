import { describe, expect, it } from "@effect/vitest"
import { pullRequestLoadFailure } from "../src/client/components/pr-detail.js"
import { AccountSwitchedOffApiError, AccountUnknownApiError, ApiError } from "../src/server/Api.js"

// QA-168: the first read of an uncached pull request used to fail silently, leaving the loading panel up.
describe("pullRequestLoadFailure", () => {
  it("sends a switched-off or unknown account to Settings → Accounts, with the server's reason", () => {
    const off = new AccountSwitchedOffApiError({
      message: "dev is switched off, so this pull request can't be read. Switch it on in Settings → Accounts.",
      profile: "dev"
    })
    expect(pullRequestLoadFailure(off)).toEqual({ message: off.message, fixInSettings: true })
    expect(pullRequestLoadFailure(new AccountUnknownApiError({ message: "unknown" })).fixInSettings).toBe(true)
  })

  it("keeps any other failure's reason, without the Settings link", () => {
    expect(pullRequestLoadFailure(new ApiError({ message: "Throttled: Rate exceeded" }))).toEqual({
      message: "Throttled: Rate exceeded",
      fixInSettings: false
    })
    expect(pullRequestLoadFailure("not an error").message).toBe("Try the refresh again.")
  })
})
