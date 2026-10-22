---
"@knpkv/hub-app": minor
"@knpkv/herdr-hub": minor
---

Add `@knpkv/hub-app`: the contract and runner for apps that run standalone on their own port and mount in the
hub. An app is its own process: `runApp` serves it on loopback with an owner login, or on a unix socket the hub
proxies to. The hub reads installed apps from `~/.config/herdr/apps.json` (re-read when it changes and every 30
seconds), probes each app's manifest, keeps the last good one, and lists every app's state at `GET /v1/apps`. It
proxies `/apps/<id>/*` with the caller and a single-use grant, and serves app-to-hub services under
`/v1/app-services/*` with a per-app token. An app that is down, incompatible or misdeclared is marked
unavailable and never stops the hub. The module contract and route helpers moved to `@knpkv/hub-app`;
`@knpkv/herdr-hub/modules` and `/modules/server` re-export them for one release.
