# @knpkv/effect-ai-claude-code-cli

## 0.2.0

### Minor Changes

- [#13](https://github.com/knpkv/npm/pull/13) [`3ccfd72`](https://github.com/knpkv/npm/commit/3ccfd727dd60bb2404e2fecee78e4dc5e1e1ba93) Thanks @konopkov! - Add session resume functionality
  - Add SessionId branded type with UUID validation
  - Add SessionNotFoundError and InvalidSessionIdError
  - Create SessionDiscovery module for listing sessions from ~/.claude/
  - Implement resumeQuery() and resumeQueryStream() methods
  - Add --resume flag support to CLI integration
  - Fix encodeProjectPath() to handle leading / and . characters
  - Add session-resume.ts example
  - Add comprehensive integration test

## 0.1.0

### Minor Changes

- [#10](https://github.com/knpkv/npm/pull/10) [`e5303b2`](https://github.com/knpkv/npm/commit/e5303b2716d2c832a8fba900a187b48a48217fe9) Thanks @konopkov! - Initial release of Effect-TS wrapper for Claude Code CLI

  Core features:
  - Type-safe client for CLI process management
  - @effect/ai LanguageModel integration with accurate token usage tracking
  - Comprehensive error handling (9 error types)
  - Stream-based JSON chunk processing
  - Tool permission configuration
  - CLI version compatibility checking
  - Branded types with runtime validation
  - Command injection protection via prompt validation
  - 107 tests with @effect/vitest 0.27.0 and vitest 4.0.13
  - 8 examples covering common patterns

  Security:
  - Prompt validation before command execution
  - Command separator (`--`) to prevent argument injection
  - Complete KNOWN_TOOLS validation (16 tools)

  @effect/ai Integration:
  - LanguageModel.generateText with accurate token counts from stream
  - LanguageModel.streamText with real-time usage tracking
  - Proper finish events with inputTokens/outputTokens/totalTokens
