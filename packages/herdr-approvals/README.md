# `@knpkv/herdr-approvals`

Host runtime, fleet CLI, approval PWA, push worker, and shared Rly shell for the Herdr packages.

It publishes two binaries:

- `hostd`: local fleet authority plus optional Tailscale listeners, approvals, Connect, chat, and push
- `fleetctl`: status, history, job submission/following, Work checkpoint recording/snapshots, and fleet-wide apply submission with per-host outcomes

`hostd` reads `FLEET_CONFIG_PATH`, defaulting to `~/.config/fleet/config.json`. The file is decoded by `@knpkv/herdr-fleet`; invalid or missing fields fail startup. With `crossHost: false`, only the loopback listener and immediately queued safe jobs are available, with no Tailscale dependency. Cross-host listeners authenticate the actual socket peer with Tailscale WhoIs. Forwarded identity headers are never trusted.

On the approval hub, `approvalTls` names absolute certificate and private-key paths owned by the hostd user. The hub terminates TLS directly on its configured Tailscale IP and `approvalPort`; certificate provisioning and renewal remain host policy. Non-hub tailnet members keep their plain tailnet listeners. Local-only machines do not read TLS material or invoke Tailscale.

Fleet-wide submission preserves partial results. One unreachable host does not erase successful submissions to other hosts, but the command exits with a typed failure after printing all outcomes. The runtime performs no Tailscale mutation; Nix remains responsible for certificates, ACLs, node enrollment, secrets, and service lifecycle.

Approval mutations require the exact active listener origin, including HTML form submissions. Originless fleet submission remains a separate authenticated CLI path. Existing browser push subscriptions are reconciled with the server on page load, so server-side expiry or revocation cannot leave a false enabled state.

`pushAllowedOrigins` is the exact HTTPS-origin allowlist for browser push services. Subscription endpoints are checked before persistence and again before delivery; credentials, IP literals, localhost, and origins outside that list are rejected. Add self-hosted push services explicitly by their public origin.

The approval hub renders one masthead and three tabs. Approvals contains only local decisions and remote approval handoffs. Connect embeds the package terminal and authoritative relationship tree, with coordinator chat below it. Work renders the durable `@knpkv/herdr-work` projection. The built PWA assets keep offline installation, push subscription management, notification click routing, and the same authenticated browser routes.

`fleetctl work record HOST CHECKPOINT_JSON` decodes one `WorkGoalCheckpoint` locally, then posts it to the target host's fixed `POST /v1/work/checkpoints` endpoint. With `crossHost: false`, Work uses a Work-only listener on the configured LAN port; its only routes are the schema-decoded `GET /v1/work` snapshot and originless typed checkpoint POST. With `crossHost: true`, Work commands target only the canonical approval hub, which serves the read-only snapshot and typed checkpoint route through its authenticated tailnet/TLS surface. Checkpoint writes reject browser-origin requests and accept no job, command, file, or partial-goal shape. A checkpoint containing an approval target requires cross-host approval to be enabled, the host to be configured, and the approval page to resolve through the configured hub or an online Tailscale peer; its URL origin must exactly match that resolved page before persistence. Disabled cross-host approval, unknown or offline hosts, Tailscale failures, malformed approval pages, and origin mismatches return typed validation or operation failures without recording a new checkpoint. An exact persisted replay remains idempotent when its approval page is temporarily unavailable; changed content with the same event ID or goal timestamp returns `WorkCheckpointConflictError`.
