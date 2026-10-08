---
"@knpkv/jcf-web": minor
"@knpkv/jira-clockify": minor
---

The week view says what is missing instead of showing zeros, and a signed-out tab can get back in:

- A tab without a valid session shows one screen naming `jcf web login`, instead of the whole app with zeros, enabled controls and three red panels. A link pasted into that tab signs it in. An expired link in the address bar no longer signs out a tab whose session is still valid.
- `jcf web login` (or `jcf-web login`) asks the running jcf-web for a fresh one-time link, so a second browser or an expired tab no longer needs a restart. jcf-web leaves its address and a control token in `~/.jcf/web.json` (owner-only) while it runs, and removes it on exit.
- A system that is not connected reads "— Not connected. Run jcf auth jira token" (or the Clockify command) in the week totals, never "nothing saved". Its saved layer is hidden, and it is never a write target. With nothing connected, the page shows one panel naming both commands.
- With no session folder chosen, the empty state says so and names the setting, instead of offering a Scan sessions that cannot find anything. The empty-state copy names only the connected systems.
- `pnpm --filter @knpkv/jcf-web start` works in the workspace (it runs the server with `tsx`), and `test:pack` checks it.
