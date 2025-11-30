---
"@knpkv/effect-ai-claude-code-cli": minor
---

Add session resume functionality

- Add SessionId branded type with UUID validation
- Add SessionNotFoundError and InvalidSessionIdError
- Create SessionDiscovery module for listing sessions from ~/.claude/
- Implement resumeQuery() and resumeQueryStream() methods
- Add --resume flag support to CLI integration
- Fix encodeProjectPath() to handle leading / and . characters
- Add session-resume.ts example
- Add comprehensive integration test
