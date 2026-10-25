---
"@knpkv/herdr-hub": minor
---

A failed fleet job in the Needs-you list can be dismissed or tried again. `POST /v1/modules/fleet/failures/dismiss` takes `{ host, jobId }` and hides a failed, interrupted or expired job from the list. `POST /v1/modules/fleet/failures/retry` takes `{ host, jobId, apply: "same" | "main" }` and submits the same request again, or `nix.apply main` for "Apply main instead", to the host that ran it. It submits as the person pressing it, exactly as `POST /v1/jobs` would: from the hub's tailnet page a request that needs an approval asks for one again. Only `nix.check`, `nix.apply`, `agent.delegate` and `agent.message` retry. A second press answers with the first retry's job and submits nothing. A `nix.apply` failure now carries `applyRef`, the ref it applied. Dismissals and retries are kept on the hub in `needs-you.sqlite`.
