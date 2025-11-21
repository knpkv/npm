# @knpkv/effect-ai-claude-agent-sdk

## 0.3.0

### Minor Changes

- [#8](https://github.com/knpkv/npm/pull/8) [`56cd283`](https://github.com/knpkv/npm/commit/56cd2832e2e1236c8dbe2941ddda47a45d147fc2) Thanks @konopkov! - Enhanced error handling with detailed context
  - Add exitCode, stderr, errorSubtype, errors fields to SdkError
  - Add errorSubtype, errors fields to StreamError
  - Add cause field to PermissionError
  - Extract exit codes from process error messages (multiple patterns)
  - Preserve error stack traces instead of String(error)
  - Format SDK error subtypes in result messages
  - Add comprehensive edge case testing (86 tests total)
  - Document stderr as unimplemented (reserved for future)
  - Document regex parsing as best-effort

  Fixes unclear error messages when SDK errors occur. Now exposes:
  - Process exit codes (extracted from error messages)
  - SDK error subtypes (error_during_execution, etc.)
  - Structured error arrays
  - Full stack traces

## 0.2.0

### Minor Changes

- [#3](https://github.com/knpkv/npm/pull/3) [`70e216c`](https://github.com/knpkv/npm/commit/70e216cd28e2626d3751a468f4a03739321fe0da) Thanks @konopkov! - Initial release of `@knpkv/effect-ai-claude-agent-sdk` - Effect-TS wrapper for Anthropic Claude Agent SDK.

  ## Features

  ### Core Modules
  - **ClaudeAgentClient** - Type-safe client for Claude Agent SDK
    - `queryText` - Execute text-based queries
    - `queryStream` - Stream responses with full event support
    - Automatic retry with exponential backoff
    - Comprehensive error handling
  - **ClaudeAgentLanguageModel** - @effect/ai integration
    - `LanguageModel` interface implementation
    - Text generation and streaming
    - Seamless integration with @effect/ai ecosystem
  - **ClaudeAgentConfig** - Configuration management
    - Tool permissions (allowed/disallowed)
    - Model selection
    - Custom settings
    - Layer-based composition
  - **ClaudeAgentError** - Tagged error types
    - `AgentExecutionError` - Execution failures
    - `AgentValidationError` - Input validation
    - `AgentRateLimitError` - Rate limiting
    - Type-safe error handling with Match
  - **ClaudeAgentHook** - Hook type definitions (not yet implemented)
    - Types for lifecycle hooks
    - Future support for pre/post execution hooks
    - Planned: Hook execution in future versions

  ### Type Safety
  - **Branded Types** - Prevent string confusion
    - `AgentId`, `SessionId`, `ToolName`
    - `ModelId`, `PromptText`
    - Schema validation and refinement
  - **MessageSchemas** - Type-safe message handling
    - Text message validation
    - Tool call schemas
    - Result schemas
    - Content block types
    - Token usage tracking (per-message and aggregate)
    - Session summary with cost and duration

  ### Security & Quality
  - **Runtime Safety Warnings**
    - Warning when `dangerouslySkipPermissions` is enabled

  ### Developer Experience
  - **Comprehensive Examples**
    - Basic query usage
    - Streaming responses
    - Tool permissions
    - Error handling
    - Language model integration
    - Service composition
    - Token usage tracking
  - **Complete Documentation**
    - API reference
    - Usage patterns
    - Type-safe examples
    - AGENTS.md for AI assistants
  - **Testing**
    - Unit tests for all modules
    - Integration tests
    - Type-safe fixtures

  ## Installation

  ```bash
  pnpm add @knpkv/effect-ai-claude-agent-sdk @anthropic-ai/claude-agent-sdk effect
  ```

  ## Quick Start

  ```typescript
  import { ClaudeAgentClient } from "@knpkv/effect-ai-claude-agent-sdk"
  import { Effect } from "effect"

  const program = Effect.gen(function* () {
    const client = yield* ClaudeAgentClient.ClaudeAgentClient
    const response = yield* client.queryText({
      prompt: "What is Effect-TS?"
    })
    console.log(response)
  })

  Effect.runPromise(program.pipe(Effect.provide(ClaudeAgentClient.layer())))
  ```
