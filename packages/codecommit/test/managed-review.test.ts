import { codecommitConsoleUrl } from "@knpkv/codecommit-core/Domain.js"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"

import {
  browserLauncherSucceeded,
  clipboardCommandSucceeded,
  controlCenterIdentityRequestInit,
  controlCenterOriginConfiguration,
  controlCenterOriginSupportsAutomaticHandoff,
  controlCenterReviewUrl,
  isControlCenterManagedReviewIdentity,
  managedReviewIdentityContentLengthAllowed,
  managedReviewPullRequestUrl,
  manualReviewHandoffMessage,
  MAXIMUM_CONTROL_CENTER_IDENTITY_BYTES,
  planControlCenterReviewHandoff,
  resolveControlCenterOrigin
} from "../src/managed-review.js"

describe("controlCenterReviewUrl", () => {
  it("keeps the complete provider link as one encoded query value", () => {
    const providerUrl =
      "https://eu-west-1.console.aws.amazon.com/codesuite/codecommit/repositories/payments/pull-requests/42?region=eu-west-1"

    const handoff = new URL(controlCenterReviewUrl(providerUrl))

    expect(handoff.origin).toBe("http://127.0.0.1:4173")
    expect(handoff.pathname).toBe("/open-pr")
    expect(handoff.searchParams.get("url")).toBe(providerUrl)
  })

  it("uses an explicitly configured Control Center origin", () => {
    const origin = resolveControlCenterOrigin({
      override: "https://reviews.example.test",
      publicOrigin: "",
      host: "127.0.0.1",
      port: 4173
    })

    expect(origin).toBe("https://reviews.example.test")
    if (origin === null) return
    expect(new URL(controlCenterReviewUrl("https://console.aws.amazon.com/pr", origin)).origin)
      .toBe("https://reviews.example.test")
  })

  it("derives a browser-safe loopback origin from Control Center bind settings", () => {
    expect(resolveControlCenterOrigin({ override: "", publicOrigin: "", host: "0.0.0.0", port: 5180 }))
      .toBe("http://127.0.0.1:5180")
  })

  it("rejects path-bearing origins and unrelated service responses", () => {
    expect(resolveControlCenterOrigin({
      override: "https://reviews.example.test/base",
      publicOrigin: "",
      host: "127.0.0.1",
      port: 4173
    })).toBeNull()
    expect(isControlCenterManagedReviewIdentity(200, "some other service")).toBe(false)
    expect(isControlCenterManagedReviewIdentity(404, "@knpkv/control-center:managed-review:v1")).toBe(false)
    expect(isControlCenterManagedReviewIdentity(200, "@knpkv/control-center:managed-review:v1")).toBe(true)
  })

  it("accepts chunked identity responses but rejects declared oversized bodies", () => {
    expect(managedReviewIdentityContentLengthAllowed(undefined)).toBe(true)
    expect(managedReviewIdentityContentLengthAllowed(String(MAXIMUM_CONTROL_CENTER_IDENTITY_BYTES))).toBe(true)
    expect(managedReviewIdentityContentLengthAllowed("4096")).toBe(false)
    expect(managedReviewIdentityContentLengthAllowed("invalid")).toBe(false)
    expect(managedReviewIdentityContentLengthAllowed("4096", "gzip")).toBe(true)
  })

  it("falls through when a browser launcher exits nonzero", () => {
    expect(browserLauncherSucceeded(0)).toBe(true)
    expect(browserLauncherSucceeded(1)).toBe(false)
  })

  it("treats only zero clipboard exit status as a successful copy", () => {
    expect(clipboardCommandSucceeded(0)).toBe(true)
    expect(clipboardCommandSucceeded(1)).toBe(false)
  })

  it("automates handoff only when TLS authenticates the configured origin", () => {
    expect(controlCenterOriginSupportsAutomaticHandoff("https://reviews.example.test")).toBe(true)
    expect(controlCenterOriginSupportsAutomaticHandoff("http://127.0.0.1:4173")).toBe(false)
  })

  it("carries the exact PR URL into the manual handoff clipboard step", () => {
    const pullRequestUrl =
      "https://eu-west-1.console.aws.amazon.com/codesuite/codecommit/repositories/payments/pull-requests/42?region=eu-west-1"

    expect(planControlCenterReviewHandoff(pullRequestUrl, "http://127.0.0.1:4173")).toEqual({
      _tag: "manual",
      clipboardText: pullRequestUrl
    })
    expect(planControlCenterReviewHandoff(pullRequestUrl, "https://reviews.example.test")).toEqual({
      _tag: "automatic",
      identityUrl: "https://reviews.example.test/.well-known/knpkv-control-center",
      reviewUrl: `https://reviews.example.test/open-pr?url=${encodeURIComponent(pullRequestUrl)}`
    })
  })

  it("keeps the exact PR URL visible when every clipboard helper fails", () => {
    const pullRequestUrl = codecommitConsoleUrl("eu-west-1", "payments", "42")

    expect(manualReviewHandoffMessage(pullRequestUrl, false)).toContain(pullRequestUrl)
    expect(manualReviewHandoffMessage(pullRequestUrl, true)).not.toContain(pullRequestUrl)
    expect(manualReviewHandoffMessage(pullRequestUrl, true)).toContain("was copied")
  })

  it("replaces a legacy cached partition link with the canonical provider URL", () => {
    const canonical = codecommitConsoleUrl("cn-north-1", "payments", "42")
    expect(managedReviewPullRequestUrl({
      consoleUrl: canonical,
      link:
        "https://cn-north-1.console.aws.amazon.com/codesuite/codecommit/repositories/payments/pull-requests/42?region=cn-north-1"
    })).toBe(canonical)
    expect(managedReviewPullRequestUrl({
      consoleUrl: codecommitConsoleUrl("eu-west-1", "payments", "42"),
      link: "https://example.invalid/custom-link"
    })).toBe(
      "https://eu-west-1.console.aws.amazon.com/codesuite/codecommit/repositories/payments/pull-requests/42?region=eu-west-1"
    )
  })

  it("does not follow identity redirects to another origin", () => {
    expect(controlCenterIdentityRequestInit).toEqual({ redirect: "manual" })
  })

  it("does not parse an unused malformed port when an explicit origin wins", async () => {
    const settings = await Effect.runPromise(
      controlCenterOriginConfiguration.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            CODECOMMIT_CONTROL_CENTER_ORIGIN: "https://reviews.example.test",
            CONTROL_CENTER_PORT: "not-a-port"
          })
        )
      )
    )

    expect(resolveControlCenterOrigin(settings)).toBe("https://reviews.example.test")
  })
})
