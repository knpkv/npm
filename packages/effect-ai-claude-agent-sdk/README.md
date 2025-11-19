# @knpkv/effect-ai-claude-agent-sdk

Effect-TS wrapper for the Anthropic Claude Agent SDK with type-safe integration.

## Installation

```bash
pnpm add @knpkv/effect-ai-claude-agent-sdk @anthropic-ai/claude-agent-sdk effect
```

## Authentication

**ANTHROPIC_API_KEY is optional** if running on an authenticated machine with Claude Code Pro/Max subscription. The SDK will use authentication automatically.

For unauthenticated environments, set your API key:

```bash
export ANTHROPIC_API_KEY=your-key-here
```

Get your API key from: https://console.anthropic.com/

## Quick Start

```typescript
import { Effect } from "effect"
import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk"

const program = Effect.gen(function* () {
  const client = yield* AgentClient.ClaudeAgentClient.ClaudeAgentClient

  const result = yield* client.queryText({
    prompt: "What is Effect?"
  })

  console.log(result)
})

Effect.runPromise(program.pipe(Effect.provide(AgentClient.ClaudeAgentClient.layer())))
```

## Features

- ✅ Type-safe Effect wrapper for Claude Agent SDK
- ✅ Stream-based message handling with backpressure
- ✅ Service-based architecture with Layer composition
- ✅ Comprehensive error handling with tagged errors
- ✅ Full TypeScript support with strict mode
- ✅ JSDoc documentation for all public APIs
- ✅ Type-safe tool names with IDE autocomplete
- ✅ Token usage tracking (per-message and aggregate)

## Architecture

The package follows Effect-TS best practices:

- **Services**: `ClaudeAgentClient`, `ClaudeAgentConfig`
- **Layers**: Dependency injection via Effect Layer
- **Streams**: Backpressure-aware message streaming
- **Errors**: Tagged errors for type-safe error handling

## Configuration

```typescript
import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk"
import * as AgentConfig from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentConfig"

const configLayer = AgentConfig.layer({
  apiKeySource: "project",
  workingDirectory: "/my/project",
  allowedTools: ["Read", "Write", "Edit"] // IDE autocomplete for known tools
})

const program = Effect.gen(function* () {
  const client = yield* AgentClient.ClaudeAgentClient.ClaudeAgentClient
  // Use client...
})

Effect.runPromise(
  program.pipe(Effect.provide(AgentClient.ClaudeAgentClient.layerConfig()), Effect.provide(configLayer))
)
```

## API Reference

### ClaudeAgentClient

Main client service for executing queries.

- `query(options)`: Execute query and return converted message stream (MessageEvent)
- `queryRaw(options)`: Execute query and return raw SDK message stream (unconverted)
- `queryText(options)`: Execute query and collect text response

### ClaudeAgentConfig

Configuration service for customizing SDK behavior.

- `layer(options)`: Create config layer with options
- `make(options)`: Create config service

### Error Types

- `SdkError`: SDK initialization or execution errors
- `StreamError`: Message streaming failures
- `ToolError`: Tool execution failures
- `ValidationError`: Input validation failures
- `PermissionError`: Tool permission denials

## Examples

See the `examples/` directory for comprehensive usage patterns:

### Basic Usage

- **`basic-query.ts`** - Simple query execution and text response
- **`streaming.ts`** - Stream message-by-message processing
- **`stream-processing.ts`** - Advanced stream filtering and transformation
- **`chunk-logging.ts`** - Detailed chunk logging with tool calls
- **`tools.ts`** - Using SDK with allowed tools for enhanced capabilities
- **`deny-all-tools.ts`** - Empty allowedTools array (demonstrates limitation)
- **`token-usage.ts`** - Track token usage and API costs

### Error Handling & Resilience

- **`error-handling.ts`** - Typed error recovery with catchTag
- **`retry-resilience.ts`** - Retry logic and timeout patterns

### Configuration & Composition

- **`configuration.ts`** - Custom configuration with layers
- **`service-composition.ts`** - Building services on top of ClaudeAgentClient

### @effect/ai Integration

- **`language-model.ts`** - LanguageModel integration with generateText and streamText

### Running Examples

```bash
# Install dependencies
pnpm install

# Run an example
# Note: ANTHROPIC_API_KEY is optional on authenticated machines
# (Claude Code Pro/Max subscription)
npx tsx examples/basic-query.ts
npx tsx examples/streaming.ts
npx tsx examples/error-handling.ts
npx tsx examples/chunk-logging.ts
npx tsx examples/tools.ts
npx tsx examples/language-model.ts
```

### Integration Tests

Integration tests verify compatibility with the latest `@anthropic-ai/claude-agent-sdk`:

```bash
# Run integration tests
# Note: ANTHROPIC_API_KEY is optional on authenticated machines
# (Claude Code Pro/Max subscription). Otherwise:
export ANTHROPIC_API_KEY=your-key-here
pnpm test:integration
```

These tests run automatically:

- **Twice daily** via GitHub Actions (9-10 AM and 6-7 PM CET)
- **On demand** via workflow dispatch
- **On PRs** that modify integration tests or SDK packages

If a test fails, it indicates a potential breaking change in the Anthropic SDK.

## Known Limitations

This package is actively developed. Current limitations:

### Not Yet Implemented

1. **Lifecycle Hooks**: The `ClaudeAgentHook` module provides type definitions for lifecycle hooks (SessionStart, PreToolUse, etc.), but hook execution is not implemented. Hooks defined in query options will not be called.

### Maintenance Requirements

2. **Tool Synchronization**: The `Tool.allTools` array must be manually kept in sync with tools added to the Claude Agent SDK. When new tools are added upstream, they should be added to `ClaudeAgentTool.ts`.

### API Compatibility

3. **SDK Dependency**: This package wraps `@anthropic-ai/claude-agent-sdk` and may lag behind SDK updates. Integration tests run twice daily to detect breaking changes.

## License

MIT

## Author

knpkv
