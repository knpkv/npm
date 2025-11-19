---
"@knpkv/effect-ai-claude-agent-sdk": minor
---

Initial release of `@knpkv/effect-ai-claude-agent-sdk` - Effect-TS wrapper for Anthropic Claude Agent SDK.

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
