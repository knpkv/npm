---
"@knpkv/ai-claude": minor
---

Add an optional reasoning effort override to the Claude model adapter. Omitting it preserves the CLI-configured default.

Add optional bounded, cancellable visible activity callbacks. `onActivity` enables CLI partial-message output and reports the supplied request prompt, process milestones, visible assistant text, `StructuredOutput` JSON fragments and the final response, including for `generateObject`. System events, reasoning and other tool inputs are excluded; request events carry caller-supplied prompt content and stay within that prompt's authorization boundary. The stdout byte limit covers every event and the final result still passes schema validation. Without the callback, output remains buffered.
