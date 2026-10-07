---
"@knpkv/codecommit-web": patch
---

Relay's mount takes its backends as a parameter, so tests can run the real mount on a scripted model. A new crash test proves it: CodeCommit web killed with SIGKILL in the middle of a confirmed comment resumes without posting it twice.
