# @knpkv/effect-ai-claude-code-cli

Effect-TS wrapper for [Claude Code CLI](https://github.com/anthropics/claude-code) with [@effect/ai](https://effect.website/docs/ai/introduction) integration.

Provides a type-safe, functional interface to programmatically interact with Claude Code CLI, including:

- Non-blocking query execution
- Streaming responses with full event support
- Tool call visibility (Read, Write, Bash, etc.)
- Comprehensive error handling
- @effect/ai LanguageModel integration
- Type-safe tool names with IDE autocomplete

## Installation

```bash
npm install @knpkv/effect-ai-claude-code-cli effect
```

**Prerequisites:**

- [Claude Code CLI](https://github.com/anthropics/claude-code) installed globally
- Node.js 18+
- Effect-TS 3.x

```bash
npm install -g @anthropics/claude-code
```

## Quick Start

### Basic Query

```typescript
import { ClaudeCodeCliClient } from "@knpkv/effect-ai-claude-code-cli"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const client = yield* ClaudeCodeCliClient.ClaudeCodeCliClient
  const response = yield* client.query("What is Effect-TS?")
  console.log(response)
})

Effect.runPromise(program.pipe(Effect.provide(ClaudeCodeCliClient.layer())))
```

### Streaming Responses

```typescript
import { ClaudeCodeCliClient } from "@knpkv/effect-ai-claude-code-cli"
import { Effect, Stream } from "effect"

const program = Effect.gen(function* () {
  const client = yield* ClaudeCodeCliClient.ClaudeCodeCliClient
  const stream = client.queryStream("Write a haiku about TypeScript")

  yield* stream.pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        if (chunk.type === "text") {
          process.stdout.write(chunk.text)
        }
      })
    )
  )
})

Effect.runPromise(program.pipe(Effect.provide(ClaudeCodeCliClient.layer())))
```

### @effect/ai Integration

```typescript
import { LanguageModel } from "@effect/ai"
import { ClaudeCodeCliClient, ClaudeCodeCliLanguageModel } from "@knpkv/effect-ai-claude-code-cli"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const model = yield* LanguageModel.LanguageModel
  const response = yield* model.generateText({
    prompt: [{ role: "user", content: [{ type: "text", text: "Explain monads" }] }]
  })

  console.log(response.text)
  console.log("Usage:", response.usage)
})

Effect.runPromise(
  program.pipe(Effect.provide(ClaudeCodeCliLanguageModel.layer()), Effect.provide(ClaudeCodeCliClient.layer()))
)
```

## Configuration

### Tool Permissions

Control which tools Claude can use:

```typescript
import { ClaudeCodeCliConfig } from "@knpkv/effect-ai-claude-code-cli"
import { Layer } from "effect"

const config = Layer.succeed(
  ClaudeCodeCliConfig.ClaudeCodeCliConfig,
  ClaudeCodeCliConfig.ClaudeCodeCliConfig.of({
    allowedTools: ["Read", "Glob", "Bash"], // IDE autocomplete for known tools
    disallowedTools: ["Write", "Edit"]
  })
)

Effect.runPromise(program.pipe(Effect.provide(ClaudeCodeCliClient.layer()), Effect.provide(config)))
```

### Model Selection

```typescript
const config = ClaudeCodeCliConfig.ClaudeCodeCliConfig.of({
  model: "claude-sonnet-4-5"
})
```

## Streaming Events

The client emits detailed chunk types for comprehensive event handling:

### Chunk Types

- **TextChunk** - Text content deltas
- **ToolUseStartChunk** - Tool invocation begins (includes tool name and ID)
- **ToolInputChunk** - Tool input JSON streaming
- **ContentBlockStartChunk** - Content block boundaries
- **ContentBlockStopChunk** - Content block completion
- **MessageStartChunk** - Message metadata (model, usage)
- **MessageDeltaChunk** - Updates (stop_reason, usage)
- **MessageStopChunk** - Stream completion

### Example: Logging All Events

```typescript
const stream = client.queryStream("Read package.json and summarize it")

yield *
  stream.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        switch (chunk.type) {
          case "text":
            yield* Console.log("Text:", chunk.text)
            break
          case "tool_use_start":
            yield* Console.log(`Tool: ${chunk.name} (${chunk.id})`)
            break
          case "tool_input":
            yield* Console.log("Input:", chunk.partialJson)
            break
          case "message_delta":
            yield* Console.log("Usage:", chunk.usage)
            break
        }
      })
    )
  )
```

## Type Safety Features

### Branded Types

The package provides branded types for critical identifiers to prevent string confusion:

```typescript
import { Brand, Validation } from "@knpkv/effect-ai-claude-code-cli"

// Validate and construct branded types
const model = yield * Validation.validateModel("claude-4-sonnet-20250514") // ModelId
const prompt = yield * Validation.validatePrompt("Your prompt here") // PromptText
const tool = yield * Validation.validateToolName("Read") // ToolName
```

### Input Validation

Comprehensive validation functions ensure inputs meet requirements:

```typescript
import { Validation } from "@knpkv/effect-ai-claude-code-cli"

// Validate prompt (non-empty, length limits)
const prompt = yield * Validation.validatePrompt("Explain TypeScript")

// Validate model ID (starts with "claude-")
const model = yield * Validation.validateModel("claude-4-sonnet")

// Validate tool name (PascalCase format)
const tool = yield * Validation.validateToolName("Read", false) // strict mode optional

// Validate file path (no null bytes, no path traversal)
const path = yield * Validation.validateFilePath("/home/user/file.txt")

// Validate timeout (1s to 10min)
const timeout = yield * Validation.validateTimeout(30000)

// Validate multiple tools
const tools = yield * Validation.validateTools(["Read", "Write", "Bash"])
```

### Type Guards

Helper functions for working with stream chunks:

```typescript
import { TypeGuards } from "@knpkv/effect-ai-claude-code-cli"
import { Stream } from "effect"

// Filter to only text chunks
const textStream = stream.pipe(Stream.filter(TypeGuards.isTextChunk))

// Extract usage information
const usage = stream.pipe(
  Stream.filterMap((chunk) => TypeGuards.extractUsage(chunk)),
  Stream.runLast
)
```

### CLI Version Checking

Ensure CLI compatibility:

```typescript
import { CliVersion } from "@knpkv/effect-ai-claude-code-cli"

const program = Effect.gen(function* () {
  // Check CLI version on startup
  yield* CliVersion.checkCliVersion() // Validates minimum version

  const client = yield* ClaudeCodeCliClient.ClaudeCodeCliClient
  // ... use client
})
```

## Error Handling

The package provides typed error handling with specific error types:

```typescript
import { ClaudeCodeCliError } from "@knpkv/effect-ai-claude-code-cli"
import { Match } from "effect"

const handleError = Match.type<ClaudeCodeCliError.ClaudeCodeCliError>().pipe(
  Match.tag("CliNotFoundError", () => Console.error("Claude CLI not found. Install: npm i -g @anthropics/claude-code")),
  Match.tag("RateLimitError", (error) => Console.error(`Rate limited. Retry after ${error.retryAfter}s`)),
  Match.tag("InvalidApiKeyError", (error) => Console.error("Invalid API key:", error.stderr)),
  Match.tag("ValidationError", (error) => Console.error("Validation failed:", error.message)),
  Match.tag("CliVersionMismatchError", (error) =>
    Console.error(`Version ${error.installed} < required ${error.required}`)
  ),
  Match.tag("StreamParsingError", (error) => Console.error(`Parse error at line: ${error.line}`)),
  Match.orElse((error) => Console.error("Error:", error))
)

Effect.runPromise(program.pipe(Effect.catchAll(handleError), Effect.provide(ClaudeCodeCliClient.layer())))
```

## API Reference

### ClaudeCodeCliClient

**Service Tag:** `ClaudeCodeCliClient.ClaudeCodeCliClient`

#### Methods

- `query(prompt: string): Effect<string, ClaudeCodeCliError>` - Execute non-streaming query
- `queryStream(prompt: string): Stream<MessageChunk, ClaudeCodeCliError>` - Stream response with full event visibility

#### Layers

- `layer(): Layer<ClaudeCodeCliClient, never, ClaudeCodeCliConfig>` - Default layer
- `layerConfig(config): Layer<ClaudeCodeCliClient>` - Layer with inline config

### ClaudeCodeCliConfig

**Service Tag:** `ClaudeCodeCliConfig.ClaudeCodeCliConfig`

#### Configuration

```typescript
interface ClaudeCodeCliConfig {
  model?: string // Model name (default: from CLI config)
  allowedTools?: ReadonlyArray<ToolNameOrString> // Allowed tools with autocomplete
  disallowedTools?: ReadonlyArray<ToolNameOrString> // Disallowed tools with autocomplete
}
```

#### Layers

- `ClaudeCodeCliConfig.default` - Empty configuration (uses CLI defaults)

### ClaudeCodeCliLanguageModel

**Service Tag:** `LanguageModel.LanguageModel` (from @effect/ai)

#### Layers

- `layer(config?): Layer<LanguageModel, never, ClaudeCodeCliClient>` - @effect/ai integration

#### Model Constructor

- `model(config?): AiModel<"claude-code-cli", LanguageModel, ClaudeCodeCliClient>`

## Examples

See the [examples](./examples) directory for complete working examples:

- **[basic.ts](./examples/basic.ts)** - Simple query
- **[streaming.ts](./examples/streaming.ts)** - Streaming responses
- **[tools.ts](./examples/tools.ts)** - Tool permissions
- **[error-handling.ts](./examples/error-handling.ts)** - Error handling patterns
- **[language-model.ts](./examples/language-model.ts)** - @effect/ai integration
- **[chunk-logging.ts](./examples/chunk-logging.ts)** - Complete event visibility

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Type check
pnpm check

# Lint
pnpm lint

# Build
pnpm build
```

## Architecture

This package follows Effect-TS patterns:

- **Services** - Context.Tag-based dependency injection
- **Layers** - Composable service providers
- **Effects** - Typed, referentially transparent computations
- **Streams** - Incremental, backpressure-aware processing
- **Errors** - Typed error channel with discriminated unions

## License

MIT

## Links

- [Effect Documentation](https://effect.website)
- [@effect/ai Documentation](https://effect.website/docs/ai/introduction)
- [Claude Code CLI](https://github.com/anthropics/claude-code)
- [GitHub Repository](https://github.com/knpkv/npm)
