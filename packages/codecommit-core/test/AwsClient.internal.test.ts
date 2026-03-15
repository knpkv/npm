/**
 * Unit tests for AwsClient internal helpers.
 *
 * Covers {@link normalizeAuthor} (assumed-role ARN → session name, IAM user
 * → username, fallback), {@link isThrottlingError} (`.name` / `.code` /
 * `.message` detection + non-Error values), {@link parseRuleContent}
 * (valid/invalid/empty AWS JSON, poolMemberArns preservation), and
 * {@link makeApiError} (factory produces AwsApiError with correct fields).
 */
import { describe, expect, it } from "@effect/vitest"
import { parseRuleContent } from "../src/AwsClient/getPullRequests.js"
import { isThrottlingError, makeApiError, normalizeAuthor } from "../src/AwsClient/internal.js"
import type { AwsProfileName, AwsRegion } from "../src/Domain.js"

describe("AwsClient internals", () => {
  describe("normalizeAuthor", () => {
    // Primary use case: extract SessionName from assumed-role ARN
    it("extracts session name from assumed-role ARN", () => {
      expect(
        normalizeAuthor("arn:aws:sts::123456789012:assumed-role/MyRole/john.doe")
      ).toBe("john.doe")
    })

    // IAM user ARN: should extract username
    it("extracts username from IAM user ARN", () => {
      expect(
        normalizeAuthor("arn:aws:iam::123456789012:user/admin")
      ).toBe("admin")
    })

    // Fallback: returns full string if no slashes
    it("returns full ARN when no segments found", () => {
      expect(normalizeAuthor("simple-string")).toBe("simple-string")
    })

    // Edge: empty string should not throw
    it("handles empty string", () => {
      expect(normalizeAuthor("")).toBe("")
    })
  })

  describe("isThrottlingError", () => {
    // AWS SDK errors have structured .name property
    it.each([
      { name: "ThrottlingException" },
      { name: "TooManyRequestsException" }
    ])("detects error.name: $name", (err) => {
      expect(isThrottlingError(Object.assign(new Error(), err))).toBe(true)
    })

    // AWS SDK errors may also use .code property
    it.each([
      { code: "Throttling" },
      { code: "RequestLimitExceeded" },
      { code: "SlowDown" }
    ])("detects error.code: $code", (err) => {
      expect(isThrottlingError(Object.assign(new Error(), err))).toBe(true)
    })

    // Fallback: throttling info in .message only
    it.each([
      "Rate exceeded for API calls",
      "Too many requests, please slow down"
    ])("detects throttling in message: %s", (msg) => {
      expect(isThrottlingError(new Error(msg))).toBe(true)
    })

    // Non-throttling errors should not trigger retry
    it("returns false for non-throttling errors", () => {
      expect(isThrottlingError(new Error("AccessDenied"))).toBe(false)
    })

    // Must handle non-Error values gracefully
    it("handles non-Error values", () => {
      expect(isThrottlingError(null)).toBe(false)
      expect(isThrottlingError(42)).toBe(false)
      expect(isThrottlingError(undefined)).toBe(false)
    })
  })

  describe("parseRuleContent", () => {
    it("parses valid AWS approval rule content", () => {
      const content = JSON.stringify({
        Version: "2018-11-08",
        Statements: [{
          Type: "Approvers",
          NumberOfApprovalsNeeded: 2,
          ApprovalPoolMembers: [
            "arn:aws:sts::123456789012:assumed-role/MyRole/alice",
            "arn:aws:sts::123456789012:assumed-role/MyRole/bob"
          ]
        }]
      })
      const result = parseRuleContent(content)
      expect(result.requiredApprovals).toBe(2)
      expect(result.poolMembers).toEqual(["alice", "bob"])
      expect(result.poolMemberArns).toEqual([
        "arn:aws:sts::123456789012:assumed-role/MyRole/alice",
        "arn:aws:sts::123456789012:assumed-role/MyRole/bob"
      ])
    })

    it("returns defaults for undefined content", () => {
      const result = parseRuleContent(undefined)
      expect(result.requiredApprovals).toBe(1)
      expect(result.poolMembers).toEqual([])
    })

    it("returns defaults for invalid JSON", () => {
      const result = parseRuleContent("not json")
      expect(result.requiredApprovals).toBe(1)
      expect(result.poolMembers).toEqual([])
    })

    it("returns defaults for empty JSON object", () => {
      const result = parseRuleContent("{}")
      expect(result.requiredApprovals).toBe(1)
      expect(result.poolMembers).toEqual([])
    })

    it("handles missing Statements array", () => {
      const result = parseRuleContent(JSON.stringify({ Version: "2018-11-08" }))
      expect(result.requiredApprovals).toBe(1)
      expect(result.poolMembers).toEqual([])
    })

    it("handles empty ApprovalPoolMembers", () => {
      const content = JSON.stringify({
        Version: "2018-11-08",
        Statements: [{ Type: "Approvers", NumberOfApprovalsNeeded: 1, ApprovalPoolMembers: [] }]
      })
      const result = parseRuleContent(content)
      expect(result.requiredApprovals).toBe(1)
      expect(result.poolMembers).toEqual([])
    })
  })

  describe("makeApiError", () => {
    // Factory should produce AwsApiError with correct tag and fields
    it("creates AwsApiError with correct fields", () => {
      const err = makeApiError("getPullRequest", "dev" as AwsProfileName, "us-east-1" as AwsRegion, new Error("boom"))
      expect(err._tag).toBe("AwsApiError")
      expect(err.operation).toBe("getPullRequest")
      expect(err.profile).toBe("dev")
      expect(err.region).toBe("us-east-1")
    })
  })
})
