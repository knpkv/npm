import { Config, Effect, Option } from "effect"
import type * as AiError from "effect/unstable/ai/AiError"
import type { CodexModelOptions } from "../model.js"
import { configurationFailure, invalidRequest } from "./errors.js"

const DEFAULT_EXECUTABLE = "codex"
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
const DEFAULT_MAX_PROMPT_BYTES = 1_048_576
const DEFAULT_MAX_STDERR_BYTES = 65_536
const DEFAULT_TIMEOUT = "2 minutes"
const textEncoder = new TextEncoder()

/**
 * Codex capabilities that can discover host configuration, invoke tools, or
 * contact external systems. Prompt-only turns receive supplied text and must
 * never gain one of these capabilities from a user's Codex installation.
 *
 * Keep this list synchronized with `codex features list`; new host-facing
 * features require an explicit classification before prompt-only use.
 */
export const PROMPT_ONLY_DISABLED_FEATURES: ReadonlyArray<string> = Object.freeze([
  "apply_patch_freeform",
  "apply_patch_streaming_events",
  "apps",
  "apps_mcp_path_override",
  "artifact",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode",
  "code_mode_buffered_exec",
  "code_mode_host",
  "code_mode_only",
  "computer_use",
  "codex_git_commit",
  "default_mode_request_user_input",
  "deferred_executor",
  "deferred_tool_world_state",
  "enable_mcp_apps",
  "enable_fanout",
  "exec_permission_approvals",
  "executor_capability_discovery",
  "external_agent_memory_import",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "js_repl",
  "js_repl_tools_only",
  "mcp_2026_07_28",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "multi_agent_mode",
  "network_proxy",
  "non_prefixed_mcp_tool_names",
  "plugin_hooks",
  "plugin_sharing",
  "plugins",
  "remote_control",
  "remote_models",
  "remote_plugin",
  "request_permissions_tool",
  "request_rule",
  "respect_system_proxy",
  "search_tool",
  "shell_snapshot",
  "shell_tool",
  "shell_zsh_fork",
  "skill_env_var_dependency_prompt",
  "skill_mcp_dependency_install",
  "skill_search",
  "standalone_web_search",
  "tool_call_mcp_elicitation",
  "tool_search",
  "tool_search_always_defer_mcp_tools",
  "tool_suggest",
  "tui_app_server",
  "unavailable_dummy_tools",
  "undo",
  "unified_exec",
  "unified_exec_zsh_fork",
  "use_agent_identity",
  "web_search_cached",
  "web_search_request",
  "workspace_dependencies"
])

/** Installed features that do not add a host or external capability. */
export const PROMPT_ONLY_SAFE_FEATURES: ReadonlyArray<string> = Object.freeze([
  "chronicle",
  "collaboration_modes",
  "concurrent_reasoning_summaries",
  "current_time_reminder",
  "elevated_windows_sandbox",
  "enable_request_compression",
  "experimental_windows_sandbox",
  "external_migration",
  "fast_mode",
  "guardian_approval",
  "guardianv2",
  "image_detail_original",
  "in_app_updates",
  "item_ids",
  "local_thread_store_compression",
  "mentions_v2",
  "personality",
  "prevent_idle_sleep",
  "realtime_conversation",
  "remote_compaction_v2",
  "resize_all_images",
  "responses_websockets",
  "responses_websockets_v2",
  "rollout_budget",
  "runtime_metrics",
  "secret_auth_storage",
  "sqlite",
  "steer",
  "terminal_resize_reflow",
  "terminal_visualization_instructions",
  "token_budget",
  "use_legacy_landlock",
  "use_linux_sandbox_bwrap",
  "workspace_owner_usage_nudge"
])

const optionalEnvironmentValue = (name: string) => Config.option(Config.string(name))

