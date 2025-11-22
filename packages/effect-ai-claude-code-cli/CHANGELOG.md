# @knpkv/effect-ai-claude-code-cli

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
