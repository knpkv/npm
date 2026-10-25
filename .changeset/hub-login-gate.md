---
"@knpkv/herdr-hub": minor
"@knpkv/herdr-fleet": minor
---

Put the hub behind login.

- herdr-fleet `can()`: a person or the local user without a browser session holds nothing; the CLI token holds `view`, `jobs.submit` and `apps.restart`.
- herdr-hub: the tailnet hub and loopback listeners decide every request by who the caller is. A browser without a session gets the page 22 login gate and `401 login_required`, a browser on a fleet host included; agents and hosts keep their own credentials (the CLI token on loopback, the host's node on the tailnet); a session's writes need its CSRF token, which the super-app's browser clients now send with every write to the hub; an app's writes need the hub's own `Origin` instead, and are refused without one; a route no family names gets 404; the browser terminal passes the same gate. The CLI token may try again any failed job from Needs you.
- The loopback session moves to an HttpOnly `herdr_local_session` cookie; the page keeps no token of its own.
- `GET /v1/session` says whether a session ended and whether the caller is on a fleet machine. Session cookies last 8 days, past every session's end, so an ended session is reported as ended.
- `fleetctl` and `herdr-hub apps` send the CLI token on loopback.