const reviewedChildEnvironment = Config.all({
  codexAccessToken: optionalEnvironmentValue("CODEX_ACCESS_TOKEN"),
  codexApiKey: optionalEnvironmentValue("CODEX_API_KEY"),
  codexCaCertificate: optionalEnvironmentValue("CODEX_CA_CERTIFICATE"),
  codexHome: optionalEnvironmentValue("CODEX_HOME"),
  codexSqliteHome: optionalEnvironmentValue("CODEX_SQLITE_HOME"),
  home: optionalEnvironmentValue("HOME"),
  path: optionalEnvironmentValue("PATH"),
  rustLog: optionalEnvironmentValue("RUST_LOG"),
  sslCertFile: optionalEnvironmentValue("SSL_CERT_FILE"),
  temp: optionalEnvironmentValue("TEMP"),
  tmp: optionalEnvironmentValue("TMP"),
  tmpdir: optionalEnvironmentValue("TMPDIR"),
  userProfile: optionalEnvironmentValue("USERPROFILE"),
  xdgConfigHome: optionalEnvironmentValue("XDG_CONFIG_HOME")
}).pipe(
  Config.map((configured) => ({
    ...(Option.isSome(configured.codexAccessToken) ? { CODEX_ACCESS_TOKEN: configured.codexAccessToken.value } : {}),
    ...(Option.isSome(configured.codexApiKey) ? { CODEX_API_KEY: configured.codexApiKey.value } : {}),
    ...(Option.isSome(configured.codexCaCertificate)
      ? { CODEX_CA_CERTIFICATE: configured.codexCaCertificate.value }
      : {}),
    ...(Option.isSome(configured.codexHome) ? { CODEX_HOME: configured.codexHome.value } : {}),
    ...(Option.isSome(configured.codexSqliteHome)
      ? { CODEX_SQLITE_HOME: configured.codexSqliteHome.value }
      : {}),
    ...(Option.isSome(configured.home) ? { HOME: configured.home.value } : {}),
    ...(Option.isSome(configured.path) ? { PATH: configured.path.value } : {}),
    ...(Option.isSome(configured.rustLog) ? { RUST_LOG: configured.rustLog.value } : {}),
    ...(Option.isSome(configured.sslCertFile) ? { SSL_CERT_FILE: configured.sslCertFile.value } : {}),
    ...(Option.isSome(configured.temp) ? { TEMP: configured.temp.value } : {}),
    ...(Option.isSome(configured.tmp) ? { TMP: configured.tmp.value } : {}),
    ...(Option.isSome(configured.tmpdir) ? { TMPDIR: configured.tmpdir.value } : {}),
    ...(Option.isSome(configured.userProfile) ? { USERPROFILE: configured.userProfile.value } : {}),
    ...(Option.isSome(configured.xdgConfigHome) ? { XDG_CONFIG_HOME: configured.xdgConfigHome.value } : {})
  }))
)

export interface NormalizedOptions {
  readonly access: "read-only" | "workspace-write"
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly executable: string
  readonly maxOutputBytes: number
  readonly maxPromptBytes: number
  readonly maxStderrBytes: number
  readonly model: string | undefined
  readonly promptOnly: boolean
  readonly timeout: NonNullable<CodexModelOptions["timeout"]>
}

export const normalizeOptions = (
  options: CodexModelOptions,
  method: string
): Effect.Effect<NormalizedOptions, AiError.AiError> =>
  Effect.gen(function*() {
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const maxPromptBytes = options.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES
    const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      return yield* invalidRequest(method, "maxOutputBytes", "must be a positive safe integer")
    }
    if (!Number.isSafeInteger(maxStderrBytes) || maxStderrBytes <= 0) {
      return yield* invalidRequest(method, "maxStderrBytes", "must be a positive safe integer")
    }
    if (!Number.isSafeInteger(maxPromptBytes) || maxPromptBytes <= 0) {
      return yield* invalidRequest(method, "maxPromptBytes", "must be a positive safe integer")
    }
    if (options.cwd.trim().length === 0) {
      return yield* invalidRequest(method, "cwd", "must not be empty")
    }
    return {
      access: options.access ?? "read-only",
      cwd: options.cwd,
      environment: {
        ...yield* reviewedChildEnvironment.pipe(
          Effect.mapError((cause) => configurationFailure(method, cause))
        ),
        ...options.environment
      },
      executable: options.executable ?? DEFAULT_EXECUTABLE,
      maxOutputBytes,
      maxPromptBytes,
      maxStderrBytes,
      model: options.model,
      promptOnly: options.promptOnly ?? false,
      timeout: options.timeout ?? DEFAULT_TIMEOUT
    }
  })

export const validatePrompt = Effect.fn("CodexConfiguration.validatePrompt")(function*(
  prompt: string,
  maximumBytes: number,
  method: string
) {
  const bytes = textEncoder.encode(prompt).byteLength
  if (bytes > maximumBytes) {
    return yield* invalidRequest(
      method,
      "prompt",
      `must not exceed ${maximumBytes} UTF-8 bytes`
    )
  }
  return prompt
})

export const makeArguments = (
  options: NormalizedOptions,
  schemaFile: string | undefined,
  promptOnlyDisabledFeatures: ReadonlyArray<string> = []
): ReadonlyArray<string> => {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--sandbox",
    options.access,
    "--skip-git-repo-check"
  ]
  if (options.promptOnly) {
    args.push(
      "--ignore-user-config",
      "--ignore-rules",
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      "shell_environment_policy.inherit=none"
    )
    for (const feature of promptOnlyDisabledFeatures) {
      args.push("--disable", feature)
    }
  }
  if (options.model !== undefined) args.push("--model", options.model)
  if (schemaFile !== undefined) args.push("--output-schema", schemaFile)
  args.push("-")
  return Object.freeze(args)
}
