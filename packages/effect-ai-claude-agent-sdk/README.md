# @knpkv/effect-ai-claude-agent-sdk

Effect-TS wrapper for the Anthropic Claude Agent SDK with type-safe integration.

## Installation

```bash
pnpm add @knpkv/effect-ai-claude-agent-sdk @anthropic-ai/claude-agent-sdk effect
```

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

# Run an example (requires ANTHROPIC_API_KEY)
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
# Run integration tests (requires ANTHROPIC_API_KEY)
export ANTHROPIC_API_KEY=your-key-here
pnpm test:integration
```

These tests run automatically:

- **Twice daily** via GitHub Actions (9-10 AM and 6-7 PM CET)
- **On demand** via workflow dispatch
- **On PRs** that modify integration tests or SDK packages

If a test fails, it indicates a potential breaking change in the Anthropic SDK.

## Development Status & Limitations

**Important Limitations**:

1. **Hooks Not Implemented**: The ClaudeAgentHook module defines types for lifecycle hooks, but hook execution is not yet implemented. Hook handlers will be added in a future version.

**Note**: This package is in early development.

## License

MIT

## Author

knpkv
