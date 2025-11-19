# Examples

Comprehensive examples demonstrating `@knpkv/effect-ai-claude-agent-sdk` usage patterns.

## Running Examples

All examples can be run using `tsx`:

```bash
# Install dependencies
pnpm install

# Run any example
npx tsx examples/basic-query.ts
npx tsx examples/streaming.ts
```

**Note:** `ANTHROPIC_API_KEY` is optional on authenticated machines (Claude Code Pro/Max subscription). For unauthenticated environments:

```bash
export ANTHROPIC_API_KEY=your-key-here
npx tsx examples/basic-query.ts
```

## Basic Usage

### `basic-query.ts`

Simple query execution with text response. Demonstrates the most basic usage pattern with `queryText()`.

**Key concepts:**

- Creating a client with default configuration
- Using `queryText()` for simple text responses
- Effect-based execution with `runPromise`

### `streaming.ts`

Stream message-by-message processing. Shows how to process streaming responses in real-time.

**Key concepts:**

- Using `query()` for streaming responses
- Processing `MessageEvent` stream with `Stream.runForEach`
- Handling different message types (assistant, user, system, result)

### `stream-processing.ts`

Advanced stream filtering and transformation. Demonstrates Effect Stream combinators for complex processing.

**Key concepts:**

- Filtering streams with `Stream.filter`
- Transforming messages with `Stream.map`
- Collecting streams with `Stream.runCollect`

### `chunk-logging.ts`

Detailed chunk logging with tool calls. Shows how to inspect raw SDK messages and tool executions.

**Key concepts:**

- Using `queryRaw()` for unconverted SDK messages
- Logging tool calls and execution details
- Understanding SDK message structure

### `tools.ts`

Using SDK with allowed tools for enhanced capabilities. Demonstrates tool permissions and restrictions.

**Key concepts:**

- Configuring `allowedTools` for specific tool access
- Understanding tool execution flow
- Tool-enhanced query capabilities

### `deny-all-tools.ts`

Empty `allowedTools` array (demonstrates tool denial). Shows how to prevent all tool usage.

**Key concepts:**

- Using `allowedTools: []` to deny all tools
- Understanding fallback behavior when tools are unavailable

### `token-usage.ts`

Track token usage and API costs. Demonstrates usage tracking for monitoring and optimization.

**Key concepts:**

- Extracting per-message token usage
- Accessing aggregate usage from result messages
- Cost calculation with `total_cost_usd`

## Error Handling & Resilience

### `error-handling.ts`

Typed error recovery with `catchTag`. Shows Effect-based error handling for different failure scenarios.

**Key concepts:**

- Using `catchTag` for specific error recovery
- Handling `SdkError`, `StreamError`, `ValidationError`
- Graceful degradation patterns

### `retry-resilience.ts`

Retry logic and timeout patterns. Demonstrates resilience strategies for production use.

**Key concepts:**

- Retry policies with `Effect.retry`
- Timeout handling with `Effect.timeout`
- Exponential backoff strategies

## Configuration & Composition

### `configuration.ts`

Custom configuration with layers. Shows how to use Effect Layers for dependency injection.

**Key concepts:**

- Creating config layers with `AgentConfig.layer()`
- Composing layers with `Effect.provide`
- Merging query-specific and global configuration

### `service-composition.ts`

Building services on top of `ClaudeAgentClient`. Demonstrates creating higher-level abstractions.

**Key concepts:**

- Creating custom services that use `ClaudeAgentClient`
- Service composition with Effect Context
- Building reusable agent capabilities

## @effect/ai Integration

### `language-model.ts`

`LanguageModel` integration with `generateText` and `streamText`. Shows `@effect/ai` compatibility.

**Key concepts:**

- Using `ClaudeAgentLanguageModel` with `@effect/ai`
- `LanguageModel.generateText()` for simple completions
- `LanguageModel.streamText()` for streaming responses
- Standard `LanguageModel` interface compatibility

## Development

### `type-test.ts`

TypeScript type checking and inference tests. Verifies type safety and IDE experience.

**Key concepts:**

- Type inference validation
- Branded type usage
- Type-safe tool name autocomplete

## Example Categories

**Start here:**

1. `basic-query.ts` - Simplest possible usage
2. `streaming.ts` - Understanding streaming responses
3. `configuration.ts` - Customizing behavior

**Production patterns:**

1. `error-handling.ts` - Robust error recovery
2. `retry-resilience.ts` - Handling transient failures
3. `token-usage.ts` - Cost monitoring

**Advanced topics:**

1. `stream-processing.ts` - Complex stream transformations
2. `service-composition.ts` - Building abstractions
3. `language-model.ts` - Framework integration

## Learn More

- [Package README](../README.md) - Full documentation and API reference
- [Effect documentation](https://effect.website) - Effect-TS framework
- [Claude Agent SDK](https://github.com/anthropics/anthropic-agent-sdk) - Underlying SDK
