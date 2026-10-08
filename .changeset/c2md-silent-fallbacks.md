---
"@knpkv/confluence-to-markdown": patch
---

Sync no longer hides failures. If Confluence changes cannot be merged into your branch after a pull, a warning names the branch and the `git merge` that finishes it; before, a conflict was dropped without a word. The same goes for a deleted file whose page id cannot be read, so its page is not deleted; a canonical-content amend that fails; a switch back to the original branch that fails; and an unreadable or invalid project `baseUrl`. A config or legacy auth file whose existence cannot be checked now fails with an error instead of reading as missing.
