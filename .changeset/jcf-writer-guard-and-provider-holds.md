---
"@knpkv/jira-clockify": minor
"@knpkv/jcf-web": patch
---

Serialize every provider write behind one machine writer guard (`WriterGuard`), shared by `jcf watch`, the CLI and the browser, with a typed refusal reason. Hold, rather than recreate, a bound Jira or Clockify entry whose absence the provider cannot prove, and check source and target again after reserving and before the final write. Bind direction-created entries only when the ledger verifies a single target, record Jira's creation time on new bindings (source ledger v4, migrated in place), and render calendar rows by elapsed minutes so DST days line up.
