/**
 * Whether `codecommit web` opens the sign-in link in a browser.
 *
 * The link is always printed, so skipping the browser loses nothing. It is skipped when asked
 * (`--no-open`, or `BROWSER=none` as other CLIs honour it), and when nobody is at the terminal to
 * see the tab: CI, or stdout that is not a terminal (a script, a test harness, a pipe).
 *
 * @module
 */

export type BrowserLaunch =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Skip"; readonly reason: string }

export interface BrowserLaunchInput {
  /** `--no-open` was passed. */
  readonly noOpen: boolean
  /** `BROWSER`, when set. */
  readonly browser: string | undefined
  /** `CI`, when set. Empty, `0` and `false` mean not CI. */
  readonly ci: string | undefined
  /** stdout is a terminal. */
  readonly interactive: boolean
}

const skip = (reason: string): BrowserLaunch => ({ _tag: "Skip", reason })

const isSetFlag = (value: string | undefined): boolean =>
  value !== undefined && !["", "0", "false"].includes(value.trim().toLowerCase())

export const browserLaunch = (input: BrowserLaunchInput): BrowserLaunch => {
  if (input.noOpen) return skip("--no-open")
  if (input.browser?.trim().toLowerCase() === "none") return skip("BROWSER=none")
  if (isSetFlag(input.ci)) return skip("CI is set")
  if (!input.interactive) return skip("not an interactive terminal")
  return { _tag: "Open" }
}

/** The line printed instead of opening a browser. */
export const skippedLine = (reason: string): string => `Not opening a browser (${reason}); open the link above.`
