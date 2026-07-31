---
"@knpkv/control-center": minor
---

Persist bounded Review Sandbox command output as immutable, expiring artifacts
with exact review-attempt ownership and scoped page/search access. Retention now
removes expired raw artifacts through attributed cleanup claims without
cascading into semantic review history. Sensitive sandbox, tool, artifact, and
report construction boundaries suppress generic span-value capture so raw
review content remains outside telemetry.
