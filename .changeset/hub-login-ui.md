---
"@knpkv/herdr-hub": minor
---

The super-app shows who is logged in:

- a session control with a popover (who, how, until when, Log out);
- the session details in the phone's Hosts dialog;
- a "Continue as …?" card with Log in with Tailscale on Approvals;
- the `herdr-hub login` link exchange, with the code taken out of the address first.

An open page reads its session every minute, which renews a sliding one. Nothing is enforced yet, so no copy claims view-only access or passkeys.
