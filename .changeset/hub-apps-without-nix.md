---
"@knpkv/hub-app": minor
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-hub": minor
---

Hub apps without nix, part 1 (schemas). `@knpkv/hub-app` exports `apps.json` v2 (`AppsConfigV2`, `InstalledApp`: the hub starts each app from its install prefix, and the file names its one writer, `cli` or `nix`), the spawn handshake `HubHandshake`, and the `hubApp` package field `HubAppPackageField`. `AppsConfig` reads v1 and v2. App states gain `starting`, `crashloop`, `disabled`, `install_missing` and `health`, and `AppStartError` gains `handshake`. `@knpkv/herdr-fleet`'s `HubPaths` gains `hubData`, `hubState` and `hubRuntime` (`null` on Windows, whose apps use named pipes).
