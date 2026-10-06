---
"@knpkv/rly": minor
---

Add optional `provenance` to `TimelineRow` events. The marker takes a shape (○ applied automatically, ● approved, ◆ waiting for approval, a hatched square for couldn't read, ▲ flag only) and the label says it in words. A new `TimelineProvenanceKey` keys the shapes. The shapes stay distinct in forced colours.
