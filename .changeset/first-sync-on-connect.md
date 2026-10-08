---
"@knpkv/control-center": minor
---

Connecting a resource now syncs it. Before, nothing synced until someone found **Sync now** behind a resource's collapsed controls, so a first run showed "Healthy" next to empty Items.

- Connecting a resource whose connection test passes starts its first sync. Opening Services never starts one.
- Until it first syncs, a resource reads "Not synced yet", "Syncing…" or "Sync failed", never "Healthy". Inside an account it opens so **Sync now** is visible.
- A failed sync says why, as a sentence with its fix. `PluginSynchronizationState` gains `failure` (failure class and safe message, from the failure recorded on the connection's health); an absent field decodes as null, and code that builds the type sets `failure` (null when the sync didn't fail).
- Credential failures are stated once on the account card, with **Check again**, not on each resource.
- Sync copy uses "sync": "Synced 2 min ago, 19:33" replaces ISO timestamps.
