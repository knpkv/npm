# `@knpkv/herdr-tailscale`

Read-only Tailscale adapter for Herdr fleet discovery and caller authentication.

The Effect service runs only these commands:

- `tailscale status --json`
- `tailscale whois --json <address>`
- `tailscale ip -4`

Each command has a ten-second timeout. JSON is decoded with Schema before it reaches callers. Command, decode, and authorization failures remain distinct typed errors. This package never changes Tailscale state.

`discoverFleetPeers` resolves every configured machine by its stable Tailscale node ID, then verifies the advertised hostname. Missing, duplicate, or hostname-mismatched identities fail closed; mutable hostname matches are never an authorization path. Offline machines remain present when their stable identity is still reported. `authorizeWhois` requires an allowed login and, when supplied, an allowed stable node ID.
