---
"@knpkv/herdr-usage": minor
"@knpkv/hub-app": minor
"@knpkv/herdr-hub": minor
---

Add `@knpkv/herdr-usage`: `./host` holds this machine's agent-usage readings (moved from herdr-hub, which now
imports them), and the package root holds the Usage app's server, whose limits and usage reads come from the
hub's fleet reads when attached and from this machine when standalone. The hub now answers `fleet.read` for apps.
`ShellContext` gains `headerOutlet` and `setHeaderMode` for apps that group their own header content with the
shell's. Grants minted for a GET can no longer post to Relay as the caller, a redirect to the app's own root
stays under its `/apps/<id>/` prefix, and a burst of failed requests to one app runs a single re-probe.
