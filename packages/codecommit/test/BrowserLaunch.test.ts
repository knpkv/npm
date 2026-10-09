import { describe, expect, it } from "@effect/vitest"
import { browserLaunch, type BrowserLaunchInput, skippedLine } from "../src/BrowserLaunch.js"

const atTerminal: BrowserLaunchInput = { noOpen: false, browser: undefined, ci: undefined, interactive: true }

// Test harnesses and journeys run `codecommit web` too; they must never open tabs in the user's browser.
describe("codecommit web browser launch", () => {
  it("opens a browser for a person at a terminal", () => {
    expect(browserLaunch(atTerminal)).toEqual({ _tag: "Open" })
  })

  it("skips when asked with --no-open or BROWSER=none", () => {
    expect(browserLaunch({ ...atTerminal, noOpen: true })).toEqual({ _tag: "Skip", reason: "--no-open" })
    expect(browserLaunch({ ...atTerminal, browser: "none" })).toEqual({ _tag: "Skip", reason: "BROWSER=none" })
    expect(browserLaunch({ ...atTerminal, browser: " None " })).toEqual({ _tag: "Skip", reason: "BROWSER=none" })
  })

  it("skips in CI, unless CI is set to a false value", () => {
    expect(browserLaunch({ ...atTerminal, ci: "true" })).toEqual({ _tag: "Skip", reason: "CI is set" })
    expect(browserLaunch({ ...atTerminal, ci: "1" })).toEqual({ _tag: "Skip", reason: "CI is set" })
    for (const off of ["", "0", "false", "FALSE"]) {
      expect(browserLaunch({ ...atTerminal, ci: off })).toEqual({ _tag: "Open" })
    }
  })

  it("skips when stdout is not a terminal", () => {
    expect(browserLaunch({ ...atTerminal, interactive: false })).toEqual({
      _tag: "Skip",
      reason: "not an interactive terminal"
    })
  })

  it("a named browser command still opens", () => {
    expect(browserLaunch({ ...atTerminal, browser: "firefox" })).toEqual({ _tag: "Open" })
  })

  it("says why no browser opened", () => {
    expect(skippedLine("--no-open")).toBe("Not opening a browser (--no-open); open the link above.")
  })
})
