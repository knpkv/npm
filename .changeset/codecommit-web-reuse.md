---
"@knpkv/codecommit-web": minor
"@knpkv/codecommit": minor
---

A running server hands out fresh sign-in links to its owner. `codecommit web` reuses it: it opens a fresh sign-in link instead of starting a second server, and `codecommit web login` prints one. When the port is taken and nothing answers through the control file, `codecommit web` says so and exits instead of moving to the next port. If the server cannot write its control file it warns at startup and keeps running.
