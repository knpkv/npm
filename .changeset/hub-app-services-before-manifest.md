---
"@knpkv/herdr-hub": minor
"@knpkv/hub-app": patch
---

`makeHostdProgram` now requires `node`, the Node binary installed apps run on. An embedding that left it out ran no apps, and said so only in each app's own log; it now fails to typecheck. herdr-hub's own `hostd` already passes `process.execPath`. A hub started without a Node path also logs one warning when `apps.json` lists apps it can't start, naming them and what to pass.

App services (`/v1/app-services/*`) answer `503 unavailable`, not `403 undeclared`, until the hub has read the calling app's manifest. An app calling a service while it is still starting is told the hub isn't ready, not that it never declared the service. hub-app's docs now say: call shell services from route handlers, never while building the handler layer.
