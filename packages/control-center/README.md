# `@knpkv/control-center`

Control Center is a local, human- and agent-oriented delivery application. It connects release work across CodeCommit, CodePipeline, Jira, Confluence, and Clockify without allowing vendor models or server capabilities to leak into the browser.

This package is under active development. Its first public release will be `0.1.0`.

## Development

Node.js 24 or newer and the repository-pinned pnpm version are required.

```sh
pnpm --filter @knpkv/control-center dev
pnpm --filter @knpkv/control-center check
pnpm --filter @knpkv/control-center test
pnpm --filter @knpkv/control-center test:e2e
```

Development binds to `127.0.0.1:5173` by default. Secure LAN startup and pairing will be added with the authenticated server slice; the scaffold does not expose itself to the network.

## Public entries

- `@knpkv/control-center` — browser-safe API and domain contracts
- `@knpkv/control-center/api` — shared typed API contracts
- `@knpkv/control-center/domain` — Schema-backed vendor-neutral domain contracts, including canonical IDs, people and agent roles, source freshness, and deterministic release identity
- `@knpkv/control-center/server` — server composition

The browser application is intentionally private. It consumes `@knpkv/rly`, while the root, API, domain, and server boundaries are mechanically prevented from importing the design system. Server composition is available only from the explicit `/server` entry. Production code is also forbidden from importing the approved prototype at runtime.

Release Relay projections are domain data, not presentation state. Each release persists its `relay/v1` codename and three-symbol projection; readers validate that projection against the canonical release ID so a future relay algorithm can be introduced without silently changing existing release identity.
