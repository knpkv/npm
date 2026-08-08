# Isolate agent review in an ephemeral writable sandbox

An Exploratory Review Run receives a writable project checkout inside an ephemeral sbx microVM created by a trusted local `sbx` executable and optional template. A Review Checkout Broker fetches and verifies the exact base and head commits with the connected CodeCommit profile; `sbx create shell --clone` copies that exact checkout into the isolated sandbox filesystem. Before tools are exposed, Control Center denies all sandbox network access, removes Git remotes and credential helpers, and verifies the full head object ID again. A pull request cannot alter the executable or template evaluating it; the Local Operator configures runner changes, budget defaults, Review Agent Profiles, and network policy outside the reviewed checkout. Within that fixed boundary the agent runs commands autonomously without per-command approval; its activity is observable and the run is cancellable. Host credentials are never injected, and changes created in the sandbox are discarded rather than propagated automatically. A Full review has a visible 20-minute default budget and returns Unable to Conclude when responsible completion is impossible. Control Center does not impose an arbitrary suggestion-count cap. On process restart, Control Center removes stale sandboxes whose names begin with `cc-pr-review-`; every normal, failed, cancelled, or timed-out scoped run removes its sandbox. This gives the review agent full project-level capability while keeping durable output limited to validated structured suggestions and bounded live activity.

## Amendment: workspace-scoped startup reconciliation

The original process-wide `cc-pr-review-` cleanup rule assumed one Control
Center workspace owned the sbx runtime. A shared runtime makes that attribution
unsafe. Current sandbox names therefore use the server-private
`cc-pr-review-<compact-workspace-id>-` namespace and a bounded job/attempt
suffix so the complete name stays within sbx's 63-character limit. Startup
removes only leftovers owned by the configured PR worker workspace.
Foreign-workspace and legacy unscoped names remain untouched because ownership
cannot be established. This amendment supersedes the global cleanup sentence
above; the scoped per-run cleanup and isolation decision are unchanged.

## Amendment: restart recovery evidence

Startup now retains live, workspace-scoped sandbox names for recovery inspection. If no owned live
sandbox remains, an active review is durably recorded as interrupted with an Unable to Conclude
report before the worker admits later work. Provider session state is never reconstructed; a retry
is a new immutable job and attempt. Per-run cleanup remains responsible for normal terminal runs.
