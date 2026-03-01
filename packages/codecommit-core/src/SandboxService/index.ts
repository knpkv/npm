/**
 * Sandbox service — lifecycle management for code sandboxes.
 *
 * @module
 */
export { DockerService } from "./DockerService.js"
export type { ContainerConfig, ContainerInfo } from "./DockerService.js"
export { makeClaudeCodePlugin } from "./plugins/ClaudeCodePlugin.js"
export { PluginService } from "./PluginService.js"
export type { SandboxContext, SandboxPlugin } from "./PluginService.js"
export { SandboxService } from "./SandboxService.js"
export type { CreateSandboxParams } from "./SandboxService.js"
