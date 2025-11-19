/**
 * Type safety test for ToolNameOrString autocomplete.
 *
 * This file demonstrates that IDE autocomplete works for known tool names
 * while still allowing custom tool names.
 *
 * @since 1.0.0
 */
import * as CliTool from "../src/ClaudeCodeCliTool.js"

// Test autocomplete for allowedTools array - should suggest all 16 known tools
const tools1: ReadonlyArray<CliTool.ToolNameOrString> = [
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
  "KillShell",
  "my-custom-tool" // Custom strings also allowed
]

// Test KnownToolName type
const knownTool: CliTool.KnownToolName = "Read"

// All 16 known tools
const allKnownTools: ReadonlyArray<CliTool.KnownToolName> = CliTool.allTools

console.log("✓ Type safety test passed!")
console.log(`✓ ${allKnownTools.length} known tools available with autocomplete`)
console.log(`✓ Custom tool names also supported (${tools1.length} tools configured)`)
console.log(`✓ Known tool example: ${knownTool}`)
