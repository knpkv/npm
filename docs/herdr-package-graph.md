# Herdr package boundaries

```text
@knpkv/herdr-approvals
├── @knpkv/herdr-tailscale
├── @knpkv/herdr-connect
│   ├── @knpkv/herdr-fleet
│   └── @knpkv/rly
├── @knpkv/herdr-coordinator
│   └── @knpkv/herdr-fleet
├── @knpkv/herdr-work
│   ├── @knpkv/herdr-fleet
│   └── @knpkv/rly
├── @knpkv/herdr-fleet
└── @knpkv/rly
```

`herdr-tailscale` owns one provider boundary: read-only discovery and whois authentication. It has no fleet policy.

`herdr-fleet` owns the shared wire model, durable local job store, and local approval authority. It has no Tailscale, UI, or command implementation dependency.

`herdr-connect` owns the agent directory, activity projection, terminal protocol, terminal child lifecycle, and browser surface. It accepts ordinary peer URLs instead of depending on Tailscale, so the same terminal surface can use another authenticated network boundary. Keeping this together avoids thin packages split by screen while keeping terminal details out of the core job protocol.

`herdr-coordinator` owns chat persistence and the versioned child lifecycle protocol. It depends on fleet jobs because chat is a projection over those durable jobs, not another execution authority.

`herdr-work` owns complete durable goal checkpoints, four historical projections, and the Rly departure board. It imports the fleet-owned exact Connect target contract, but not terminal or approval runtime code. A checkpoint is the only source of historical state. Missing history stays absent.

`herdr-approvals` is the executable composition root and shared Rly shell. HTTP, PWA, push, CLI parsing, and concrete Git, Nix, and Herdr operations need several lower packages at once, so placing them here keeps the graph acyclic. Its three tabs compose Approvals decisions, the Connect terminal and chat, and the Work departure board without moving their models into the shell.

## Deliberately outside npm

- NixOS and Home Manager modules, systemd units, package wrappers, platform paths, and secret material
- Tailscale enrollment, ACL, Serve, Funnel, certificate, and node lifecycle configuration
- Host-specific fleet membership, ports, commands, repositories, and rollout policy
- Chrome DevTools MCP singleton cleanup and service restart; its fixed profile, `/proc`, socket, and systemd assumptions make it a host policy with destructive recovery authority
- `herdr-space-priority`, which is local sidebar policy rather than fleet or terminal infrastructure
- Generated browser bundles in the old Nix tree after cutover; npm builds them from source
