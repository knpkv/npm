/**
 * Provider-defined tools for Claude Code CLI built-in tools.
 */
import * as Tool from "@effect/ai/Tool"
import * as Schema from "effect/Schema"

/**
 * Execute bash commands via Claude Code CLI's Bash tool.
 *
 * @example
 * ```typescript
 * import { ClaudeCodeCliTool } from "@knpkv/effect-ai-claude-code-cli"
 *
 * const bashTool = ClaudeCodeCliTool.Bash
 * ```
 *
 * @category Tools
 */
export const Bash = Tool.providerDefined({
  id: "claude_code_cli.bash",
  toolkitName: "ClaudeCodeCliBash",
  providerName: "Bash",
  args: {},
  requiresHandler: true,
  success: Schema.String,
  parameters: {
    /**
     * The bash command to execute.
     */
    command: Schema.NonEmptyString
  }
})

/**
 * Read file contents via Claude Code CLI's Read tool.
 *
 * @example
 * ```typescript
 * import { ClaudeCodeCliTool } from "@knpkv/effect-ai-claude-code-cli"
 *
 * const readTool = ClaudeCodeCliTool.Read
 * ```
 *
 * @category Tools
 */
export const Read = Tool.providerDefined({
  id: "claude_code_cli.read",
  toolkitName: "ClaudeCodeCliRead",
  providerName: "Read",
  args: {},
  requiresHandler: true,
  success: Schema.String,
  parameters: {
    /**
     * The absolute path to the file to read.
     */
    file_path: Schema.NonEmptyString,
    /**
     * Optional line offset to start reading from.
     */
    offset: Schema.optional(Schema.Number),
    /**
     * Optional number of lines to read.
     */
    limit: Schema.optional(Schema.Number)
  }
})

/**
 * Edit file contents via Claude Code CLI's Edit tool.
 *
 * @example
 * ```typescript
 * import { ClaudeCodeCliTool } from "@knpkv/effect-ai-claude-code-cli"
 *
 * const editTool = ClaudeCodeCliTool.Edit
 * ```
 *
 * @category Tools
 */
export const Edit = Tool.providerDefined({
  id: "claude_code_cli.edit",
  toolkitName: "ClaudeCodeCliEdit",
  providerName: "Edit",
  args: {},
  requiresHandler: true,
  success: Schema.String,
  parameters: {
    /**
     * The absolute path to the file to edit.
     */
    file_path: Schema.NonEmptyString,
    /**
     * The text to replace.
     */
    old_string: Schema.String,
    /**
     * The text to replace it with.
     */
    new_string: Schema.String,
    /**
     * Replace all occurrences (default: false).
     */
    replace_all: Schema.optional(Schema.Boolean)
  }
})

/**
 * Search file contents via Claude Code CLI's Grep tool.
 *
 * @example
 * ```typescript
 * import { ClaudeCodeCliTool } from "@knpkv/effect-ai-claude-code-cli"
 *
 * const grepTool = ClaudeCodeCliTool.Grep
 * ```
 *
 * @category Tools
 */
export const Grep = Tool.providerDefined({
  id: "claude_code_cli.grep",
  toolkitName: "ClaudeCodeCliGrep",
  providerName: "Grep",
  args: {},
  requiresHandler: true,
  success: Schema.String,
  parameters: {
    /**
     * The regular expression pattern to search for.
     */
    pattern: Schema.NonEmptyString,
    /**
     * Optional file or directory to search in.
     */
    path: Schema.optional(Schema.String),
    /**
     * Optional glob pattern to filter files.
     */
    glob: Schema.optional(Schema.String),
    /**
     * Case insensitive search.
     */
    "-i": Schema.optional(Schema.Boolean),
    /**
     * Output mode: "content", "files_with_matches", or "count".
     */
    output_mode: Schema.optional(Schema.Literal("content", "files_with_matches", "count"))
  }
})

/**
 * Find files by pattern via Claude Code CLI's Glob tool.
 *
 * @example
 * ```typescript
 * import { ClaudeCodeCliTool } from "@knpkv/effect-ai-claude-code-cli"
 *
 * const globTool = ClaudeCodeCliTool.Glob
 * ```
 *
 * @category Tools
 */
export const Glob = Tool.providerDefined({
  id: "claude_code_cli.glob",
  toolkitName: "ClaudeCodeCliGlob",
  providerName: "Glob",
  args: {},
  requiresHandler: true,
  success: Schema.String,
  parameters: {
    /**
     * The glob pattern to match files against.
     */
    pattern: Schema.NonEmptyString,
    /**
     * Optional directory to search in.
     */
    path: Schema.optional(Schema.String)
  }
})

/**
 * Map of provider tool names to toolkit names.
 *
 * @internal
 */
const ProviderToolNamesMap: Map<string, string> = new Map([
  ["Bash", "ClaudeCodeCliBash"],
  ["Read", "ClaudeCodeCliRead"],
  ["Edit", "ClaudeCodeCliEdit"],
  ["Grep", "ClaudeCodeCliGrep"],
  ["Glob", "ClaudeCodeCliGlob"]
])

/**
 * Get the toolkit name for a provider-defined tool.
 *
 * @param name - The provider tool name
 * @returns The toolkit name, or undefined if not a provider-defined tool
 *
 * @example
 * ```typescript
 * import { ClaudeCodeCliTool } from "@knpkv/effect-ai-claude-code-cli"
 *
 * const toolkitName = ClaudeCodeCliTool.getProviderDefinedToolName("Bash")
 * // Returns: "ClaudeCodeCliBash"
 * ```
 *
 * @category Tool Calling
 */
export const getProviderDefinedToolName = (name: string): string | undefined => ProviderToolNamesMap.get(name)

/**
 * All 16 built-in tools available in the Claude Code CLI.
 *
 * @example
 * ```typescript
 * import * as Tool from "@knpkv/effect-ai-claude-code-cli/ClaudeCodeCliTool"
 *
 * // Use specific tools
 * const config = {
 *   allowedTools: Tool.allTools.slice(0, 3) // Read, Write, Edit
 * }
 * ```
 *
 * @category Tools
 */
export const allTools = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Task",
  "SlashCommand",
  "Skill",
  "TodoWrite",
  "AskUserQuestion",
  "NotebookEdit",
  "BashOutput",
  "KillShell"
] as const

/**
 * Union type of all known tool names.
 *
 * @category Tools
 */
export type KnownToolName = (typeof allTools)[number]

/**
 * Tool name that can be either a known tool or a custom string.
 *
 * Provides autocomplete for known tools while allowing custom tool names.
 *
 * @category Tools
 */
export type ToolNameOrString = KnownToolName | (string & {})
