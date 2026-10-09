---
"@knpkv/codecommit-core": minor
---

Relay capabilities for CodeCommit: read a pull request (with its approval as the queue shows it: Approved, NotRequired, Pending or Unknown), list the queue, and post a confirmed comment pinned to the current revision. A comment the person's permission settings refuse, or a permission prompt nobody answers, fails as `CommentNotPermitted`, which tells the model not to retry.
