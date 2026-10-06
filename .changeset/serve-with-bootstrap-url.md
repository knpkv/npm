---
"@knpkv/browser-pairing": minor
"@knpkv/codecommit-web": minor
"@knpkv/agent-usage": patch
"@knpkv/jcf-web": patch
---

`@knpkv/browser-pairing/owner-session` adds `serveWithBootstrapUrl(server, onReady)`. It runs a server layer, waits until it is listening, hands its bootstrap URL to `onReady`, and keeps serving. A launch that fails before it is listening fails without announcing a URL, and a failing `onReady` stops the server. `agent-usage serve`, `jcf-web` and `codecommit-web` now start their servers through it instead of three copies of that code. `@knpkv/codecommit-web` also exports `serveCodeCommit(options)` (`hostname`, `port`, `onReady`), the start sequence its own entry uses.
