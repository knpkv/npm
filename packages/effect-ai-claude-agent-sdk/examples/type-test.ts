/**
 * Type safety test for ToolNameOrString autocomplete.
 *
 * This file demonstrates that IDE autocomplete works for known tool names
 * while still allowing custom tool names.
 */
import * as AgentTool from "../src/ClaudeAgentTool.js"

// Test autocomplete for allowedTools array - should suggest all 16 known tools
const _tools1: ReadonlyArray<AgentTool.ToolNameOrString> = [
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

// Test autocomplete in allowList helper
const _callback1 = AgentTool.allowList(["Read", "Grep", "Glob"])

// Test autocomplete in denyList helper
const _callback2 = AgentTool.denyList(["Bash", "KillShell"])

// Test KnownToolName type
const _knownTool: AgentTool.KnownToolName = "Read"

// All 16 known tools
const allKnownTools: ReadonlyArray<AgentTool.KnownToolName> = AgentTool.allTools

console.log("✓ Type safety test passed!")
console.log(`✓ ${allKnownTools.length} known tools available with autocomplete`)
console.log("✓ Custom tool names also supported")
