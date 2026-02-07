import { describe, expect, it } from "@effect/vitest"
import { parseAwsConfig } from "../src/ConfigService/internal.js"

describe("parseAwsConfig", () => {
  // Standard profile with region should be detected correctly
  it("parses a single profile with region", () => {
    const content = `[profile dev]
region = us-west-2
output = json`

    const result = parseAwsConfig(content)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe("dev")
    expect(result[0]!.region).toBe("us-west-2")
  })

  // Credentials file uses bare [name] (no "profile" prefix)
  it("parses bare section names (credentials file format)", () => {
    const content = `[production]
aws_access_key_id = AKIA...
region = eu-west-1`

    const result = parseAwsConfig(content)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe("production")
    expect(result[0]!.region).toBe("eu-west-1")
  })

  // Multiple profiles should all be extracted
  it("parses multiple profiles", () => {
    const content = `[profile dev]
region = us-east-1

[profile staging]
region = eu-central-1

[profile prod]
region = ap-southeast-1`

    const result = parseAwsConfig(content)
    expect(result).toHaveLength(3)
    expect(result.map((p) => p.name)).toEqual(["dev", "staging", "prod"])
  })

  // Profiles without region should still be detected (region is optional)
  it("handles profiles without region", () => {
    const content = `[profile no-region]
output = json`

    const result = parseAwsConfig(content)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe("no-region")
    expect(result[0]!.region).toBeUndefined()
  })

  // Duplicate profile names should be deduplicated (first wins)
  it("deduplicates profiles by name", () => {
    const content = `[profile dup]
region = us-east-1

[profile dup]
region = eu-west-1`

    const result = parseAwsConfig(content)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe("dup")
  })

  // Comments and blank lines must be ignored during parsing
  it("ignores comments and blank lines", () => {
    const content = `# This is a comment
; Also a comment

[profile valid]
region = us-east-1`

    const result = parseAwsConfig(content)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe("valid")
  })

  // Empty or whitespace-only content should return empty array
  it("returns empty array for empty content", () => {
    expect(parseAwsConfig("")).toHaveLength(0)
    expect(parseAwsConfig("   \n\n  ")).toHaveLength(0)
  })

  // Region values with equals signs (e.g., unusual configs) should be joined
  it("handles region values containing equals signs", () => {
    const content = `[profile weird]
region = us=east=1`

    const result = parseAwsConfig(content)
    expect(result[0]!.region).toBe("us=east=1")
  })
})
