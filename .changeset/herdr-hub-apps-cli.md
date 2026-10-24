---
"@knpkv/herdr-hub": minor
---

New `herdr-hub apps` command installs, updates, rolls back and removes hub apps with the npm that ships with Node. It writes the `apps.json` the hub supervises, under one lock, and refuses when nix manages the file.

- `add` checks the package's `hubApp` field and the trust allowlist (`@knpkv` by default) before downloading. It shows maintainers, provenance, install scripts and hub access, and asks y/N (`--yes` skips the question). It installs into a staging directory, requires the tarball npm described, checks registry signatures where the registry signs, and runs the app once before it is listed.
- `update` stays within the same major unless given a version and never goes down by itself. It keeps one previous version for `rollback`. With `--wait`, the default, it reports an update that keeps crashing.
- `--allow-scripts` lists every package with install scripts before asking, runs nothing it didn't show, and is asked again on every update.
- `remove`, `enable`, `disable`, `list`, `logs [--follow]` and `trust list|add|remove` (`add` needs a terminal).
- `restart` asks the running hub over its loopback listener with a token the hub writes, owner-only, at every start.
