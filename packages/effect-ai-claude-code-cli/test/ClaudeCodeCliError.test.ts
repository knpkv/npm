/**
 * Tests for ClaudeCodeCliError.
 */
import { describe, expect, it } from "@effect/vitest"
import {
  CliNotFoundError,
  ContextLengthError,
  InvalidApiKeyError,
  NetworkError,
  parseStderr,
  RateLimitError,
  StreamParsingError
} from "../src/ClaudeCodeCliError.js"

describe("ClaudeCodeCliError", () => {
  describe("parseStderr", () => {
    it("should parse rate limit error", () => {
      const stderr = "Rate limit exceeded. Retry after: 60 seconds"
      const error = parseStderr(stderr, 429)

      expect(error._tag).toBe("RateLimitError")
      if (error._tag === "RateLimitError") {
        expect(error.stderr).toBe(stderr)
        expect(error.retryAfter).toBe(60)
      }
    })

    it("should parse rate limit error without retry-after", () => {
      const stderr = "Rate limit exceeded"
      const error = parseStderr(stderr, 429)

      expect(error._tag).toBe("RateLimitError")
      if (error._tag === "RateLimitError") {
        expect(error.stderr).toBe(stderr)
        expect(error.retryAfter).toBeUndefined()
      }
    })

    it("should parse authentication error", () => {
      const stderr = "Invalid API key provided"
      const error = parseStderr(stderr, 401)

      expect(error._tag).toBe("InvalidApiKeyError")
      if (error._tag === "InvalidApiKeyError") {
        expect(error.stderr).toBe(stderr)
      }
    })

    it("should parse unauthorized error", () => {
      const stderr = "Unauthorized access"
      const error = parseStderr(stderr, 401)

      expect(error._tag).toBe("InvalidApiKeyError")
    })

    it("should parse generic execution error", () => {
      const stderr = "Command failed"
      const exitCode = 1
      const error = parseStderr(stderr, exitCode)

      expect(error._tag).toBe("CliExecutionError")
      if (error._tag === "CliExecutionError") {
        expect(error.stderr).toBe(stderr)
        expect(error.exitCode).toBe(exitCode)
      }
    })

    it("should handle unknown error format", () => {
      const stderr = "Unknown error occurred"
      const exitCode = 2
      const error = parseStderr(stderr, exitCode)

      expect(error._tag).toBe("CliExecutionError")
    })

    it("should parse network error", () => {
      const stderr = "Network connection failed"
      const error = parseStderr(stderr, 1)

      expect(error._tag).toBe("NetworkError")
      if (error._tag === "NetworkError") {
        expect(error.stderr).toBe(stderr)
      }
    })

    it("should parse ECONNREFUSED network error", () => {
      const stderr = "Error: ECONNREFUSED"
      const error = parseStderr(stderr, 1)

      expect(error._tag).toBe("NetworkError")
    })

    it("should parse timeout error", () => {
      const stderr = "Request timeout"
      const error = parseStderr(stderr, 1)

      expect(error._tag).toBe("NetworkError")
    })

    it("should parse context length error", () => {
      const stderr = "Context length exceeded"
      const error = parseStderr(stderr, 1)

      expect(error._tag).toBe("ContextLengthError")
      if (error._tag === "ContextLengthError") {
        expect(error.stderr).toBe(stderr)
      }
    })

    it("should parse token limit error", () => {
      const stderr = "Token limit exceeded"
      const error = parseStderr(stderr, 1)

      expect(error._tag).toBe("ContextLengthError")
    })

    it("should parse too many tokens error", () => {
      const stderr = "Too many tokens in request"
      const error = parseStderr(stderr, 1)

      expect(error._tag).toBe("ContextLengthError")
    })
  })

  describe("Error constructors", () => {
    it("should create CliNotFoundError with message", () => {
      const error = new CliNotFoundError()
      expect(error._tag).toBe("CliNotFoundError")
      expect(error.message).toContain("Claude Code CLI not found")
      expect(error.message).toContain("npm i -g @anthropics/claude-code")
    })

    it("should create StreamParsingError with line and error", () => {
      const line = "{\"invalid\": json}"
      const originalError = new Error("Unexpected token")
      const error = new StreamParsingError({ line, error: originalError })

      expect(error._tag).toBe("StreamParsingError")
      expect(error.line).toBe(line)
      expect(error.error).toBe(originalError)
    })

    it("should create RateLimitError with retryAfter", () => {
      const stderr = "Rate limited"
      const retryAfter = 120
      const error = new RateLimitError({ retryAfter, stderr })

      expect(error._tag).toBe("RateLimitError")
      expect(error.retryAfter).toBe(retryAfter)
      expect(error.stderr).toBe(stderr)
    })

    it("should create InvalidApiKeyError with stderr", () => {
      const stderr = "Invalid API key"
      const error = new InvalidApiKeyError({ stderr })

      expect(error._tag).toBe("InvalidApiKeyError")
      expect(error.stderr).toBe(stderr)
    })

    it("should create NetworkError with stderr", () => {
      const stderr = "Network error"
      const error = new NetworkError({ stderr })

      expect(error._tag).toBe("NetworkError")
      expect(error.stderr).toBe(stderr)
    })

    it("should create ContextLengthError with stderr", () => {
      const stderr = "Context length exceeded"
      const error = new ContextLengthError({ stderr })

      expect(error._tag).toBe("ContextLengthError")
      expect(error.stderr).toBe(stderr)
    })
  })
})
