---
"@knpkv/control-center": minor
---

Add owner-triggered bounded synchronization for CodeCommit, CodePipeline, and Clockify connections, with durable attempt state and canonical Items and Timeline materialization. State reads remain observational, crash-left attempts reconcile when an owner starts the next synchronization, and a full 100-page invocation records successful checkpoint progress for the next run.
