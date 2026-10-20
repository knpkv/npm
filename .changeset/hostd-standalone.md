---
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-hub": minor
---

hostd starts without a fleet configuration. When no file exists at the configuration path, it runs as a standalone local hub: fleet off, the super-app on `http://127.0.0.1:4778/`, the work listener on 127.0.0.1:4777, no tailnet, TLS or push. State lives in `$XDG_STATE_HOME/fleet`, else `$HOME/.local/state/fleet`, and the host is named from `HOSTNAME`. It prints one stderr line naming the path it looked for. An existing file that is unreadable, malformed or invalid still stops startup. `@knpkv/herdr-fleet` adds `standaloneDefaults`, `loadConfigurationOrStandalone`, `standaloneRefusedKinds` and `HostOperations.notSetUp`; a standalone computer refuses `nix.check`, `nix.apply` and `agent.delegate` before a job exists ("nix jobs are not set up on this computer", "agent delegation is not set up on this computer").
