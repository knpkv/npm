import type { Domain } from "@knpkv/codecommit-core"
import {
  CONTROL_CENTER_MANAGED_REVIEW_IDENTITY,
  CONTROL_CENTER_MANAGED_REVIEW_IDENTITY_PATH
} from "@knpkv/codecommit-core/ManagedReviewProtocol.js"
import { Config, Effect, Option } from "effect"

export const DEFAULT_CONTROL_CENTER_ORIGIN = "http://127.0.0.1:4173"

export interface ControlCenterOriginSettings {
  readonly override: string
  readonly publicOrigin: string
  readonly host: string
  readonly port: number
}

/** Load only settings needed by the winning origin-precedence branch. @internal */
export const controlCenterOriginConfiguration = Effect.gen(function*() {
  const override = yield* Config.option(Config.string("CODECOMMIT_CONTROL_CENTER_ORIGIN"))
  if (Option.isSome(override) && override.value.trim().length > 0) {
    return { override: override.value, publicOrigin: "", host: "127.0.0.1", port: 4173 }
  }
  const publicOrigin = yield* Config.option(Config.string("CONTROL_CENTER_PUBLIC_ORIGIN"))
  if (Option.isSome(publicOrigin) && publicOrigin.value.trim().length > 0) {
    return { override: "", publicOrigin: publicOrigin.value, host: "127.0.0.1", port: 4173 }
  }
  return {
    override: "",
    publicOrigin: "",
    host: yield* Config.string("CONTROL_CENTER_HOST").pipe(Config.withDefault("127.0.0.1")),
    port: yield* Config.int("CONTROL_CENTER_PORT").pipe(Config.withDefault(4173))
  }
})

const normalizedOrigin = (input: string): string | null => {
  const candidate = input.trim()
  if (!URL.canParse(candidate)) return null
  const url = new URL(candidate)
  return (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.pathname === "/" &&
      url.search.length === 0 &&
      url.hash.length === 0
    ? url.origin
    : null
}

const browserHost = (host: string): string => {
  const trimmed = host.trim()
  if (trimmed === "0.0.0.0") return "127.0.0.1"
  if (trimmed === "::" || trimmed === "[::]") return "[::1]"
  return trimmed.includes(":") && !trimmed.startsWith("[") ? `[${trimmed}]` : trimmed
}

/** Resolve the TUI handoff target from its override or Control Center's own server settings. */
export const resolveControlCenterOrigin = (settings: ControlCenterOriginSettings): string | null => {
  const explicit = settings.override.trim().length > 0 ? settings.override : settings.publicOrigin
  if (explicit.trim().length > 0) return normalizedOrigin(explicit)
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65_535) return null
  return normalizedOrigin(`http://${browserHost(settings.host)}:${String(settings.port)}`)
}

/** TLS authenticates the configured server before a browser can disclose its host-only session cookie. */
export const controlCenterOriginSupportsAutomaticHandoff = (origin: string): boolean =>
  URL.canParse(origin) && new URL(origin).protocol === "https:"

/** Accept only the exact versioned identity emitted by Control Center. */
export const isControlCenterManagedReviewIdentity = (status: number, body: string): boolean =>
  status === 200 && body === CONTROL_CENTER_MANAGED_REVIEW_IDENTITY

export const MAXIMUM_CONTROL_CENTER_IDENTITY_BYTES = CONTROL_CENTER_MANAGED_REVIEW_IDENTITY.length

/** Encoded lengths cannot bound a decoded compressed body; the stream always enforces the decoded limit. */
export const managedReviewIdentityContentLengthAllowed = (
  contentLength: string | undefined,
  contentEncoding: string | undefined = undefined
): boolean => {
  if (contentEncoding !== undefined && contentEncoding.trim().toLowerCase() !== "identity") return true
  if (contentLength === undefined) return true
  const parsed = Number(contentLength)
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAXIMUM_CONTROL_CENTER_IDENTITY_BYTES
}

/** A same-origin identity proof cannot be delegated to a redirect target. */
export const controlCenterIdentityRequestInit: RequestInit = { redirect: "manual" }

/** Browser launchers communicate ordinary failure through their exit status. */
export const browserLauncherSucceeded = (exitCode: number): boolean => exitCode === 0

/** Clipboard launchers also report ordinary failure through their exit status. */
export const clipboardCommandSucceeded = (exitCode: number): boolean => exitCode === 0

/** Keep the exact provider URL visible when no platform clipboard helper works. */
export const manualReviewHandoffMessage = (pullRequestUrl: string, copied: boolean): string =>
  copied
    ? "Automatic handoff requires a configured HTTPS Control Center origin. The PR URL was copied; open local Control Center and paste it. Local TUI review remains Relay-only and non-durable."
    : `Automatic handoff requires a configured HTTPS Control Center origin. Clipboard copy failed; paste this PR URL into local Control Center: ${pullRequestUrl} Local TUI review remains Relay-only and non-durable.`

/** Ignore legacy cached links and hand off the current partition-aware provider URL. */
export const managedReviewPullRequestUrl = (
  pullRequest: Pick<Domain.PullRequest, "consoleUrl" | "link">
): string => pullRequest.consoleUrl

/** Build the clean browser target; provider locators stay out of request URLs and history. */
export const controlCenterReviewUrl = (origin: string = DEFAULT_CONTROL_CENTER_ORIGIN): string =>
  new URL("/open-pr", origin).href

export type ControlCenterReviewHandoff =
  | { readonly _tag: "unavailable" }
  | { readonly _tag: "manual"; readonly clipboardText: string }
  | {
    readonly _tag: "automatic"
    readonly clipboardText: string
    readonly identityUrl: string
    readonly reviewUrl: string
  }

/** Decide the handoff before performing clipboard, network, or browser effects. */
export const planControlCenterReviewHandoff = (
  pullRequestUrl: string,
  origin: string | null
): ControlCenterReviewHandoff => {
  if (origin === null) return { _tag: "unavailable" }
  if (!controlCenterOriginSupportsAutomaticHandoff(origin)) {
    return { _tag: "manual", clipboardText: pullRequestUrl }
  }
  return {
    _tag: "automatic",
    clipboardText: pullRequestUrl,
    identityUrl: new URL(CONTROL_CENTER_MANAGED_REVIEW_IDENTITY_PATH, origin).href,
    reviewUrl: controlCenterReviewUrl(origin)
  }
}
