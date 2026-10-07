---
"@knpkv/herdr-monitor": minor
---

`herdr-monitor init` writes the publish and view keys to a private env file. Every CLI failure names the input to fix instead of one generic message: `publisher` fails with `InvalidOrigin`, `InvalidPublishToken`, `InvalidSnapshot`, `SnapshotTooLarge`, `MonitorUnreachable`, `PublishTimedOut` or `PublishRejected` (now with `origin`) instead of `PublishFailed`, and `MonitorConfigurationError` carries the failing `setting`. Commands have descriptions. On the board, cards end at their last fact, identifiers wrap only between words, and going offline no longer moves the board.
