---
"@knpkv/hub-app": minor
"@knpkv/herdr-hub": minor
---

An installed app outside the `@knpkv` scope opens its page only on the hub's loopback listener for now. On every other listener `/v1/apps` lists it as Unavailable with the new reason `local_only` ("<label> opens only on this machine for now."), and its routes answer 503. An app's page runs with the hub page's authority, which on the hub's tailnet listener includes approving jobs, so until apps get their own origin only first-party pages open on every device. First-party is the package name the installer verified, never what the app reports. `herdr-hub apps add` says which applies before it installs.
