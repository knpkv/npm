---
"@knpkv/hub-app": minor
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-hub": minor
---

Hub apps without nix, part 1 (schemas). `@knpkv/hub-app` exports `apps.json` v2 (`AppsConfigV2`, `InstalledApp`: the hub starts each app from its install prefix, and the file names its one writer, `cli` or `nix`), the spawn handshake `HubHandshake`, and the `hubApp` package field `HubAppPackageField`. `AppsConfig` reads v1 and v2. App states gain `starting`, `crashloop`, `disabled`, `install_missing` and `health`, and `AppStartError` gains `handshake`. `@knpkv/herdr-fleet`'s `HubPaths` gains `hubData`, `hubState` and `hubRuntime` (`null` on Windows, whose apps use named pipes). Apps run `--attach`: they read the hub's handshake from stdin (at most 5 s, 4 KiB), listen on its endpoint, answer `403 not_hub` to any request without the spawn's `x-hub-app-secret` (compared in constant time, before any `x-hub-*` header is read), call the hub with the handshake's token held in memory, and stop when stdin ends. The previous `Attached` run mode is now `AttachedSocket` (`--socket`), and `serveAttached` takes the handshake from stdin; `serveAttachedSocket` keeps the socket shape for now. `AttachedOptions.tokenFile` became `token`, an effect that yields the current token.
