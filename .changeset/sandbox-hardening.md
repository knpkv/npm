---
"@knpkv/sandbox-pool": patch
"@knpkv/herdr-hub": minor
---

An expected aws-nuke listing failure is judged only by its own top-level fields: a line that names `owner`, `resource_type` or `error` twice, or only inside unquoted brackets, still counts as an incomplete scan. hostd logs at start when it runs a sandbox pool but `RELAY_SANDBOXES_HOST` doesn't name its host, so the hub would serve no Sandboxes pages (`sandboxesHostWarning`).
