---
"@knpkv/herdr-hub": patch
---

`herdr-hub apps` prints a failure you can act on as one sentence and exits 1, with no stack trace. Examples are a hub that isn't running, an app that isn't installed, a busy lock, or nix owning `apps.json`. The restart route answers 404 to a malformed `%` escape in the app id instead of failing the request.
