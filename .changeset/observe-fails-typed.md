---
"@knpkv/codecommit-core": patch
---

`PullRequestRepo.observe()` fails with a `CacheError` (cause `ObservationSequenceMissing`) when the observation sequence row is missing, instead of returning 0 for every read. That fallback would have silently stopped ordering reads of the same revision. Callers already skip a read whose observation fails.
