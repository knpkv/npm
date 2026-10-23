---
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-hub": minor
"@knpkv/relay": patch
---

hostd starts on Windows. Paths come from one `HubPaths` table shared by herdr-fleet and herdr-hub: the home directory is `os.homedir()` instead of `HOME`, the host name is `os.hostname()` instead of `HOSTNAME`, and Windows keeps fleet configuration under `%APPDATA%` and state under `%LOCALAPPDATA%`. Linux and macOS paths are unchanged. `HERDR_HUB_HOME` and `HERDR_HUB_CONFIG` override them on any OS. The job store's path-identity check now accepts a Windows real path that differs only in drive-letter case or separators. On Windows, hostd runs npm `.cmd` shims as Node with their script, never through a shell. `makeHostdProgram` takes an optional `paths` table.

The Relay store notes that on Windows owner-only comes from the user profile's ACL.
