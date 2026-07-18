---
"@knpkv/control-center": minor
---

Add the first shared graceful-drain lifecycle for the runnable server. Signal
shutdown now rejects new mutations and live streams, closes existing event
streams, waits within a hard deadline for admitted mutations, and then releases
scoped runtime resources.
