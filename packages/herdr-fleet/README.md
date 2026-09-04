# `@knpkv/herdr-fleet`

Fleet job protocol and local decision authority for Herdr hosts.

The host that receives a job owns its durable SQLite record and every state transition. Risky work starts as `pending_approval`; approval is bound to the job's canonical hash and one-time nonce. Rejection and expiry clear that nonce. Safe work queues immediately. Recovery resumes queued jobs and expires stale approvals without moving authority to a coordinator.

`JobRecord.hash` persists a lowercase hex SHA-256 digest. Its canonical JSON input contains the host, actor, payload discriminant, and every identity field for that variant: `ref` for `nix.apply`; `repository`, `prompt`, `mode`, and the optional `channel` for `agent.delegate`; `session` and `message` for `agent.message`; no extra field for `nix.check` or `browser.mcp.recover`. Raw credentials and provider secrets never enter this hash or the persisted job payload.

The package exports:

- Schema contracts for configuration, jobs, status, and agent inventory
- `AgentConnectTarget`, the canonical sanitized Connect URL for one exact host and stable agent ID
- `JobStore`, the local SQLite persistence boundary
- `makeFleetService`, the approval and execution state machine
- typed validation, storage, approval, authorization, and operation errors

`HostConfiguration.pushAllowedOrigins` is the explicit exact-origin allowlist used by the approval runtime for browser push delivery. It has no implicit defaults; deployment configuration owns the accepted push services.

`HostConfiguration.machines` stores `{ host, nodeId }` for every fleet machine. Both fields must be unique. Tailscale adapters use the stable node ID as authority and treat the hostname only as a consistency check.

`HostConfiguration.workBindAddress` is the explicit IPv4 address for the local-only Work listener. It defaults to loopback; wildcard addresses are invalid. The Work and local listeners must use distinct ports when `crossHost` is disabled.

`HostConfiguration.lanWork` is an opt-in LAN Work listener configuration with an explicit bind `address`, browser `host`, and TCP `port`. Its port must not collide with the local, Work, or approval listeners. The approvals runtime exposes only the read-only Work pairing boundary on this listener; it prints a five-minute single-use code after startup, accepts pairing only from the exact configured origin, and keeps approvals, Connect, chat, secrets, agent control, and job submission unavailable. LAN Work uses plain HTTP and therefore requires a trusted LAN or an authenticated TLS boundary before credentials cross an untrusted link.

Callers provide `HostOperations`. This keeps Nix, Git, and Herdr command execution out of the protocol package. `run` and `runCoordinatorChat` receive the accepted job ID and actor after the fleet service has enforced submission and approval. They also receive a typed lifecycle callback. Existing synchronous adapters may ignore these trailing arguments. A durable adapter implements `resumeAccepted`, calls `accepted` once with its receipt before returning, then calls `terminal` once after the coordinator persists `settled`, `delivery_failed`, or `task_failed`. Fleet stores the receipt in `acceptedReceipt`, keeps the wrapper job running between those calls, and invokes `resumeAccepted` with fresh callbacks after restart. Acceptance fails before persistence if the adapter omits the resume operation. The job ID and actor remain the idempotency and command-identity inputs.

When an `agent.delegate` worker starts, `JobRecord` persists its exact identity and matching `AgentConnectTarget` in the same transition. Records before start, including pending, rejected, expired, and failed-before-start jobs, contain neither field. Terminal observation time remains separate and appears only after that exact started job succeeds or fails.

`agent.delegate.prompt` and `agent.message.message` are capped at the exported `jobTextMaxLength` (16 KiB). Repository, session, and ref fields have smaller identifier/path bounds. These limits keep every schema-valid payload executable through the host command adapter without crossing the operating system's single-argument limit after JSON escaping and UTF-8 encoding.
