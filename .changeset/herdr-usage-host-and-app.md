---
"@knpkv/herdr-usage": minor
"@knpkv/hub-app": minor
"@knpkv/herdr-hub": minor
"@knpkv/herdr-connect": minor
---

Add `@knpkv/herdr-usage`: `./host` holds this machine's agent-usage readings (moved from herdr-hub, which now
imports them), `./views` and `./views.css` hold the Usage Limits views and styles (also moved from herdr-hub, whose
Usage page now renders them from here), `./selection` the page's selectors, and the package root holds the Usage
app's server, whose limits and usage reads come from the
hub's fleet reads when attached and from this machine when standalone. The hub now answers `fleet.read` for apps.
`ShellContext` gains `headerOutlet` and `setHeaderMode` for apps that group their own header content with the
shell's. Grants minted for a GET can no longer post to Relay as the caller, a redirect to the app's own root
stays under its `/apps/<id>/` prefix, and a burst of failed requests to one app runs a single re-probe.
`@knpkv/herdr-connect/usage` now exports the `FleetLimits` and `FleetUsage` schemas as values, so a browser client
decodes them without the package root. The Usage page (`UsagePage`) moved to `@knpkv/herdr-usage/views` behind a
small `UsageShell`; the hub's Usage module renders it unchanged, and the app's own client and `herdr-usage`
executable render the same page standalone or attached.
