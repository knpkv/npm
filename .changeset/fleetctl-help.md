---
"@knpkv/herdr-approvals": patch
"@knpkv/herdr-fleet": patch
---

`fleetctl --help`, `fleetctl help` and `fleetctl work --help` now print plain usage and exit 0, even on a machine without a fleet configuration. A mistake now gets one line naming its cause, and a non-zero exit. That covers an unknown command, missing arguments, an unknown host (the line lists the known hosts) and an unknown job kind (it lists the kinds). Usage mistakes print the usage that applies after that line, with no `FleetValidationError:` prefix. A missing configuration file is reported as `no fleet configuration at PATH; create it, or set FLEET_CONFIG_PATH to an existing file` instead of a platform error.
