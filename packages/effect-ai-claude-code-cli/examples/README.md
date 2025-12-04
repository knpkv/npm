# Examples

Examples demonstrating `@knpkv/effect-ai-claude-code-cli` usage patterns.

## Prerequisites

Claude Code CLI must be installed globally:

```bash
npm install -g claude
```

## Running Examples

```bash
# Install dependencies
pnpm install

# Run any example
npx tsx examples/basic.ts
npx tsx examples/streaming.ts
npx tsx examples/session-resume.ts
```

## Basic Usage

### `basic.ts`

Simplest usage - query with text response.

**Key concepts:**

- Creating client with default config
- Using `client.query()` for text responses
- Effect-based execution with `runPromise`

### `streaming.ts`

Simulated streaming character-by-character output.

**Key concepts:**

- Getting full response with `query()`
- Simulating streaming with delays
- Console output patterns

### `chunk-logging.ts`

Raw chunk processing from CLI stdout.

**Key concepts:**

- Using `queryStream()` for raw chunks
- Processing `StreamChunk` events
- Understanding CLI JSON output structure
- Logging tool calls and message deltas

### `tools.ts`

CLI with allowed tools for enhanced capabilities.

**Key concepts:**

- Configuring `allowedTools` via config layer
- Tool-assisted queries (Read, Bash, Glob)
- Understanding tool execution flow

### `deny-all-tools.ts`

Empty `allowedTools` array - denies all tools.

**Key concepts:**

- Using `allowedTools: []` to deny tools
- Fallback behavior without tools
- Ensuring queries run without tool access

### `session-resume.ts`

Discover and resume existing Claude Code sessions.

**Key concepts:**

- Using `SessionDiscovery.listProjectSessions()` to find sessions
- Resuming sessions with `resumeQuery()` and `resumeQueryStream()`
- Reading session metadata (timestamp, sessionId, projectPath)
- Continuing conversations from previous sessions

## Error Handling

### `error-handling.ts`

Typed error recovery with Effect patterns.

**Key concepts:**

- Using `catchTag` for specific errors
- Handling `CliNotFoundError`, `StreamParsingError`, `ValidationError`
- Graceful degradation

## @effect/ai Integration

### `language-model.ts`

`LanguageModel` integration with `@effect/ai`.

**Key concepts:**

- Using `ClaudeCodeCliLanguageModel` with `@effect/ai`
- `LanguageModel.generateText()` for completions
- `LanguageModel.streamText()` for streaming
- Standard `LanguageModel` interface compatibility

## Development

### `type-test.ts`

TypeScript type checking and inference validation.

**Key concepts:**

- Type inference validation
- Branded type usage (ToolName, FilePath, etc.)
- Type-safe CLI configuration

## Example Categories

**Start here:**

1. `basic.ts` - Simplest possible usage
2. `streaming.ts` - Understanding output
3. `tools.ts` - Tool configuration

**Advanced:**

1. `chunk-logging.ts` - Raw stream processing
2. `error-handling.ts` - Error recovery
3. `language-model.ts` - Framework integration

## Learn More

- [Package README](../README.md) - Full documentation and API reference
- [Effect documentation](https://effect.website) - Effect-TS framework
- [Claude Code CLI](https://claude.com/claude-code) - Underlying CLI
