---
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-hub": minor
"@knpkv/herdr-connect": minor
---

Tell a computer without Herdr from one whose Herdr isn't running, and tidy the standalone hub.

- Breaking type change in `@knpkv/herdr-fleet`: `HostDetails` and `HostStatus` carry one `repository` object (`{ path, branch, revision, dirty }`, or `null` on a standalone computer) that replaces the separate `branch`, `revision` and `dirty` fields.
- `AgentInventory` gains an optional `unavailableReason` (`herdr_not_installed` or `herdr_not_running`), and Connect's peer failure reasons gain the same two values. hostd reports a missing Herdr command as not installed and a list command that fails as not running.
- Connect on a standalone computer shows "Herdr isn't installed" or "Herdr isn't running" (with Retry) instead of "localhost didn't answer", and its empty state names this computer.
- `FleetService` refuses jobs a host has not set up at run time too, whatever composed its operations.
- A configuration file that a case-insensitive volume lists under another case is read, not replaced by standalone defaults.
