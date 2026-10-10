---
"@knpkv/herdr-work": minor
"@knpkv/herdr-approvals": minor
"@knpkv/herdr-connect": patch
---

A large Work board never hides goals silently. The Work tab says "N older goals not shown" for a window the board cut, and `fleetctl work snapshot` prints the same per window on stderr, keeping stdout the snapshot alone. Snapshots now carry `version: 1`. Readers accept any version and ignore keys they don't know; when a newer format no longer decodes, fleetctl says "upgrade fleetctl with the hub" and the hub page says "reload the page" instead of reporting a malformed snapshot. A fleetctl from before this release still decodes strictly and fails against a hub that cut its board, so upgrade fleetctl with the hub; hosts updated together through nix are unaffected.
