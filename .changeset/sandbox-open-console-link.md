---
"@knpkv/herdr-hub": minor
---

Open console on a Sandboxes card is now a real link to the access portal (new tab, `noopener noreferrer`), so the browser opens it as a link; a refused console stays a disabled button. In observe mode the Sandboxes module refuses every job as 409 `observe_mode` before Fleet, and the page says the pool is in observe mode instead of a generic refusal. `HttpServerOptions.sandboxPoolMode` carries the mode; hostd sets it.
