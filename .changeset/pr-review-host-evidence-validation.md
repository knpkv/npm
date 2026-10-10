---
"@knpkv/control-center": minor
---

PR-review evidence validation now reads the exact base and head from the host's own source checkout instead of the agent-writable sandbox copy. Refs, replacement refs, or object files rewritten inside the sandbox can no longer change what validation sees. The host reads run `git` as argv without a shell, with replacement objects disabled and no global or system configuration. Sandbox commands now run in a non-login shell. Review sandbox sessions expose these reads as `revisions`, and the sessions layer now requires `FileSystem` and `Path`.
