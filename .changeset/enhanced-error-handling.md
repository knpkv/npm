---
"@knpkv/effect-ai-claude-agent-sdk": minor
---

Enhanced error handling with detailed context

- Add exitCode, stderr, errorSubtype, errors fields to SdkError
- Add errorSubtype, errors fields to StreamError
- Add cause field to PermissionError
- Extract exit codes from process error messages (multiple patterns)
- Preserve error stack traces instead of String(error)
- Format SDK error subtypes in result messages
- Add comprehensive edge case testing (86 tests total)
- Document stderr as unimplemented (reserved for future)
- Document regex parsing as best-effort

Fixes unclear error messages when SDK errors occur. Now exposes:

- Process exit codes (extracted from error messages)
- SDK error subtypes (error_during_execution, etc.)
- Structured error arrays
- Full stack traces
