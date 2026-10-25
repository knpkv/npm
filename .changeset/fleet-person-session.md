---
"@knpkv/herdr-fleet": minor
---

`Person` principals carry `session`. Without a browser session a person only views. A person logged in on a fleet machine never holds `sandboxes.owner`. A new `Cli` principal, a command holding the hub's CLI token, holds only `apps.restart`.
