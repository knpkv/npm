# Prompt-only feature review

## Codex 0.154.0

Reviewed the installed `codex-cli 0.154.0` inventory against its
[tagged feature definitions](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/features/src/lib.rs).
The independent fixture `test/fixtures/codex-0.154.0.ts` captures all 140 names
using `codex features list`, without generation. **Safe** preserves the CLI's
default; **Disable** removes unnecessary capabilities.

| Feature                     | Decision | Reason                                                                            |
| --------------------------- | -------- | --------------------------------------------------------------------------------- |
| `guardianv2.thread_context` | Safe     | Chooses the approval reviewers' thread context; grants no tool authority          |
| `reasoning_effort_override` | Safe     | Sends response configuration when reasoning effort changes                        |
| `unified_exec_tty`          | Disable  | Allows commands to allocate interactive terminals                                 |
| `windows_sandbox_service`   | Safe     | Selects service-backed Windows sandbox provisioning; preserves sandbox safeguards |
| `worktrees`                 | Disable  | Creates managed worktrees and discovers repository context                        |

The regression first failed with the five unclassified names above. It now
crosses inventory negotiation and checks the emitted tool disables while
leaving safeguards alone. The 0.153.4 fixture still passes without receiving
new unsupported disables. An unknown future feature still prevents generation.
This verifies CLI compatibility, not provider authentication or model availability.

## Codex 0.153.4

Reviewed the installed `codex-cli 0.153.4` inventory against its
[tagged feature definitions](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/features/src/lib.rs).
The independent fixture in `test/fixtures/codex-0.153.4.ts` contains all 135
installed names. This review used version and inventory commands, not generation.

The 31 additions have these explicit decisions. **Safe** leaves the CLI default
unchanged; it does not enable the feature. **Disable** excludes unnecessary
authority or behavior whose prompt-only boundary is uncertain.

| Feature                                   | Decision | Reason                               |
| ----------------------------------------- | -------- | ------------------------------------ |
| `apply_patch_preserve_line_endings`       | Safe     | Formatting, not tool registration    |
| `background_paginated_rollout_migration`  | Disable  | Migrates unrelated stored history    |
| `bedrock_setup_wizard`                    | Disable  | Provider sign-in onboarding          |
| `code_mode_interrupt`                     | Safe     | Cancels interrupted code cells       |
| `code_mode_prewarm`                       | Disable  | Starts host connection               |
| `compaction_image_budget`                 | Safe     | Existing-image budget                |
| `content_item_kinds`                      | Safe     | Response metadata                    |
| `context_management`                      | Disable  | Experimental boundary unspecified    |
| `cwd_relative_turn_diffs`                 | Safe     | Diff display paths                   |
| `guardian_enhanced_node_repl_transcripts` | Disable  | Supplies other tool responses        |
| `guardian_ext`                            | Disable  | Extension reviewer                   |
| `guardian_node_repl_transcript_images`    | Disable  | Supplies tool images                 |
| `guardian_reuse_parent_compaction`        | Disable  | Reuses parent context                |
| `in_app_chat`                             | Disable  | Desktop capability                   |
| `in_app_dictation`                        | Disable  | Desktop dictation                    |
| `in_app_local_automation`                 | Disable  | Desktop automation                   |
| `local_thread_store_shared_compression`   | Safe     | Removed compatibility flag           |
| `mcp_oauth_refresh_coordination`          | Disable  | Credential-store coordination        |
| `omit_app_server_notification_media`      | Safe     | Removes notification media           |
| `powershell_shell_version`                | Disable  | Exposes host-shell information       |
| `psp`                                     | Disable  | Changes request routing              |
| `retain_client_developer_messages`        | Safe     | Retains supplied instructions        |
| `send_async_message`                      | Safe     | Removed compatibility flag           |
| `shell_snapshot_v2`                       | Disable  | Captures shell state                 |
| `skip_host_skill_discovery`               | Safe     | Suppresses host snapshots            |
| `sleep_tool`                              | Disable  | Registers another tool               |
| `step_model_switching`                    | Disable  | Changes selected model               |
| `transcript_v2`                           | Safe     | Interactive transcript UI            |
| `unbounded_connection_retries`            | Safe     | Retries existing provider connection |
| `unified_image_budget`                    | Safe     | Existing-image budget                |
| `write_stdin_approval`                    | Safe     | Additional approval guard            |

The same review moves existing `chronicle` from safe to disabled: its screen
memory sidecar is outside supplied-prompt input. The adapter's process timeout
still bounds retries. Disabling parent tools remains separate from preserving
their cancellation and approval safeguards.

An installed-CLI check of the emitted disables still reports `unified_exec=true`:
0.153.4 [normalizes that implementation flag back on](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/config/managed_features.rs#L151).
The authority gate is `shell_tool=false`, which
[prevents registration of command execution and terminal input](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/tools/spec_plan.rs#L1074).
The test explicitly requires that disable. `tool_search_always_defer_mcp_tools`
and `tui_app_server` also remain true because they are removed compatibility
flags; their values do not prove tool availability.

The fake-spawner test crosses real inventory negotiation before accepting a
fake generation. It checks classification, emitted disables, preserved
safeguards, and disjoint lists. Adding `future_host_tool` to the captured
inventory must still fail before generation. Neither the fixture nor the
expected classifications are generated from production lists.
